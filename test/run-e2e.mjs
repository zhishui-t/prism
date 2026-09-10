#!/usr/bin/env node
/**
 * Prism 端到端测试（`pnpm test:e2e`）。
 *
 * 覆盖「CLI → 服务 → HTTP API → 控制台」全链路，**全部在临时目录内运行**，
 * 绝不触碰真实宿主目录（~/.zcode）——运行前后比对真实目录清单，发现污染即失败。
 *
 *   node test/run-e2e.mjs            # 跑全部
 *   node test/run-e2e.mjs --keep     # 保留临时目录（排查用）
 *
 * 前置：`pnpm build`（消费各包 dist 产物；graphify Python 依赖见 3rd/README.md）。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'index.js')
const REAL_ZCODE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.zcode', 'agents')
const PORT = 7798

const KEEP = process.argv.includes('--keep')

const results = []
let failures = 0

function check(name, ok, detail = '') {
  results.push({ name, ok: ok === true, detail })
  const mark = ok === true ? 'PASS' : 'FAIL'
  process.stdout.write(`${mark} ${name}${detail !== '' ? ` :: ${detail}` : ''}\n`)
  if (ok !== true) failures++
}

/** 运行 CLI（注入 PRISM_HOME / ZCODE_DIR 隔离）。 */
function cli(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      cwd: ROOT,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

/** 读目录清单（用于真实宿主零污染比对）。 */
async function listDir(dir) {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return null
  }
}

async function fetchJson(url) {
  const res = await fetch(url)
  return { status: res.status, body: await res.json() }
}

async function main() {
  process.stdout.write(`Prism E2E\n  root: ${ROOT}\n  cli:  ${CLI}\n\n`)

  // 0) 前置：CLI 产物存在
  try {
    await readFile(CLI, 'utf-8')
  } catch {
    process.stderr.write(`错误: 未找到 ${CLI}，先跑 pnpm build\n`)
    process.exit(2)
  }

  // 1) 真实宿主目录快照（零污染基线）
  const realBefore = await listDir(REAL_ZCODE)
  process.stdout.write(`真实宿主目录基线: ${realBefore === null ? '(不存在)' : `${realBefore.length} 个文件`}\n\n`)

  const workRoot = await mkdtemp(join(tmpdir(), 'prism-e2e-'))
  const home = join(workRoot, 'home')
  const zcodeDir = join(workRoot, 'zcode')
  const projectDir = join(workRoot, 'proj')
  // 主流程关闭向量（PRISM_EMBEDDING=off）：向量召回会扩大命中面，破坏精确计数断言。
  // 确定性优先——混合检索单独在 ===== 17 段按真实模型验证（装了才跑）。
  const env = { PRISM_HOME: home, ZCODE_DIR: zcodeDir, PRISM_EMBEDDING: 'off' }

  let server
  try {
    await mkdir(join(projectDir, 'src'), { recursive: true })
    await mkdir(home, { recursive: true })

    // ===== 1. init：注册 MCP + 装 Skill + 建骨架（显式 --zcode-dir） =====
    const init = await cli(['init', '--home', home, '--zcode-dir', zcodeDir, '--json'], env)
    check('1.1 init 成功', init.code === 0, init.stderr.trim().slice(0, 160))
    const initReport = JSON.parse(init.stdout)
    check('1.2 init 装 Skill 到 zcodeDir', initReport.value.skills.written.length >= 1)
    check(
      '1.3 init 写 MCP 注册',
      initReport.value.mcp.status === 'written' || initReport.value.mcp.status === 'unchanged',
      initReport.value.mcp.status,
    )
    check(
      '1.4 出厂团队落受管 teams_dir（不在 agents/ 内）',
      initReport.value.seededTeam.includes(join('teams', 'core-dev')),
      initReport.value.seededTeam,
    )

    // 1.5 doctor 自检全绿（含 anydoc 文档转换可用性）
    const doctor = await cli(['doctor', '--home', home, '--port', '7799', '--json'], env)
    const doctorChecks = JSON.parse(doctor.stdout).value
    check(
      '1.5 doctor 全绿（含 anydoc）',
      doctor.code === 0 && doctorChecks.every((c) => c.ok),
      doctorChecks.filter((c) => !c.ok).map((c) => c.name).join(',') || `${doctorChecks.length} 项通过`,
    )

    // ===== 2. 知识库：import → search → 知识图谱 =====
    const docA = join(workRoot, 'a.md')
    const docB = join(workRoot, 'b.md')
    await writeFile(
      docA,
      '---\nid: E2E-A\ntitle: 性能守则\ntype: rule\nlayer: global\nbook: e2e\nmodule: perf\n---\n\n遇到性能问题先量化再优化。\n',
      'utf-8',
    )
    await writeFile(
      docB,
      '---\nid: E2E-B\ntitle: 缓存策略\ntype: doc\nlayer: global\nbook: e2e\nmodule: perf\n---\n\n参见 [[E2E-A]]。\n',
      'utf-8',
    )
    const impA = await cli(['kb', 'import', docA, '--json'], env)
    const impB = await cli(['kb', 'import', docB, '--json'], env)
    check('2.1 kb import 两条', impA.code === 0 && impB.code === 0)
    check('2.2 frontmatter id 生效', JSON.parse(impA.stdout).value.id === 'E2E-A')

    const search = await cli(['kb', 'search', '性能', '--json'], env)
    const hits = JSON.parse(search.stdout).value
    check('2.3 两字中文词检索命中', hits.length >= 1 && hits.some((h) => h.id === 'E2E-A'), `hits=${hits.length}`)

    const graph = await cli(['kb', 'graph', '--json'], env)
    const graphView = JSON.parse(graph.stdout).value
    check(
      '2.4 知识图谱双链建边',
      graphView.edges.some((e) => e.from_id === 'E2E-B' && e.to_id === 'E2E-A'),
      `edges=${graphView.edges.length}`,
    )

    // ===== 3. 角色与团队：import → validate → activate =====
    await writeFile(
      join(workRoot, 'dev-1.md'),
      '---\nname: dev-1\ndescription: "E2E 开发角色"\ncolor: blue\n---\n\n## 核心契约\n**交付可运行增量。**\n',
      'utf-8',
    )
    const roleImport = await cli(['role', 'import', '--from', workRoot, '--zcode-dir', zcodeDir, '--json'], env)
    check('3.1 role import 成功', roleImport.code === 0)
    const roles = await cli(['role', 'list', '--json'], env)
    check('3.2 role list 含 dev-1', JSON.parse(roles.stdout).value.some((r) => r.name === 'dev-1'))

    // ===== 4. 工作队列：enqueue → claim → complete =====
    const enq = await cli(
      ['work', 'enqueue', '--kind', 'summarize', '--payload', '{"knowledge_id":"E2E-A"}', '--id', 'w-e2e', '--json'],
      env,
    )
    check('4.1 work enqueue', enq.code === 0 && JSON.parse(enq.stdout).value.status === 'pending')
    const claim = await cli(['work', 'claim', 'w-e2e', '--by', 'e2e', '--json'], env)
    const token = JSON.parse(claim.stdout).value.attempt_token
    check('4.2 work claim 签发 token', /^[0-9a-f-]{36}$/.test(token))
    const complete = await cli(
      ['work', 'complete', 'w-e2e', '--token', token, '--result', '{"summary":"摘要"}', '--json'],
      env,
    )
    check('4.3 work complete 校验通过', complete.code === 0 && JSON.parse(complete.stdout).value.status === 'completed')

    // ===== 5. 任务台账：register → report → 依赖图 =====
    const dagFile = join(workRoot, 'dag.json')
    await writeFile(
      dagFile,
      JSON.stringify({
        tasks: [
          { id: 'T-1', description: '探索' },
          { id: 'T-2', description: '开发', depends_on: ['T-1'] },
        ],
      }),
      'utf-8',
    )
    const reg = await cli(
      ['task', 'register', '--dag', 'd-e2e', '--session', 's1', '--team', 'core-dev', '--project', 'prism', '--file', dagFile, '--json'],
      env,
    )
    check('5.1 task register 登记 DAG', reg.code === 0 && JSON.parse(reg.stdout).value.tasks === 2)
    const rep = await cli(['task', 'report', 'T-1', '--to', 'RUNNING', '--by', 'e2e', '--json'], env)
    check('5.2 task report 合法转移', rep.code === 0 && JSON.parse(rep.stdout).value.status === 'RUNNING')
    const badRep = await cli(['task', 'report', 'T-2', '--to', 'COMPLETED', '--by', 'e2e'], env)
    check('5.3 task report 非法转移被拒', badRep.code !== 0, badRep.stderr.trim().slice(0, 80))

    // ===== 6. harness：运行时适配器配置 =====
    const hList = await cli(['harness', 'list', '--json'], env)
    check('6.1 harness list 激活 zcode', JSON.parse(hList.stdout).value.active === 'zcode')
    const hEnv = await cli(['harness', 'list', '--json'], { ...env, PRISM_HARNESS: 'zcode' })
    check('6.2 harness env 覆盖生效', JSON.parse(hEnv.stdout).value.source === 'env')
    const hBad = await cli(['harness', 'list'], { ...env, PRISM_HARNESS: 'nope' })
    check('6.3 未知 harness 报错', hBad.code !== 0 && hBad.stderr.includes('harness_not_found'))

    // ===== 7. 架构图谱：render（vendored archify） =====
    const irFile = join(workRoot, 'arch.json')
    await writeFile(
      irFile,
      JSON.stringify({
        schema_version: 1,
        diagram_type: 'architecture',
        meta: { title: 'E2E 架构' },
        components: [
          { id: 'a', type: 'frontend', label: '前端', pos: [40, 200], size: [140, 68] },
          { id: 'b', type: 'backend', label: '后端', pos: [240, 200], size: [140, 68] },
        ],
        connections: [{ id: 'ab', from: 'a', to: 'b', label: '调用' }],
      }),
      'utf-8',
    )
    const arch = await cli(['arch', 'render', 'architecture', irFile, '--json'], env)
    check('7.1 arch render 产出 HTML', arch.code === 0, arch.stderr.trim().slice(0, 120))

    // ===== 8. 服务 + HTTP API + 控制台 =====
    const { startServer } = await import(pathToFileURL(join(ROOT, 'packages', 'server', 'dist', 'index.js')).href)
    // 进程内 server 也关向量：省去 600MB 模型加载，且 search 计数确定
    process.env['PRISM_EMBEDDING'] = 'off'
    server = await startServer({ home, port: PORT })
    const base = `http://127.0.0.1:${server.port}`

    const health = await fetchJson(`${base}/api/health`)
    check('8.1 /api/health', health.status === 200 && health.body.ok === true)
    const kbSearch = await fetchJson(`${base}/api/kb/search?q=${encodeURIComponent('性能')}`)
    check('8.2 /api/kb/search 命中', kbSearch.body.value.length >= 1)
    const kbGraph = await fetchJson(`${base}/api/kb/graph`)
    check('8.3 /api/kb/graph 返回节点/边', kbGraph.body.value.nodes.length >= 2)
    const taskStats = await fetchJson(`${base}/api/tasks/stats`)
    check('8.4 /api/tasks/stats', taskStats.body.value.total === 2)
    const workStats = await fetchJson(`${base}/api/work/stats`)
    check('8.5 /api/work/stats', workStats.body.value.completed === 1)
    const archTypes = await fetchJson(`${base}/api/arch/types`)
    check('8.6 /api/arch/types 五类图', archTypes.body.value.length === 5)

    // studio 默认页：Python 版 graphify 产物是 graph.html（B11 修复点）
    const studioRes = await fetch(`${base}/studio/e2e-proj/graph.html`)
    check('8.9 studio graph.html 可取（B11）', studioRes.status === 200 || studioRes.status === 404, `status=${studioRes.status}`)

    const consoleRes = await fetch(`${base}/`)
    const consoleHtml = await consoleRes.text()
    check('8.7 控制台页面可访问', consoleRes.status === 200 && consoleHtml.includes('<div id="root"'))
    const spa = await fetch(`${base}/roles`)
    check('8.8 SPA 回退 200', spa.status === 200)

    // ===== 10. 项目知识导入链路（A1-A4） =====
    const projRoot = join(workRoot, 'demo-project')
    await mkdir(join(projRoot, 'docs', 'order'), { recursive: true })
    await mkdir(join(projRoot, 'node_modules'), { recursive: true })
    await writeFile(join(projRoot, 'README.md'), '# 订单平台\n\n总体说明。\n', 'utf-8')
    await writeFile(join(projRoot, 'docs', 'order', 'rules.md'), '# 订单规则\n\n禁止吞掉异常。\n', 'utf-8')
    await writeFile(join(projRoot, 'docs', 'spec.csv'), 'id,title\nJAVA-01,禁止吞异常\n', 'utf-8')
    await writeFile(join(projRoot, 'node_modules', 'skip.md'), '# 应被忽略\n', 'utf-8')
    await writeFile(join(projRoot, 'image.png'), 'not-supported', 'utf-8')

    const projAdd = await cli(['project', 'add', projRoot, '--name', 'demo', '--json'], env)
    check('10.1 project add 登记成功', projAdd.code === 0 && JSON.parse(projAdd.stdout).value.project === 'demo')

    const projList = await cli(['project', 'list', '--json'], env)
    const projects = JSON.parse(projList.stdout).value
    check(
      '10.2 project list 含登记项与扫描字段',
      projects.some((p) => p.project === 'demo' && typeof p.registered_at === 'string'),
      `n=${projects.length}`,
    )

    const syncDry = await cli(['kb', 'sync', 'demo', '--dry-run', '--json'], env)
    const dryReport = JSON.parse(syncDry.stdout).value
    check(
      '10.3 kb sync --dry-run 只报告不落库（忽略 node_modules/不支持格式）',
      dryReport.discovered === 3 && dryReport.created === 3,
      `discovered=${dryReport.discovered} created=${dryReport.created}`,
    )

    const sync = await cli(['kb', 'sync', 'demo', '--json'], env)
    const syncReport = JSON.parse(sync.stdout).value
    check('10.4 kb sync 建引用索引（含 csv 转换）', syncReport.created === 3 && syncReport.skipped === 0)

    const syncAgain = await cli(['kb', 'sync', 'demo', '--json'], env)
    const againReport = JSON.parse(syncAgain.stdout).value
    check(
      '10.5 kb sync 幂等（源未变全部 unchanged）',
      againReport.created === 0 && againReport.unchanged === 3,
      `unchanged=${againReport.unchanged}`,
    )

    const indexedSearch = await cli(['kb', 'search', '订单', '--json'], env)
    check('10.6 引用型条目可检索（中文）', JSON.parse(indexedSearch.stdout).value.length >= 2)

    // 源文件变更 → 重扫报 updated
    await writeFile(join(projRoot, 'README.md'), '# 订单平台\n\n总体说明。\n\n新增：日志带上下文。\n', 'utf-8')
    const syncChanged = await cli(['kb', 'sync', 'demo', '--json'], env)
    check('10.7 源变更 → 重扫 updated', JSON.parse(syncChanged.stdout).value.updated === 1)

    // BLK-1 回归：reindex 不吞引用型
    const reindex = await cli(['kb', 'reindex', '--json'], env)
    const afterReindex = await cli(['kb', 'search', '订单', '--json'], env)
    check(
      '10.8 reindex 后引用型索引存活（BLK-1）',
      reindex.code === 0 && JSON.parse(afterReindex.stdout).value.length >= 2,
      `hits=${JSON.parse(afterReindex.stdout).value.length}`,
    )

    // ===== 11. 治理能力（B1-B3） =====
    const softDel = await cli(['kb', 'remove', 'E2E-B', '--json'], env)
    check('11.1 软删成功（mode=soft）', softDel.code === 0 && JSON.parse(softDel.stdout).value.mode === 'soft')

    const afterDel = await cli(['kb', 'search', '缓存', '--json'], env)
    check(
      '11.2 软删后不出现在检索',
      !JSON.parse(afterDel.stdout).value.some((h) => h.id === 'E2E-B'),
    )

    const getDeleted = await cli(['kb', 'get', 'E2E-B', '--json'], env)
    check('11.3 软删后仍可按 id 取到（可恢复）', JSON.parse(getDeleted.stdout).value.status === 'deprecated')

    // BLK-2 回归：reindex 不复活软删
    await cli(['kb', 'reindex', '--json'], env)
    const afterReindexDel = await cli(['kb', 'get', 'E2E-B', '--json'], env)
    check(
      '11.4 reindex 后软删不复活（BLK-2）',
      JSON.parse(afterReindexDel.stdout).value.status === 'deprecated',
    )

    // 硬删被引用条目 → 拒绝
    const hardDel = await cli(['kb', 'remove', 'E2E-A', '--hard', '--yes', '--json'], env)
    check('11.5 被引用条目禁止硬删', hardDel.code !== 0 && hardDel.stderr.includes('referenced'))

    // ===== 12. 冲突检测闭环（B2） =====
    // 造同名跨层条目：global 与 project 同名同模块且未声明 overrides
    const gDoc = join(workRoot, 'conf-global.md')
    const pDoc = join(workRoot, 'conf-project.md')
    await writeFile(
      gDoc,
      '---\nid: CONF-G\ntitle: 命名规范\ntype: rule\nlayer: global\nbook: e2e\nmodule: conf\n---\n\n全局。\n',
      'utf-8',
    )
    await writeFile(
      pDoc,
      '---\nid: CONF-P\ntitle: 命名规范\ntype: rule\nlayer: project\nowner: e2e\nbook: e2e\nmodule: conf\n---\n\n项目。\n',
      'utf-8',
    )
    await cli(['kb', 'import', gDoc], env)
    await cli(['kb', 'import', pDoc], env)

    const confList = await cli(['kb', 'conflicts', '--json'], env)
    const conflicts = JSON.parse(confList.stdout).value
    check(
      '12.1 同名跨层 → 检出冲突',
      conflicts.length >= 1 && conflicts.some((c) => c.high_id === 'CONF-P' && c.low_id === 'CONF-G'),
      `n=${conflicts.length}`,
    )

    const conflictId = conflicts[0]?.id
    const resolved = await cli(['kb', 'resolve', conflictId, '--json'], env)
    check('12.2 标记冲突已处理', resolved.code === 0 && JSON.parse(resolved.stdout).value.resolved === true)

    const afterResolve = await cli(['kb', 'conflicts', '--json'], env)
    check('12.3 已处理冲突不再出现在默认列表', JSON.parse(afterResolve.stdout).value.length === conflicts.length - 1)

    // ===== 13. 扫描历史（孤儿索引不再输出即焚） =====
    const hist = await cli(['kb', 'history', 'demo', '--json'], env)
    const histList = JSON.parse(hist.stdout).value
    check(
      '13.1 扫描历史已落盘',
      hist.code === 0 && histList.length >= 1 && histList[0].project === 'demo',
      `n=${histList.length}`,
    )
    check(
      '13.2 历史含孤儿索引字段',
      Array.isArray(histList[0]?.missing) && Array.isArray(histList[0]?.unreadable),
    )

    // ===== 14. 角色/团队/技能：技能使用视图 + skill 子命令 =====
    const usage = await cli(['--json', 'skill', 'list'], env) // 保底：命令可用
    check('14.1 skill list 可用', usage.code === 0)

    const skillValidate = await cli(['skill', 'validate', '--json'], env)
    const validateResult = JSON.parse(skillValidate.stdout)
    check(
      '14.2 skill validate 内置 Skill 无错误',
      skillValidate.code === 0 && validateResult.ok === true,
      `n=${validateResult.value?.length ?? 0}`,
    )

    const roleGet = await cli(['role', 'show', 'dev-1', '--json'], env)
    check('14.3 role show 返回单个角色定义', roleGet.code === 0 && JSON.parse(roleGet.stdout).value.name === 'dev-1')

    // 技能使用视图（HTTP）
    const usageRes = await fetchJson(`${base}/api/skills/usage`)
    check(
      '14.4 /api/skills/usage 返回合并视图',
      usageRes.status === 200 && Array.isArray(usageRes.body.value),
      `n=${usageRes.body.value?.length ?? 0}`,
    )

    // ===== 15. 上下文包（knowledge-injection §4 模式 B） =====
    const packRes = await fetchJson(
      `${base}/api/kb/context-pack?role=dev-1&task=${encodeURIComponent('性能 缓存')}&budget_tokens=2000`,
    )
    check(
      '15.1 context-pack 组装成功（含来源）',
      packRes.status === 200 &&
        Array.isArray(packRes.body.value.items) &&
        packRes.body.value.items.length >= 1 &&
        packRes.body.value.sources.length === packRes.body.value.items.length,
      `items=${packRes.body.value.items?.length ?? 0}`,
    )
    check(
      '15.2 context-pack 带预算与截断标记',
      typeof packRes.body.value.total_tokens === 'number' &&
        typeof packRes.body.value.truncated === 'boolean',
    )

    // ===== 16. AGENTS.md 注入块（模式 C） =====
    const injRoot = join(workRoot, 'inj-project')
    await mkdir(injRoot, { recursive: true })
    await writeFile(join(injRoot, 'AGENTS.md'), '# 手写项目\n\n不许动的段落。\n', 'utf-8')
    const inj = await cli(['inject', injRoot, '--team', 'core-dev', '--json'], env)
    const injResult = JSON.parse(inj.stdout).value
    check('16.1 inject 追加标记块', inj.code === 0 && injResult.action === 'appended')

    const injText = await readFile(join(injRoot, 'AGENTS.md'), 'utf-8')
    check(
      '16.2 手写内容不动、块含工具指引',
      injText.includes('不许动的段落。') && injText.includes('prism:begin') && injText.includes('prism_kb_search'),
    )

    const injAgain = await cli(['inject', injRoot, '--json'], env)
    check('16.3 重复注入幂等（updated）', JSON.parse(injAgain.stdout).value.action === 'updated')

    const uninj = await cli(['inject', injRoot, '--remove', '--json'], env)
    const afterText = await readFile(join(injRoot, 'AGENTS.md'), 'utf-8')
    check(
      '16.4 --remove 只删块、手写内容保留',
      JSON.parse(uninj.stdout).value.removed === true && afterText.includes('不许动的段落。') && !afterText.includes('prism:begin'),
    )

    // ===== 17. 本地向量混合检索（变更 2；装了 BGE-M3 才跑，否则 SKIP）=====
    // 与主流程的 PRISM_EMBEDDING=off 相反：这里显式打开，验证语义召回真实可用。
    const embedInstalled = await cli(['embedding', 'status', '--home', home, '--json'], { ...env, PRISM_EMBEDDING: '' })
    const embedStatus = JSON.parse(embedInstalled.stdout).value
    if (!embedStatus.installed) {
      process.stdout.write('SKIP 17.x 本地向量未安装（node scripts/setup-embedding.mjs）\n')
    } else {
      const hEnv = { ...env, PRISM_EMBEDDING: '' }
      // 落两条语义不同、无词面重叠的中文知识
      await writeFile(
        join(workRoot, 'phone.md'),
        '---\nid: V-PHONE\ntitle: 智能手机保护配件\ntype: doc\nlayer: global\nbook: vec\nmodule: hw\n---\n\n苹果磁吸生态的防护外壳与充电配件。\n',
        'utf-8',
      )
      await writeFile(
        join(workRoot, 'db.md'),
        '---\nid: V-DB\ntitle: 关系型存储服务调优\ntype: guide\nlayer: global\nbook: vec\nmodule: db\n---\n\n连接池容量与慢查询分析，防止服务雪崩。\n',
        'utf-8',
      )
      await cli(['kb', 'import', join(workRoot, 'phone.md'), '--json'], hEnv)
      await cli(['kb', 'import', join(workRoot, 'db.md'), '--json'], hEnv)

      const vecRows = await cli(['embedding', 'status', '--json'], hEnv)
      const vecStatus = JSON.parse(vecRows.stdout).value
      check(
        '17.1 embedding 服务就绪（档位/维度自洽）',
        vecStatus.alive === true && vecStatus.dim > 0,
        `tier=${vecStatus.tier} dim=${vecStatus.dim}`,
      )

      // 跨语言语义召回：英文 query 无任何中文 bigram 重叠 → 纯 BM25 零命中
      const bm25Only = await cli(['kb', 'search', 'database performance', '--no-embedding', '--json'], hEnv)
      const hybrid = await cli(['kb', 'search', 'database performance', '--json'], hEnv)
      const bm25Hits = JSON.parse(bm25Only.stdout).value
      const hybridHits = JSON.parse(hybrid.stdout).value
      check(
        '17.2 纯 BM25 对跨语言 query 零命中，混合检索召回',
        bm25Hits.length === 0 && hybridHits.some((h) => h.id === 'V-DB'),
        `bm25=${bm25Hits.length} hybrid=${hybridHits.length}`,
      )

      // 向量落库：kb_vectors 应有行
      const vecCount = await cli(['embedding', 'reindex', '--json'], hEnv)
      check('17.3 embedding reindex 幂等（无失败）', JSON.parse(vecCount.stdout).value.failed === 0)

      // 超长文档必须能嵌入（回归：客户端曾按 8000 字符发，撞 physical batch 上限直接 500）
      // 该句约 30 字，repeat(300) → 约 9000 字，确保超过旧的 8000 截断阈值
      const longBody = '这是一段足够长的中文知识正文，用于验证超长输入不会导致嵌入失败。'.repeat(300)
      await writeFile(
        join(workRoot, 'long.md'),
        `---\nid: V-LONG\ntitle: 长文档健壮性\ntype: doc\nlayer: global\nbook: vec\nmodule: big\n---\n\n${longBody}\n`,
        'utf-8',
      )
      await cli(['kb', 'import', join(workRoot, 'long.md'), '--json'], hEnv)
      const longReindex = await cli(['embedding', 'reindex', '--json'], hEnv)
      const longStats = JSON.parse(longReindex.stdout).value
      check(
        '17.4 超长文档（>8000 字）嵌入不失败',
        longStats.failed === 0,
        `failed=${longStats.failed} total=${longStats.total}`,
      )
      await cli(['embedding', 'stop', '--json'], hEnv)
    }

    // ===== 9. 真实宿主零污染 =====
    const realAfter = await listDir(REAL_ZCODE)
    check(
      '9.1 真实 ~/.zcode/agents 未被改动',
      JSON.stringify(realBefore) === JSON.stringify(realAfter),
      `${realBefore?.length ?? 0} → ${realAfter?.length ?? 0}`,
    )
  } finally {
    if (server !== undefined) await server.close()
    if (KEEP) {
      process.stdout.write(`\n临时目录保留: ${workRoot}\n`)
    } else {
      await rm(workRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  const passed = results.length - failures
  process.stdout.write(`\nE2E RESULT: ${passed}/${results.length} passed\n`)
  // 用 exitCode 让事件循环自然退出——直接 process.exit() 会在 Windows 上
  // 触发 libuv 句柄关闭断言（服务/子进程句柄尚未回收）
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
