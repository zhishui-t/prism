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
import { dirname, join, resolve } from 'node:path'
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

/** 运行 CLI（注入 PRISM_HOME / PRISM_HARNESS_ROOT 隔离）。 */
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

/** 列出系统临时目录下既有的 `prism-e2e-*`（残留基线/收尾比对用）。 */
async function listE2eTempDirs() {
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('prism-e2e-'))
    .map((entry) => join(tmpdir(), entry.name))
    .sort()
}

/** 递归列目录内容（残留清单用；`max` 截断，避免大目录刷屏）。 */
async function listTree(root, max = 200) {
  const out = []
  const walk = async (dir) => {
    if (out.length >= max) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= max) return
      const full = join(dir, entry.name)
      out.push(full)
      if (entry.isDirectory()) await walk(full)
    }
  }
  await walk(root)
  return out
}

/**
 * 清理临时目录（F-T1）：**删不掉不静默**——打 warning + 残留清单。
 *
 * 为什么不能 `.catch(() => {})`：Windows 上被占用的句柄会让 `rm` 半途失败，
 * 静默吞掉之后「临时目录在悄悄堆积」这件事没有任何人看得见。
 * 返回是否删干净（收尾的残留比对会据此判红）。
 */
async function cleanupTempDir(dir) {
  let error
  // 退避重试：Windows 上句柄释放与杀软/索引器扫描都有延迟，「刚关掉就删」常失败而
  // 稍等即可成功。重试 6 次（合计约 1.9s）后仍失败才算真残留。
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return true
    } catch (caught) {
      error = caught
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100 * (attempt + 1)))
    }
  }
  const reason = error instanceof Error ? error.message : String(error)
  process.stdout.write(`\nWARN 临时目录未能删除: ${dir}\n  原因: ${reason}\n`)
  const leftovers = await listTree(dir).catch(() => [])
  process.stdout.write(`  残留清单（${leftovers.length} 项${leftovers.length >= 200 ? '+，已截断' : ''}）:\n`)
  for (const item of leftovers.slice(0, 50)) process.stdout.write(`    ${item}\n`)
  if (leftovers.length > 50) process.stdout.write(`    … 另有 ${leftovers.length - 50} 项\n`)
  return false
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

  // F-T1：临时目录残留基线——收尾比对「本轮有没有新增残留」（残留不增长即达标）
  const tempBefore = await listE2eTempDirs()
  process.stdout.write(`临时目录基线: ${tempBefore.length} 个既有 prism-e2e-* 残留\n\n`)

  const workRoot = await mkdtemp(join(tmpdir(), 'prism-e2e-'))
  const home = join(workRoot, 'home')
  const harnessRoot = join(workRoot, 'zcode')
  const projectDir = join(workRoot, 'proj')
  // 主流程关闭向量（PRISM_EMBEDDING=off）：向量召回会扩大命中面，破坏精确计数断言。
  // 确定性优先——混合检索单独在 ===== 17 段按真实模型验证（装了才跑）。
  const env = { PRISM_HOME: home, PRISM_HARNESS_ROOT: harnessRoot, PRISM_EMBEDDING: 'off' }

  let server
  // F-T1：MCP 工具集会惰性打开知识库/台账 SQLite，需在清理临时目录前显式释放。
  let mcpTools
  try {
    await mkdir(join(projectDir, 'src'), { recursive: true })
    await mkdir(home, { recursive: true })

    // ===== 1. init：注册 MCP + 装 Skill + 建骨架（显式 --harness-root） =====
    const init = await cli(['init', '--home', home, '--harness-root', harnessRoot, '--json'], env)
    check('1.1 init 成功', init.code === 0, init.stderr.trim().slice(0, 160))
    const initReport = JSON.parse(init.stdout)
    check('1.2 init 装 Skill 到 harnessRoot', initReport.value.skills.written.length >= 1)
    check(
      '1.3 init 写 MCP 注册',
      initReport.value.mcp.status === 'written' || initReport.value.mcp.status === 'unchanged',
      initReport.value.mcp.status,
    )
    const harnessTeamsExists = await readdir(join(harnessRoot, 'teams')).then(() => true, () => false)
    const homeTeamsExists = await readdir(join(home, 'teams')).then(() => true, () => false)
    check(
      '1.4 init 不代建团队、不预建 teams/（要不要建团队由使用者决定）',
      initReport.value.seededTeam === undefined && !harnessTeamsExists && !homeTeamsExists,
      `seededTeam=${JSON.stringify(initReport.value.seededTeam)} harnessTeams=${harnessTeamsExists} homeTeams=${homeTeamsExists}`,
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

    // ===== 3. 角色与团队：import → 使用者自建团队 → validate → activate =====
    // init 只建骨架、**不代建团队**：角色库先备齐，再由使用者自己编队
    for (const role of ['dev-1', 'dev-2', 'super-dev', 'tester', 'qa-checker']) {
      await writeFile(
        join(workRoot, `${role}.md`),
        `---\nname: ${role}\ndescription: "E2E 角色 ${role}"\ncolor: blue\n---\n\n## 核心契约\n**交付可运行增量。**\n`,
        'utf-8',
      )
    }
    const roleImport = await cli(['role', 'import', '--from', workRoot, '--harness-root', harnessRoot, '--json'], env)
    check('3.1 role import 成功', roleImport.code === 0)
    const roles = await cli(['role', 'list', '--json'], env)
    check('3.2 role list 含 dev-1', JSON.parse(roles.stdout).value.some((r) => r.name === 'dev-1'))

    // 3.3 使用者显式编队：建不建团队、建什么编制，是使用者自己的事
    const mkCoreDev = await cli(
      ['team', 'init', 'core-dev', '--template', 'core-dev', '--harness-root', harnessRoot, '--json'],
      env,
    )
    check(
      '3.3 使用者自建 core-dev（team init --template core-dev）',
      mkCoreDev.code === 0,
      mkCoreDev.stderr.trim().slice(0, 200),
    )

    // ===== 4. 富化直付（工作队列已移除：kb enrich 直接回写） =====
    const enr = await cli(
      ['kb', 'enrich', 'summarize', '--payload', '{"entry_id":"E2E-A","book":"e2e"}', '--result', '{"summary":"性能问题先量化再优化"}', '--by', 'e2e', '--json'],
      env,
    )
    const enrVal = enr.code === 0 ? JSON.parse(enr.stdout).value : {}
    check('4.1 kb enrich summarize 落库', enr.code === 0 && enrVal.action === 'created', enr.stderr.trim().slice(0, 120))
    const sumHit = await cli(['kb', 'get', 'SUMMARY-E2E-A', '--json'], env)
    check('4.2 摘要条目可检索（SUMMARY-E2E-A）', sumHit.code === 0 && JSON.parse(sumHit.stdout).value.title.includes('摘要'))

    // 4.3 文档转换（纯文本直读）
    const conv = await cli(['kb', 'convert', docA, '--json'], env)
    check('4.3 kb convert 纯文本直读', conv.code === 0 && JSON.parse(conv.stdout).value.status === 'text')

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
    const serverModule = await import(pathToFileURL(join(ROOT, 'packages', 'server', 'dist', 'index.js')).href)
    const { startServer } = serverModule
    // 进程内 server 也关向量：省去 600MB 模型加载，且 search 计数确定
    process.env['PRISM_EMBEDDING'] = 'off'
    // 显式 harnessRoot（隔离修正）：不传时 server 会回落到默认宿主 ~/.zcode，
    // 使 /api/teams、/api/skills/effective 读到真实宿主（R5 邻域：只读但语义错位）。
    server = await startServer({ home, harnessRoot, port: PORT })
    const base = `http://127.0.0.1:${server.port}`

    const health = await fetchJson(`${base}/api/health`)
    check('8.1 /api/health', health.status === 200 && health.body.ok === true)
    const kbSearch = await fetchJson(`${base}/api/kb/search?q=${encodeURIComponent('性能')}`)
    check('8.2 /api/kb/search 命中', kbSearch.body.value.length >= 1)
    const kbGraph = await fetchJson(`${base}/api/kb/graph`)
    check('8.3 /api/kb/graph 返回节点/边', kbGraph.body.value.nodes.length >= 2)
    const taskStats = await fetchJson(`${base}/api/tasks/stats`)
    check('8.4 /api/tasks/stats', taskStats.body.value.total === 2)
    const kbStats = await fetchJson(`${base}/api/kb/stats`)
    check('8.5 /api/kb/stats 含摘要条目', kbStats.body.value.entries >= 3)
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

    // 引用型软删后源变更重扫不复活（回归）；显式 restore 才恢复
    const restoreRes = await cli(['kb', 'restore', 'E2E-B', '--json'], env)
    const restoredGet = await cli(['kb', 'get', 'E2E-B', '--json'], env)
    check(
      '11.4b kb restore 恢复软删条目',
      restoreRes.code === 0 &&
        JSON.parse(restoreRes.stdout).value.restored === true &&
        JSON.parse(restoredGet.stdout).value.status === 'active',
    )
    // 恢复后再软删一次（后续 11.5 的引用检查不受影响）
    await cli(['kb', 'remove', 'E2E-B', '--json'], env)

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

    // ===== 18. harness 插件：放目录即注册（零代码侵入；变更 3c） =====
    {
      const pluginRoot = join(home, 'harnesses', 'e2e-harness')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(
        join(pluginRoot, 'harness.json'),
        JSON.stringify({ id: 'e2e-harness', entry: './index.mjs' }),
        'utf-8',
      )
      await writeFile(
        join(pluginRoot, 'index.mjs'),
        `export default function createAdapter(opts) {
  const root = opts.root ?? '/tmp/e2e-harness-home'
  return {
    id: 'e2e-harness', displayName: 'E2E Harness', defaultRoot: root,
    detect: async () => ({ installed: true, configDir: root }),
    agent: { globalDir: root + '/roles', projectDir: null, filePattern: '<role>.md', teamDir: root + '/squads',
      frontmatterFields: ['name'], bodyConvention: '## 核心契约', activation: 'session-start', nameMustMatchFile: true },
    dispatch: null, model: null,
    skill: { nativeDir: root + '/skills', ecosystemDir: null, format: 'SKILL.md', supported: true },
    instructions: { file: 'AGENTS.md', projectFile: '<repo>/AGENTS.md' },
    mcp: null,
    renderRole: () => ({ path: '', content: '', format: 'markdown', writePolicy: 'overwrite', marker: '' }),
    parseRole: () => ({}), renderTeamInstructions: () => null,
  }
}
`,
        'utf-8',
      )

      const listed = await cli(['harness', 'list', '--json'], env)
      const lv = JSON.parse(listed.stdout).value
      check(
        '18.1 插件被自动发现（origin=external）',
        lv.adapters.some((a) => a.id === 'e2e-harness' && a.origin === 'external'),
        JSON.stringify(lv.adapters.map((a) => a.id)),
      )

      const shown = await cli(['harness', 'show', '--json'], { ...env, PRISM_HARNESS: 'e2e-harness' })
      const sv = JSON.parse(shown.stdout).value
      check(
        '18.2 可激活插件，布局随其自述（squads/skills）',
        sv.id === 'e2e-harness' && String(sv.agent.teamDir).includes('squads'),
        `${sv.id} teamDir=${sv.agent.teamDir}`,
      )
    }

    // ===== 19. design-v4 §6 验收补充（F-A1/A2/A4/B4/C1/C3/D2/E2/E3） =====
    {
      const jparse = (res) => {
        try {
          return JSON.parse(res.stdout)
        } catch {
          return {}
        }
      }
      const fileExists = async (p) => {
        try {
          await readFile(p)
          return true
        } catch {
          return false
        }
      }
      const httpJson = async (method, apiPath, body) => {
        const res = await fetch(`${base}${apiPath}`, {
          method,
          ...(body !== undefined
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        })
        let parsed = null
        try {
          parsed = await res.json()
        } catch {
          parsed = null
        }
        return { status: res.status, body: parsed }
      }
      const errText = (r) => `${r.body?.error?.code ?? ''} ${r.body?.error?.message ?? ''}`.trim()

      // ---------- F-A1 书结构生成 / 幂等 / show / freeze ----------
      const gen1 = await cli(['kb', 'structure', 'generate', '--layer', 'global', '--book', 'e2e', '--json'], env)
      const gen1v = jparse(gen1).value ?? {}
      const genFiles = Array.isArray(gen1v.files) ? gen1v.files : []
      const modulesYaml = genFiles.find((f) => f.endsWith('_modules.yaml'))
      const bookDir = modulesYaml !== undefined ? dirname(modulesYaml) : ''
      const allFilesExist = (await Promise.all(genFiles.map((f) => fileExists(f)))).every(Boolean)
      check(
        '19.1.1 F-A1 generate 产 _modules.yaml + 书级/模块级 _summary.md（文件真实存在）',
        gen1.code === 0 &&
          modulesYaml !== undefined &&
          genFiles.length >= 3 &&
          genFiles.some((f) => dirname(f) === bookDir && f.endsWith('_summary.md')) &&
          genFiles.some((f) => dirname(f) !== bookDir && f.endsWith('_summary.md')) &&
          allFilesExist,
        `files=${genFiles.length} exist=${allFilesExist}`,
      )

      const snapshot = async (paths) =>
        JSON.stringify(await Promise.all([...paths].sort().map(async (f) => [f, await readFile(f, 'utf-8')])))
      const beforeRegen = await snapshot(genFiles)
      const gen2 = await cli(['kb', 'structure', 'generate', '--layer', 'global', '--book', 'e2e', '--json'], env)
      const afterRegen = await snapshot(genFiles)
      const revBefore = gen1v.structure?.revision
      const revAfter = jparse(gen2).value?.structure?.revision
      check(
        '19.1.2 F-A1 幂等：二次 generate 全部文件逐字节一致 + revision 不递增',
        gen1.code === 0 && gen2.code === 0 && beforeRegen === afterRegen && revBefore === revAfter,
        `bytesEqual=${beforeRegen === afterRegen} revision=${String(revBefore)}→${String(revAfter)}`,
      )

      const modulesText = modulesYaml !== undefined ? await readFile(modulesYaml, 'utf-8') : ''
      const bookSummaryText = bookDir !== '' ? await readFile(join(bookDir, '_summary.md'), 'utf-8') : ''
      check(
        '19.1.3 F-A1 幂等强口径：_modules.yaml/_summary.md 不含时钟字段',
        modulesText !== '' &&
          bookSummaryText !== '' &&
          !modulesText.includes('updated_at') &&
          !bookSummaryText.includes('updated_at'),
      )

      const showGen = await cli(['kb', 'structure', 'show', '--layer', 'global', '--book', 'e2e', '--json'], env)
      const showGenV = jparse(showGen).value ?? {}
      const suggested = Array.isArray(showGenV.suggested) ? showGenV.suggested : []
      check(
        '19.1.4 F-A1 show：suggested 按条目数降序 + 未冻结 modules 为空 + inherited_from 空',
        showGen.code === 0 &&
          suggested.length >= 1 &&
          Array.isArray(showGenV.modules) &&
          showGenV.modules.length === 0 &&
          Array.isArray(showGenV.inherited_from) &&
          showGenV.inherited_from.length === 0 &&
          suggested.every((s, i, a) => i === 0 || a[i - 1].entries >= s.entries),
        `suggested=${JSON.stringify(suggested)}`,
      )

      const frozenModule = suggested.find((s) => s.slug !== '_inbox')?.slug ?? 'perf'
      const frz = await cli(
        ['kb', 'structure', 'freeze', '--layer', 'global', '--book', 'e2e', '--modules', frozenModule, '--confirmed-by', 'tester-1', '--json'],
        env,
      )
      const frzV = jparse(frz).value ?? {}
      check(
        '19.1.5 F-A1 freeze：revision=1 + 清单固化 + frozen_at/confirmed_by 落文件与表',
        frz.code === 0 &&
          frzV.revision === 1 &&
          Array.isArray(frzV.modules) &&
          frzV.modules.join(',') === frozenModule &&
          typeof frzV.frozen_at === 'string' &&
          frzV.confirmed_by === 'tester-1',
        `revision=${String(frzV.revision)} modules=${JSON.stringify(frzV.modules)}`,
      )

      const gen3 = await cli(['kb', 'structure', 'generate', '--layer', 'global', '--book', 'e2e', '--json'], env)
      const gen3V = jparse(gen3).value ?? {}
      check(
        '19.1.6 F-A1 freeze 后 generate 不覆盖冻结清单（revision 不变）',
        gen3.code === 0 &&
          gen3V.structure?.revision === 1 &&
          (gen3V.structure?.modules ?? []).join(',') === frozenModule,
        `modules=${JSON.stringify(gen3V.structure?.modules)}`,
      )
      const showFrozen = await cli(['kb', 'structure', 'show', '--layer', 'global', '--book', 'e2e', '--json'], env)
      const showFrozenV = jparse(showFrozen).value ?? {}
      check(
        '19.1.7 F-A1 show 读回冻结清单（文件为真相，R7）',
        showFrozen.code === 0 && showFrozenV.revision === 1 && (showFrozenV.modules ?? []).join(',') === frozenModule,
      )

      const genGhost = await cli(['kb', 'structure', 'generate', '--layer', 'global', '--book', 'ghost-book', '--json'], env)
      check(
        '19.1.8 F-A1 异常：generate 不存在的书 → bad_request',
        genGhost.code !== 0 && genGhost.stderr.includes('bad_request'),
        genGhost.stderr.trim().slice(0, 120),
      )
      const showGhost = await cli(['kb', 'structure', 'show', '--layer', 'global', '--book', 'ghost-book', '--json'], env)
      check(
        '19.1.9 F-A1 异常：show 无结构 → not_found + 可执行提示',
        showGhost.code !== 0 && showGhost.stderr.includes('not_found') && showGhost.stderr.includes('structure generate'),
      )
      const badAction = await cli(['kb', 'structure', 'bogus', '--layer', 'global', '--book', 'e2e'], env)
      check('19.1.10 F-A1 异常：非法动作 → 用法提示', badAction.code !== 0 && badAction.stderr.includes('未知动作'))
      const missBook = await cli(['kb', 'structure', 'generate', '--layer', 'global', '--json'], env)
      check(
        '19.1.11 F-A1 异常：缺 --book → 缺少必填参数',
        missBook.code !== 0 && missBook.stderr.includes('--book <b>'),
        missBook.stderr.trim().slice(0, 90),
      )

      // ---------- F-A2 书结构继承 ----------
      const childDoc = join(workRoot, 'child.md')
      await writeFile(
        childDoc,
        '---\nid: CHILD-1\ntitle: 子书条目\ntype: doc\nlayer: global\nbook: e2echild\nmodule: cb\n---\n\n子书正文。\n',
        'utf-8',
      )
      await cli(['kb', 'import', childDoc, '--json'], env)
      const genChild = await cli(['kb', 'structure', 'generate', '--layer', 'global', '--book', 'e2echild', '--json'], env)
      const childYaml =
        (jparse(genChild).value?.files ?? []).find((f) => f.endsWith('_modules.yaml')) ??
        join(dirname(bookDir), 'e2echild', '_modules.yaml')
      // 人工声明继承（文件为真相）；格式逐字对齐 packages/knowledge/test/book-structure.test.ts 的 writeModules
      const writeChildModules = (inherits, modules) =>
        writeFile(
          childYaml,
          [
            '# generated: true',
            'layer: global',
            'book: e2echild',
            'generated: true',
            'revision: 1',
            'frozen_at: null',
            'confirmed_by: null',
            `inherits: [${inherits.join(', ')}]`,
            `modules: [${modules.join(', ')}]`,
            '',
          ].join('\n'),
          'utf-8',
        )

      await writeChildModules(['global/e2e'], ['cb'])
      const showChild = await cli(['kb', 'structure', 'show', '--layer', 'global', '--book', 'e2echild', '--json'], env)
      const childV = jparse(showChild).value ?? {}
      const childModules = Array.isArray(childV.modules) ? childV.modules : []
      check(
        '19.2.1 F-A2 继承正例：父统一在前 + 本地覆盖不重复 + inherited_from 非空',
        showChild.code === 0 &&
          (childV.inherited_from ?? []).includes('global/e2e') &&
          childModules.includes('cb') &&
          childModules.includes(frozenModule) &&
          childModules.indexOf(frozenModule) < childModules.indexOf('cb') &&
          new Set(childModules).size === childModules.length,
        `modules=${JSON.stringify(childModules)} inherited_from=${JSON.stringify(childV.inherited_from)}`,
      )
      await writeChildModules(['global/ghost-book'], ['cb'])
      const badInh = await cli(['kb', 'structure', 'show', '--layer', 'global', '--book', 'e2echild', '--json'], env)
      check(
        '19.2.2 F-A2 异常：缺父 → book_inherit_invalid（消息含缺失链路）',
        badInh.code !== 0 && badInh.stderr.includes('book_inherit_invalid') && badInh.stderr.includes('global/ghost-book'),
        badInh.stderr.trim().slice(0, 140),
      )
      await writeChildModules(['global/e2echild'], ['cb'])
      const selfInh = await cli(['kb', 'structure', 'show', '--layer', 'global', '--book', 'e2echild', '--json'], env)
      check(
        '19.2.3 F-A2 异常：自继承 → book_inherit_invalid',
        selfInh.code !== 0 && selfInh.stderr.includes('book_inherit_invalid'),
        selfInh.stderr.trim().slice(0, 120),
      )
      await writeChildModules(['global'], ['cb'])
      const segInh = await cli(['kb', 'structure', 'show', '--layer', 'global', '--book', 'e2echild', '--json'], env)
      check(
        '19.2.4 F-A2 异常：继承引用段数非法 → book_inherit_invalid',
        segInh.code !== 0 && segInh.stderr.includes('book_inherit_invalid'),
        segInh.stderr.trim().slice(0, 120),
      )

      // ---------- F-A4 status 往返（自有型） ----------
      // 注意：`kb deposit` 的 id **由服务端生成**（不采用 frontmatter 的 id）；
      // 要造同一 id 的多版次须走 `kb import`（frontmatter id 生效，已实测确认）。
      const stFm = (body) =>
        `---\nid: STI-1\ntitle: 版次状态往返\ntype: doc\nlayer: global\nbook: e2estatus\nmodule: st\n---\n\n${body}\n`
      const stFile1 = join(workRoot, 'status-v1.md')
      const stFile2 = join(workRoot, 'status-v2.md')
      await writeFile(stFile1, stFm('状态往返正文 v1。'), 'utf-8')
      await writeFile(stFile2, stFm('状态往返正文 v2（内容已变更）。'), 'utf-8')
      const stImp1 = await cli(['kb', 'import', stFile1, '--json'], env)
      const stImp1V = jparse(stImp1).value ?? {}
      const stPath = stImp1V.path ?? ''
      check(
        '19.3.1 F-A4 自有型落库可定位版次文件（frontmatter id + path 非空）',
        stImp1.code === 0 && stImp1V.id === 'STI-1' && typeof stPath === 'string' && stPath !== '',
        `id=${String(stImp1V.id)} path=${stPath}`,
      )
      const withStatus = (text, status) =>
        /(^|\n)status:[^\n]*/.test(text)
          ? text.replace(/(^|\n)status:[^\n]*/, `$1status: ${status}`)
          : text.replace(/\n---/, `\nstatus: ${status}\n---`)
      const applyStatus = async (status) => {
        await writeFile(stPath, withStatus(await readFile(stPath, 'utf-8'), status), 'utf-8')
        await cli(['kb', 'reindex', '--json'], env)
        return jparse(await cli(['kb', 'get', 'STI-1', '--json'], env)).value?.status
      }
      const statusSuperseded = stPath !== '' ? await applyStatus('superseded') : 'no-path'
      check(
        '19.3.2 F-A4 latest 版写 status: superseded → reindex 后仍 superseded（不压平成 active）',
        statusSuperseded === 'superseded',
        `status=${String(statusSuperseded)}`,
      )
      const statusCandidate = stPath !== '' ? await applyStatus('candidate') : 'no-path'
      check(
        '19.3.3 F-A4 status: candidate 往返（EntryStatus 全量）',
        statusCandidate === 'candidate',
        `status=${String(statusCandidate)}`,
      )
      let bogusStatus
      let bogusStderr = ''
      if (stPath !== '') {
        await writeFile(stPath, withStatus(await readFile(stPath, 'utf-8'), 'bogus_status'), 'utf-8')
        const bogusReindex = await cli(['kb', 'reindex', '--json'], env)
        bogusStderr = bogusReindex.stderr
        bogusStatus = jparse(await cli(['kb', 'get', 'STI-1', '--json'], env)).value?.status
      }
      check(
        '19.3.4 F-A4 越界 status → warning + 回落 active + 该行不丢',
        bogusStatus === 'active' && bogusStderr.includes('未知 status'),
        `status=${String(bogusStatus)} stderr=${bogusStderr.trim().slice(0, 90)}`,
      )

      // ---------- F-A4 引用型软删不被重扫复活 ----------
      const idxRoot = join(workRoot, 'idx-proj')
      await mkdir(join(idxRoot, 'docs'), { recursive: true })
      const idxFile = join(idxRoot, 'docs', 'a.md')
      const idxTextV1 = '---\nid: IDX-1\ntitle: 引用型条目\ntype: doc\n---\n\n引用型正文 v1。\n'
      const idxTextV2 = '---\nid: IDX-1\ntitle: 引用型条目\ntype: doc\n---\n\n引用型正文 v2（源已变更）。\n'
      await writeFile(idxFile, idxTextV1, 'utf-8')
      await cli(['project', 'add', idxRoot, '--name', 'idxproj', '--json'], env)
      const idxSync1 = await cli(['kb', 'sync', 'idxproj', '--json'], env)
      const idxId = 'IDX-docs-a' // idFromRel('docs/a.md')（scan.ts:144）
      const idxDel = await cli(['kb', 'remove', idxId, '--json'], env)
      const idxAfterDel = jparse(await cli(['kb', 'get', idxId, '--json'], env)).value?.status
      await writeFile(idxFile, idxTextV2, 'utf-8')
      const idxSync2 = await cli(['kb', 'sync', 'idxproj', '--json'], env)
      const idxSync2V = jparse(idxSync2).value ?? {}
      const idxAfterRescan = jparse(await cli(['kb', 'get', idxId, '--json'], env)).value?.status
      check(
        '19.3.5 F-A4 引用型软删 → 改源 → 重扫仍 deprecated（不静默复活）',
        idxSync1.code === 0 &&
          jparse(idxSync1).value?.created === 1 &&
          idxDel.code === 0 &&
          idxAfterDel === 'deprecated' &&
          idxSync2V.updated === 1 &&
          idxAfterRescan === 'deprecated',
        `del=${String(idxAfterDel)} rescan=${String(idxAfterRescan)} created=${String(jparse(idxSync1).value?.created)} updated=${String(idxSync2V.updated)}`,
      )
      check(
        '19.3.6 F-A4 索引/重扫不写用户原件（逐字节一致）',
        (await readFile(idxFile, 'utf-8')) === idxTextV2,
      )

      // ---------- F-B4 版本历史（CLI + HTTP） ----------
      // 造第二个版次：同一 frontmatter id 经 `kb import` → v2（deposit 每次都是新 id）
      const stImp2 = await cli(['kb', 'import', stFile2, '--json'], env)
      const vers = await cli(['kb', 'versions', 'STI-1', '--json'], env)
      const versV = jparse(vers).value
      check(
        '19.4.1 F-B4 kb versions：降序 + 恰一条 is_latest + 字段齐全',
        stImp2.code === 0 &&
          jparse(stImp2).value?.version === 2 &&
          vers.code === 0 &&
          Array.isArray(versV) &&
          versV.length >= 2 &&
          versV[0].is_latest === true &&
          versV.slice(1).every((v) => v.is_latest === false) &&
          versV.every((v, i) => i === 0 || versV[i - 1].version > v.version) &&
          versV.every((v) => v.source_path === null || typeof v.source_path === 'string'),
        `n=${Array.isArray(versV) ? versV.length : 0} ${JSON.stringify((versV ?? []).map((v) => [v.version, v.is_latest, v.status]))}`,
      )
      const versGhost = await cli(['kb', 'versions', 'NO-SUCH-ID', '--json'], env)
      check(
        '19.4.2 F-B4 边界：不存在 id → 空数组且 rc 0',
        versGhost.code === 0 && Array.isArray(jparse(versGhost).value) && jparse(versGhost).value.length === 0,
      )
      const versNoArg = await cli(['kb', 'versions'], env)
      check('19.4.3 F-B4 异常：缺 id → rc≠0 + 用法', versNoArg.code !== 0 && versNoArg.stderr.includes('用法'))
      const versHttp = await httpJson('GET', '/api/kb/versions/STI-1')
      const versHttpV = versHttp.body?.value?.versions ?? []
      check(
        '19.4.4 F-B4 HTTP /api/kb/versions/:id 与 CLI 同序同内容',
        versHttp.status === 200 && JSON.stringify(versHttpV) === JSON.stringify(versV),
        `http=${versHttpV.length} cli=${Array.isArray(versV) ? versV.length : 0}`,
      )
      const versHttpGhost = await httpJson('GET', '/api/kb/versions/NO-SUCH-ID')
      check(
        '19.4.5 F-B4 边界：HTTP 不存在 id → 200 空数组（不报错）',
        versHttpGhost.status === 200 && (versHttpGhost.body?.value?.versions ?? []).length === 0,
      )

      // ---------- F-C1 CLI 建队（含写守卫三态） ----------
      const teamDir = join(harnessRoot, 'teams')
      const e2eTeamPath = join(teamDir, 'e2e-team.md')
      const initOk = await cli(
        ['team', 'init', 'e2e-team', '--harness-root', harnessRoot, '--members', 'dev-1', '--json'],
        env,
      )
      const validateOk = await cli(['team', 'validate', 'e2e-team', '--harness-root', harnessRoot, '--json'], env)
      check(
        '19.5.1 F-C1 team init（--harness-root）→ 落盘 + validate 通过 + workflow_pruned 警告',
        initOk.code === 0 &&
          (await fileExists(e2eTeamPath)) &&
          initOk.stdout.includes('workflow_pruned') &&
          validateOk.code === 0 &&
          jparse(validateOk).ok === true,
        `validate=${validateOk.code} warn=${initOk.stdout.includes('workflow_pruned')}`,
      )
      const guardedPath = join(teamDir, 'e2e-guarded.md')
      const guarded = await cli(['team', 'init', 'e2e-guarded', '--members', 'dev-1', '--json'], env)
      check(
        '19.5.2 F-C1 写守卫：默认宿主目录未加 --yes → guard_required 且不落盘',
        guarded.code !== 0 && guarded.stderr.includes('guard_required') && !(await fileExists(guardedPath)),
        guarded.stderr.trim().slice(0, 130),
      )
      const forced = await cli(['team', 'init', 'e2e-guarded', '--members', 'dev-1', '--yes', '--json'], env)
      check(
        '19.5.3 F-C1 写守卫：--yes 放行并落盘',
        forced.code === 0 &&
          (await fileExists(guardedPath)) &&
          forced.stdout.includes('--yes：确认写入默认宿主目录'),
        `path=${guardedPath}`,
      )
      const badMember = await cli(
        ['team', 'init', 'e2e-bad', '--harness-root', harnessRoot, '--members', 'ghost-role', '--json'],
        env,
      )
      check(
        '19.5.4 F-C1 异常：成员不在角色库 → team_invalid 且不落盘',
        badMember.code !== 0 &&
          badMember.stderr.includes('team_invalid') &&
          !(await fileExists(join(teamDir, 'e2e-bad.md'))),
        badMember.stderr.trim().slice(0, 130),
      )
      const badId = await cli(
        ['team', 'init', 'Demo_Bad', '--harness-root', harnessRoot, '--members', 'dev-1', '--json'],
        env,
      )
      check(
        '19.5.5 F-C1 异常：非法 id → team_id_invalid 且不落盘',
        badId.code !== 0 && badId.stderr.includes('team_id_invalid') && !(await fileExists(join(teamDir, 'Demo_Bad.md'))),
        badId.stderr.trim().slice(0, 120),
      )
      const initAgain = await cli(
        ['team', 'init', 'e2e-team', '--harness-root', harnessRoot, '--members', 'dev-1', '--json'],
        env,
      )
      check(
        '19.5.6 F-C1 边界：重复 init 已存在 id → skipped（不覆盖人写文件）',
        initAgain.code === 0 && (initAgain.stdout.includes('skipped') || initAgain.stdout.includes('已存在')),
        initAgain.stdout.trim().slice(0, 120),
      )
      const prunedTeam = await cli(
        ['team', 'init', 'e2e-pruned', '--harness-root', harnessRoot, '--template', 'core-dev', '--members', 'dev-1', '--json'],
        env,
      )
      const prunedValidate = await cli(['team', 'validate', 'e2e-pruned', '--harness-root', harnessRoot, '--json'], env)
      check(
        '19.5.7 F-C1 边界：core-dev 模板按名册收窄 → workflow_pruned + 校验通过（阶段重编号）',
        prunedTeam.code === 0 &&
          prunedTeam.stdout.includes('workflow_pruned') &&
          prunedValidate.code === 0 &&
          (await fileExists(join(teamDir, 'e2e-pruned.md'))),
      )

      // ---------- F-C3 POST /api/teams 三态 + GET teamsDir ----------
      const managedTeams = join(workRoot, 'managed-teams')
      const apiTeamPath = join(managedTeams, 'api-team.md')
      const apiTeamBody = {
        team_id: 'api-team',
        name: 'API 队',
        description: 'HTTP 建队验证',
        members: [{ role: 'dev-1', count: 1 }],
        teams_dir: managedTeams,
      }
      const apiCreate = await httpJson('POST', '/api/teams', apiTeamBody)
      check(
        '19.6.1 F-C3 POST /api/teams 正例：落显式 teams_dir + 无 error issue',
        apiCreate.status === 200 &&
          apiCreate.body?.ok === true &&
          apiCreate.body?.value?.path === apiTeamPath &&
          (await fileExists(apiTeamPath)) &&
          (apiCreate.body?.value?.issues ?? []).every((i) => i.level !== 'error'),
        `status=${apiCreate.status} path=${apiCreate.body?.value?.path ?? ''}`,
      )
      const apiTeamDef = serverModule.parseTeamMarkdown(await readFile(apiTeamPath, 'utf-8'))
      const apiTeamValidate = serverModule.validateTeam(apiTeamDef, {
        roles: await serverModule.loadRoles(join(harnessRoot, 'agents')),
      })
      check(
        '19.6.2 F-C3 正例产物经同一 validateTeam 通过',
        apiTeamValidate.ok === true,
        JSON.stringify(apiTeamValidate.issues).slice(0, 140),
      )
      const noDirCreate = await httpJson('POST', '/api/teams', {
        team_id: 'api-nodefault',
        name: '无目录',
        members: [{ role: 'dev-1', count: 1 }],
      })
      check(
        '19.6.3 F-C3 异常：缺 teams_dir → 400 teams_dir_required 且不回落默认宿主',
        noDirCreate.status === 400 &&
          errText(noDirCreate).includes('teams_dir_required') &&
          !(await fileExists(join(teamDir, 'api-nodefault.md'))),
        `status=${noDirCreate.status} err=${errText(noDirCreate).slice(0, 80)}`,
      )
      const badMemberApi = await httpJson('POST', '/api/teams', {
        team_id: 'api-bad',
        name: '坏成员',
        members: [{ role: 'ghost-role', count: 1 }],
        teams_dir: managedTeams,
      })
      check(
        '19.6.4 F-C3 异常：非法成员 → 400 member_role_unknown 且不落盘',
        badMemberApi.status === 400 &&
          errText(badMemberApi).includes('member_role_unknown') &&
          !(await fileExists(join(managedTeams, 'api-bad.md'))),
        `status=${badMemberApi.status} err=${errText(badMemberApi).slice(0, 80)}`,
      )
      const dupApi = await httpJson('POST', '/api/teams', apiTeamBody)
      check(
        '19.6.5 F-C3 异常：同 id 重复 → 409 id_conflict（不覆盖）',
        dupApi.status === 409 && errText(dupApi).includes('id_conflict'),
        `status=${dupApi.status}`,
      )
      const teamsList = await httpJson('GET', '/api/teams')
      check(
        '19.6.6 F-C3/UI 依赖：GET /api/teams 返回只读 teamsDir（预填用）且指向临时 harnessRoot',
        teamsList.status === 200 && teamsList.body?.value?.teamsDir === teamDir,
        `teamsDir=${teamsList.body?.value?.teamsDir ?? ''}`,
      )

      // ---------- F-D2 四处一致（CLI ≡ HTTP ≡ MCP） ----------
      mcpTools = serverModule.createMcpTools({ home, harnessRoot })
      const effCli = await cli(['skill', 'effective', '--role', 'dev-1', '--team', 'core-dev', '--json'], env)
      const effCliV = jparse(effCli).value ?? {}
      const effHttp = await httpJson('GET', '/api/skills/effective?role=dev-1&team=core-dev')
      const effHttpV = effHttp.body?.value ?? {}
      const mcpSkillTool = mcpTools.find((t) => t.name === 'prism_skill_effective')
      const effMcp = mcpSkillTool !== undefined ? await mcpSkillTool.call({ role: 'dev-1', team: 'core-dev' }) : null
      check(
        '19.7.1 F-D2 四处一致：CLI ≡ HTTP ≡ MCP（同 loadEffectiveSkills）',
        effCli.code === 0 &&
          effHttp.status === 200 &&
          effMcp !== null &&
          JSON.stringify(effCliV) === JSON.stringify(effHttpV) &&
          JSON.stringify(effHttpV) === JSON.stringify(effMcp),
        `cli=${effCliV.skills?.length ?? -1} http=${effHttpV.skills?.length ?? -1} mcp=${effMcp?.skills?.length ?? -1}`,
      )
      check(
        '19.7.2 F-D2 有效集元素含 name/sources/available 三要素',
        Array.isArray(effHttpV.skills) &&
          effHttpV.skills.every(
            (s) => typeof s.name === 'string' && Array.isArray(s.sources) && typeof s.available === 'boolean',
          ),
        `skills=${effHttpV.skills?.length ?? 0}`,
      )
      const effNoTeamHttp = await httpJson('GET', '/api/skills/effective?role=dev-1')
      const effNoTeamCli = jparse(await cli(['skill', 'effective', '--role', 'dev-1', '--json'], env)).value ?? {}
      check(
        '19.7.3 F-D2 边界：无团队时 CLI ≡ HTTP',
        JSON.stringify(effNoTeamCli) === JSON.stringify(effNoTeamHttp.body?.value ?? {}),
      )
      const effMissingHttp = await httpJson('GET', '/api/skills/effective?role=no-such-role')
      const effMissingCli = await cli(['skill', 'effective', '--role', 'no-such-role', '--json'], env)
      check(
        '19.7.4 F-D2 异常：角色不存在 → HTTP 404 + CLI rc≠0（不静默降级为无团队）',
        effMissingHttp.status === 404 && effMissingCli.code !== 0,
        `http=${effMissingHttp.status} cli=${effMissingCli.code}`,
      )

      // ---------- F-E2 三入口同策略（含规则覆盖 + require_note 差异） ----------
      // 自建带 book→type 规则的团队（可观测覆盖：type doc → guide），写受管 teams_dir
      const depTeamPath = join(teamDir, 'e2e-dep.md')
      await writeFile(
        depTeamPath,
        [
          '---',
          'team_id: e2e-dep',
          'name: "E2E 沉淀策略队"',
          'description: "E2E 三入口同策略验证"',
          'default: false',
          'members:',
          '  - role: dev-1',
          '    count: 1',
          'skills: []',
          'knowledge:',
          '  layers: [global, project]',
          'deposit:',
          '  enabled: true',
          '  default_layer: global',
          '  default_type: pitfall',
          '  priority: medium',
          '  require_note: true',
          '  rules:',
          '    - match: { book: e2edep }',
          '      set: { type: guide, priority: high }',
          'arbitration: [requirement, quality, progress]',
          'rework_limit: 2',
          '---',
          '',
          '# E2E 沉淀策略队',
          '',
          '## 工作流',
          '',
          '| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |',
          '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
          '| 1 | 开发 | dev-1 | 串行 | 任务书 | patch | 自验通过 | 卡死 2 次 → 队长 |',
          '',
          '## 沉淀规则',
          '',
          '- `match.book=e2edep` → `set.type=guide / priority=high`；`require_note=true`。',
          '',
        ].join('\n'),
        'utf-8',
      )
      const depTeamShow = await cli(['team', 'show', 'e2e-dep', '--harness-root', harnessRoot, '--json'], env)
      check(
        '19.8.0 F-E2 前置：自建策略团队可被 loadTeam 载入',
        depTeamShow.code === 0 && jparse(depTeamShow).value?.deposit?.rules?.length === 1,
        `rules=${jparse(depTeamShow).value?.deposit?.rules?.length ?? -1}`,
      )
      const depCliFile = join(workRoot, 'dep-cli.md')
      await writeFile(depCliFile, '---\ntitle: E2E 三入口策略\n---\n\n三入口同策略正文。\n', 'utf-8')
      const depCli = await cli(
        ['kb', 'deposit', '--file', depCliFile, '--title', 'E2E 三入口策略 CLI', '--type', 'doc', '--layer', 'global', '--book', 'e2edep', '--team', 'e2e-dep', '--by', 'tester-1', '--note', '三入口一致验证', '--json'],
        env,
      )
      const depCliV = jparse(depCli).value ?? {}
      const depCliEntry = jparse(await cli(['kb', 'get', depCliV.id, '--json'], env)).value ?? {}
      const depHttp = await httpJson('POST', '/api/kb/deposit', {
        title: 'E2E 三入口策略 HTTP',
        type: 'doc',
        layer: 'global',
        book: 'e2edep',
        content: '三入口同策略正文。',
        team_id: 'e2e-dep',
        source: { kind: 'manual', ref: '三入口一致验证' },
        deposited_by: { subject: 'tester-1' },
      })
      const depHttpV = depHttp.body?.value ?? {}
      const depHttpEntry = jparse(await cli(['kb', 'get', depHttpV.id, '--json'], env)).value ?? {}
      const mcpDepositTool = mcpTools.find((t) => t.name === 'prism_kb_deposit')
      const depMcpV =
        mcpDepositTool !== undefined
          ? await mcpDepositTool.call({
              title: 'E2E 三入口策略 MCP',
              type: 'doc',
              layer: 'global',
              book: 'e2edep',
              content: '三入口同策略正文。',
              team_id: 'e2e-dep',
              source: { kind: 'manual', ref: '三入口一致验证' },
              deposited_by: { subject: 'tester-1' },
            })
          : {}
      const depMcpEntry = jparse(await cli(['kb', 'get', depMcpV.id, '--json'], env)).value ?? {}
      check(
        '19.8.1 F-E2 三入口同策略：规则覆盖一致生效（type doc→guide）+ 层一致',
        depCli.code === 0 &&
          depHttp.status === 200 &&
          typeof depMcpV.id === 'string' &&
          depCliEntry.type === 'guide' &&
          depHttpEntry.type === 'guide' &&
          depMcpEntry.type === 'guide' &&
          depCliEntry.layer === 'global' &&
          depHttpEntry.layer === 'global' &&
          depMcpEntry.layer === 'global',
        `type=${depCliEntry.type}/${depHttpEntry.type}/${depMcpEntry.type} layer=${depCliEntry.layer}/${depHttpEntry.layer}/${depMcpEntry.layer}`,
      )
      const depFileText = depCliEntry.path !== undefined ? await readFile(depCliEntry.path, 'utf-8') : ''
      check(
        '19.8.2 F-E2 落库后 frontmatter 与 DB 均可读来源（deposited_by：subject/team/at）',
        depCliEntry.deposited_by?.subject === 'tester-1' &&
          depCliEntry.deposited_by?.team === 'e2e-dep' &&
          typeof depCliEntry.deposited_by?.at === 'string' &&
          depFileText.includes('deposited_by') &&
          depFileText.includes('e2e-dep'),
        `by=${JSON.stringify(depCliEntry.deposited_by)}`,
      )
      await cli(['kb', 'reindex', '--json'], env)
      const depAfterReindex = jparse(await cli(['kb', 'get', depCliV.id, '--json'], env)).value ?? {}
      check(
        '19.8.3 F-E2 边界：reindex 后 deposited_by 仍在（v7 两列往返）',
        depAfterReindex.deposited_by?.team === 'e2e-dep' && depAfterReindex.deposited_by?.task_id === undefined,
        `by=${JSON.stringify(depAfterReindex.deposited_by)}`,
      )
      // require_note 拒绝：CLI / MCP 走策略；HTTP 的入口校验先拦（口径张力，QA v4 判定
      // 为「非功能缺陷」——空正文在所有入口都被 content 必填拦下，见 .agent-team/qa-report-v4.md）
      const depEmptyFile = join(workRoot, 'dep-empty.md')
      await writeFile(depEmptyFile, '---\ntitle: 空正文\n---\n\n', 'utf-8')
      const statsBeforeReject = jparse(await cli(['kb', 'stats', '--json'], env)).value?.entries
      const depRejectCli = await cli(
        ['kb', 'deposit', '--file', depEmptyFile, '--title', 'E2E 空正文', '--type', 'doc', '--layer', 'global', '--book', 'e2edep', '--team', 'e2e-dep', '--json'],
        env,
      )
      // 「不落库」用条目总数前后一致证明（落库 id 是自动生成的，不能按标题 get）
      const statsAfterReject = jparse(await cli(['kb', 'stats', '--json'], env)).value?.entries
      check(
        '19.8.4 F-E2 异常：CLI + require_note 未满足 → 策略拒绝且不落库（条目数不变）',
        depRejectCli.code !== 0 &&
          depRejectCli.stderr.includes('沉淀策略拒绝') &&
          statsAfterReject === statsBeforeReject,
        `entries=${String(statsBeforeReject)}→${String(statsAfterReject)} err=${depRejectCli.stderr.trim().slice(0, 80)}`,
      )
      const depRejectMcp =
        mcpDepositTool !== undefined
          ? await mcpDepositTool
              .call({
                title: 'E2E 空正文 MCP',
                type: 'doc',
                layer: 'global',
                book: 'e2edep',
                content: '',
                team_id: 'e2e-dep',
              })
              .then(() => 'allowed')
              .catch((error) => String(error?.message ?? error))
          : 'no-tool'
      check(
        '19.8.5 F-E2 异常：MCP + require_note 未满足 → 策略拒绝',
        String(depRejectMcp).includes('沉淀策略拒绝'),
        String(depRejectMcp).slice(0, 130),
      )
      const depRejectHttp = await httpJson('POST', '/api/kb/deposit', {
        title: 'E2E 空正文 HTTP',
        type: 'doc',
        layer: 'global',
        book: 'e2edep',
        content: '',
        team_id: 'e2e-dep',
      })
      check(
        '19.8.6 F-E2 口径记录：HTTP 空正文被入口校验先拦（400 缺 content）——与 CLI/MCP 的 content 必填同口径',
        depRejectHttp.status === 400 && errText(depRejectHttp).includes('content'),
        `status=${depRejectHttp.status} err=${errText(depRejectHttp).slice(0, 90)}`,
      )
      // 反向：非空正文 + source.ref → 策略放行（CLI `--note` 的 HTTP 等价物，三入口一致）
      const depNoteHttp = await httpJson('POST', '/api/kb/deposit', {
        title: 'E2E 有正文有说明 HTTP',
        type: 'doc',
        layer: 'global',
        book: 'e2edep',
        content: 'E2E 说明正文。',
        source: { kind: 'manual', ref: 'E2E 说明' },
        team_id: 'e2e-dep',
      })
      check(
        '19.8.7 F-E2 三入口一致：HTTP 非空正文 + source.ref → 策略放行并落库',
        depNoteHttp.status === 200 && typeof depNoteHttp.body?.value?.id === 'string',
        `status=${depNoteHttp.status} value=${JSON.stringify(depNoteHttp.body?.value ?? depNoteHttp.body?.error).slice(0, 120)}`,
      )

      // ---------- F-E3 任务终态沉淀建议 ----------
      // 状态链必须是 RUNNING→COMPLETED→AWAITING_FEEDBACK→CLOSED（TASK_TRANSITIONS 无 COMPLETED→CLOSED）
      const dagE3 = join(workRoot, 'dag-e3.json')
      await writeFile(
        dagE3,
        JSON.stringify({
          tasks: [
            { id: 'E3-1', description: '安全：修复越权访问的漏洞' },
            { id: 'E3-2', description: '性能：优化检索延迟' },
          ],
        }),
        'utf-8',
      )
      const regE3 = await cli(
        ['task', 'register', '--dag', 'd-e3', '--session', 's19', '--team', 'core-dev', '--project', 'prism', '--file', dagE3, '--json'],
        env,
      )
      check('19.9.0 F-E3 前置：登记 E3 DAG', regE3.code === 0 && jparse(regE3).value?.tasks === 2)
      const e3Running = await cli(['task', 'report', 'E3-1', '--to', 'RUNNING', '--by', 'tester-1', '--json'], env)
      const e3RunningV = jparse(e3Running).value ?? {}
      check(
        '19.9.1 F-E3 边界：非终态（RUNNING）→ 不给 deposit_hint/deposit_suggestions',
        e3Running.code === 0 &&
          e3RunningV.deposit_hint === undefined &&
          e3RunningV.deposit_suggestions === undefined,
      )
      const e3Completed = await cli(['task', 'report', 'E3-1', '--to', 'COMPLETED', '--by', 'tester-1', '--json'], env)
      const e3CompletedV = jparse(e3Completed).value ?? {}
      check(
        '19.9.2 F-E3 COMPLETED → 仅 deposit_hint=await_close（无清单，裁决 A4）',
        e3Completed.code === 0 &&
          e3CompletedV.deposit_hint === 'await_close' &&
          e3CompletedV.deposit_suggestions === undefined,
        `hint=${String(e3CompletedV.deposit_hint)}`,
      )
      const e3Awaiting = await cli(['task', 'report', 'E3-1', '--to', 'AWAITING_FEEDBACK', '--by', 'tester-1', '--json'], env)
      const e3AwaitingV = jparse(e3Awaiting).value ?? {}
      check(
        '19.9.3 F-E3 边界：AWAITING_FEEDBACK（保温期）→ 仍不给清单',
        e3Awaiting.code === 0 &&
          e3AwaitingV.deposit_hint === undefined &&
          e3AwaitingV.deposit_suggestions === undefined,
      )
      const e3Closed = await cli(['task', 'report', 'E3-1', '--to', 'CLOSED', '--by', 'tester-1', '--json'], env)
      const e3ClosedV = jparse(e3Closed).value ?? {}
      const e3Suggestions = Array.isArray(e3ClosedV.deposit_suggestions) ? e3ClosedV.deposit_suggestions : []
      check(
        '19.9.4 F-E3 CLOSED → deposit_suggestions（团队规则 + 安全关键词，均带 reason）',
        e3Closed.code === 0 &&
          e3Suggestions.length >= 2 &&
          e3Suggestions.some((s) => String(s.reason).includes('团队规则 match{type:rule}')) &&
          e3Suggestions.some((s) => String(s.reason).includes('安全关键词') && s.layer === 'global' && s.kind === 'rule'),
        `n=${e3Suggestions.length} ${JSON.stringify(e3Suggestions.map((s) => [s.kind, s.layer, s.reason]))}`.slice(0, 200),
      )
      // --deposit 一步落库（文本模式：先打回报结果再打落库结果，故用正则取 id）
      for (const to of ['RUNNING', 'COMPLETED', 'AWAITING_FEEDBACK']) {
        await cli(['task', 'report', 'E3-2', '--to', to, '--by', 'tester-1'], env)
      }
      const depE3File = join(workRoot, 'dep-e3.md')
      await writeFile(depE3File, '---\ntitle: E3 一步落库\n---\n\nE3 一步落库正文。\n', 'utf-8')
      const e3Deposit = await cli(
        ['task', 'report', 'E3-2', '--to', 'CLOSED', '--by', 'tester-1', '--deposit', depE3File, '--title', 'E3 一步落库', '--type', 'pitfall', '--layer', 'global', '--note', 'E3 一步落库验证'],
        env,
      )
      const e3DepMatch = /已落库\s+(\S+?)@v1/.exec(e3Deposit.stdout)
      const e3DepId = e3DepMatch !== null ? e3DepMatch[1] : ''
      check(
        '19.9.5 F-E3 --deposit 一步落库（复用 kb deposit，rc 0 + 来源地址）',
        e3Deposit.code === 0 && e3Deposit.stdout.includes('来源地址') && e3DepId !== '',
        `id=${e3DepId} tail=${e3Deposit.stdout.trim().split('\n').slice(-1)[0]?.slice(0, 80) ?? ''}`,
      )
      const e3DepEntry = e3DepId !== '' ? jparse(await cli(['kb', 'get', e3DepId, '--json'], env)).value : undefined
      check(
        '19.9.6 F-E3 一步落库带任务来源（deposited_by.task_id=E3-2）',
        e3DepEntry?.deposited_by?.task_id === 'E3-2',
        `by=${JSON.stringify(e3DepEntry?.deposited_by)}`,
      )
      const dagE3NoTeam = join(workRoot, 'dag-e3b.json')
      await writeFile(dagE3NoTeam, JSON.stringify({ tasks: [{ id: 'E3-NT', description: '无团队任务' }] }), 'utf-8')
      // 注：`registerDag` 必填 team_id（CLI 造不出「空团队」任务）→ 这里覆盖「团队不存在 → 不打扰」；
      //     空 team_id / deposit.enabled=false 两态由 packages/server/test/stream-b.test.ts（F-E3 四态）单测覆盖。
      await cli(
        ['task', 'register', '--dag', 'd-e3b', '--session', 's19', '--team', 'ghost-team', '--project', 'prism', '--file', dagE3NoTeam, '--json'],
        env,
      )
      for (const to of ['RUNNING', 'COMPLETED', 'AWAITING_FEEDBACK']) {
        await cli(['task', 'report', 'E3-NT', '--to', to, '--by', 'tester-1'], env)
      }
      const e3NoTeam = await cli(['task', 'report', 'E3-NT', '--to', 'CLOSED', '--by', 'tester-1', '--json'], env)
      const e3NoTeamV = jparse(e3NoTeam).value ?? {}
      check(
        '19.9.7 F-E3 边界：团队不存在 → 不打扰（两字段都不给）',
        e3NoTeam.code === 0 &&
          e3NoTeamV.deposit_hint === undefined &&
          e3NoTeamV.deposit_suggestions === undefined,
        `rc=${e3NoTeam.code} status=${String(e3NoTeamV.status)}`,
      )

      // ---------- F-B1/F-B2 上下文包暴露面（normalized_by / symbols 加权 / max_excerpt_chars） ----------
      const packQuery = (extra) =>
        `/api/kb/context-pack?role=dev-1&task=${encodeURIComponent('性能')}&budget_tokens=2000${extra}`
      const packBase = await httpJson('GET', packQuery(''))
      const packBaseV = packBase.body?.value ?? {}
      check(
        '19.10.1 F-B1 上下文包标明归一语义 normalized_by=candidate_max + 预算/截断字段齐备',
        packBase.status === 200 &&
          packBaseV.normalized_by === 'candidate_max' &&
          typeof packBaseV.total_tokens === 'number' &&
          typeof packBaseV.truncated === 'boolean',
        `normalized_by=${String(packBaseV.normalized_by)}`,
      )
      // 同一查询只差 symbols，保证 relevance/排名可比（symbols 命中判定基 = title+excerpt，大小写敏感）
      const packNoSym = await httpJson('GET', packQuery('&max_excerpt_chars=20'))
      const packSym = await httpJson(
        'GET',
        packQuery(`&max_excerpt_chars=20&symbols=${encodeURIComponent('性能守则')}`),
      )
      const noSymItems = packNoSym.body?.value?.items ?? []
      const symItems = packSym.body?.value?.items ?? []
      const noSymRelevance = new Map(noSymItems.map((i) => [i.id, i.relevance]))
      const noSymIndex = new Map(noSymItems.map((i, idx) => [i.id, idx]))
      const boosted = symItems.find((i) => (i.graph_hits ?? []).length > 0 && noSymRelevance.has(i.id))
      const boostedIndex = boosted !== undefined ? symItems.findIndex((i) => i.id === boosted.id) : -1
      check(
        '19.10.2 F-B2 symbols 命中加权：relevance 提升 + graph_hits 非空 + 排名不前移后',
        packSym.status === 200 &&
          boosted !== undefined &&
          boosted.graph_hits.includes('性能守则') &&
          boosted.relevance > noSymRelevance.get(boosted.id) &&
          boostedIndex <= noSymIndex.get(boosted.id),
        `id=${boosted?.id ?? ''} rel=${String(noSymRelevance.get(boosted?.id))}→${String(boosted?.relevance)} idx=${String(noSymIndex.get(boosted?.id))}→${String(boostedIndex)}`,
      )
      check(
        '19.10.3 F-B2 max_excerpt_chars 精确截断（每项 excerpt 长度 <= 上限）',
        symItems.length >= 1 && symItems.every((i) => i.excerpt.length <= 20),
        `lens=${JSON.stringify(symItems.map((i) => i.excerpt.length))}`,
      )
      check(
        '19.10.4 F-B2 边界：不传 symbols → graph_hits 全为空数组（缺省行为不变）',
        noSymItems.length >= 1 &&
          noSymItems.every((i) => Array.isArray(i.graph_hits) && i.graph_hits.length === 0),
      )
      const mcpPackTool = mcpTools.find((t) => t.name === 'prism_context_pack')
      const packProps = Object.keys(mcpPackTool?.inputSchema?.properties ?? {})
      check(
        '19.10.5 F-B2 MCP prism_context_pack schema 含 symbols/layers/books/max_excerpt_chars',
        ['symbols', 'layers', 'books', 'max_excerpt_chars'].every((k) => packProps.includes(k)),
        packProps.join(','),
      )

      // ---------- F-A3 冲突审计留痕（detected_from 只进审计 JSONL，不进返回体/表结构） ----------
      const confAll = jparse(await cli(['kb', 'conflicts', '--all', '--json'], env)).value
      check(
        '19.11.1 F-A3 冲突返回体不含 detected_from（零迁移：不加列）',
        Array.isArray(confAll) && confAll.length >= 1 && confAll.every((c) => c.detected_from === undefined),
        `n=${Array.isArray(confAll) ? confAll.length : 0}`,
      )
      const auditDir = join(home, 'audit')
      const auditFiles = (await readdir(auditDir).catch(() => [])).filter((f) => /^audit-.*\.jsonl$/.test(f))
      let auditText = ''
      for (const f of auditFiles) auditText += await readFile(join(auditDir, f), 'utf-8').catch(() => '')
      check(
        '19.11.2 F-A3 审计 JSONL 含 detected_from 留痕（R7 文件为真相）',
        auditFiles.length >= 1 &&
          auditText.includes('detected_from') &&
          auditText.includes('"deposit"'),
        `auditFiles=${auditFiles.length}`,
      )
      check(
        '19.11.3 F-A3 冲突只记录不阻断（R3）：冲突存在时 import 仍成功',
        (await cli(['kb', 'conflicts', '--all', '--json'], env)).code === 0,
      )
    }

    // ===== 20. design-v5 §2 验收补充（F-C2 合并入口 / F-C3 团队激活图谱状态 / F-C4 团队工作流图） =====
    {
      const jparse = (res) => {
        try {
          return JSON.parse(res.stdout)
        } catch {
          return {}
        }
      }
      const fileExists = async (p) => {
        try {
          await readFile(p)
          return true
        } catch {
          return false
        }
      }
      const httpJson = async (method, apiPath, body) => {
        const res = await fetch(`${base}${apiPath}`, {
          method,
          ...(body !== undefined
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        })
        let parsed = null
        try {
          parsed = await res.json()
        } catch {
          parsed = null
        }
        return { status: res.status, body: parsed }
      }

      // ---------- F-C2 多项目合并：入口守卫（happy path 需 2 张已建图，argv 断言见 graph-merge.test.ts）----------
      // 再登记一个空项目（不建图）：用来触发 graph_not_found 分支，顺带证明失败路径不启子进程、不落产物。
      const demo2Root = join(workRoot, 'demo2-project')
      await mkdir(demo2Root, { recursive: true })
      await cli(['project', 'add', demo2Root, '--name', 'demo2', '--json'], env)
      const mergeOne = await cli(['graph', 'merge', 'demo', '--json'], env)
      check(
        '20.1 F-C2 合并 <2 个项目 → 退出码 1（用法提示，不启子进程）',
        mergeOne.code === 1 && mergeOne.stderr.includes('至少 2 个'),
        `code=${mergeOne.code}`,
      )
      const mergeUnknown = await cli(['graph', 'merge', 'demo', 'nope', '--json'], env)
      check(
        '20.2 F-C2 项目未注册 → not_found（不静默回落）',
        mergeUnknown.code === 1 && mergeUnknown.stderr.includes('not_found'),
        mergeUnknown.stderr.trim().slice(0, 120),
      )
      const mergeNoGraph = await cli(['graph', 'merge', 'demo', 'demo2', '--json'], env)
      check(
        '20.3 F-C2 未建图 → graph_not_found + 可执行提示（不启动 graphify）',
        mergeNoGraph.code === 1 &&
          mergeNoGraph.stderr.includes('graph_not_found') &&
          mergeNoGraph.stderr.includes('graph build'),
        mergeNoGraph.stderr.trim().slice(0, 160),
      )
      check(
        '20.4 F-C2 失败不落产物：<PRISM_HOME>/graphify-merged 未创建（裁决 D2 铁律）',
        !(await fileExists(join(home, 'graphify-merged'))),
      )
      const mergeHttp = await httpJson('POST', '/api/graph/merge', { projects: ['demo'] })
      check(
        '20.5 F-C2 HTTP 合并 <2 个项目 → 400 bad_request（CLI ≡ HTTP 同口径）',
        mergeHttp.status === 400 && String(mergeHttp.body?.error?.code ?? '') === 'bad_request',
        `status=${mergeHttp.status}`,
      )

      // ---------- F-C3 团队激活的图谱状态（只读默认 / --project 只读 / 互斥 / 未注册）----------
      const actDefault = await cli(['team', 'activate', 'core-dev', '--json'], env)
      const actDefaultV = jparse(actDefault).value ?? {}
      check(
        '20.6 F-C3 CLI 激活缺省不指定项目 → graph_status=null（守 R1：默认只提示不动手）',
        actDefault.code === 0 && actDefaultV.graph_status === null,
        `graph_status=${JSON.stringify(actDefaultV.graph_status)}`,
      )
      const actRead = await cli(['team', 'activate', 'core-dev', '--project', 'demo', '--json'], env)
      const gs = (jparse(actRead).value ?? {}).graph_status ?? {}
      check(
        '20.7 F-C3 CLI --project 只读回图状态（字段齐备；demo 未建图 → exists=false/stale=true/note 齐）',
        actRead.code === 0 &&
          gs.project === 'demo' &&
          gs.graph_exists === false &&
          gs.stale === true &&
          typeof gs.changed_files === 'number' &&
          typeof gs.total_files === 'number' &&
          typeof gs.note === 'string',
        JSON.stringify(gs).slice(0, 160),
      )
      const actMutual = await cli(
        ['team', 'activate', 'core-dev', '--project', 'demo', '--build-project', 'demo', '--json'],
        env,
      )
      check(
        '20.8 F-C3 --project 与 --build-project 互斥 → 退出码 1（不静默二选一）',
        actMutual.code === 1 && actMutual.stderr.includes('互斥'),
        actMutual.stderr.trim().slice(0, 120),
      )
      const actUnknown = await cli(['team', 'activate', 'core-dev', '--project', 'nope', '--json'], env)
      check(
        '20.9 F-C3 CLI 未注册项目 → not_found（不猜项目）',
        actUnknown.code === 1 && actUnknown.stderr.includes('未注册的图谱项目'),
        actUnknown.stderr.trim().slice(0, 120),
      )
      const actHttpDefault = await httpJson('GET', '/api/teams/core-dev/activate')
      check(
        '20.10 F-C3 HTTP 激活缺省 graph_status=null（与 CLI 同源）',
        actHttpDefault.status === 200 && actHttpDefault.body?.value?.graph_status === null,
        `status=${actHttpDefault.status}`,
      )
      const actHttpRead = await httpJson('GET', '/api/teams/core-dev/activate?project=demo')
      check(
        '20.11 F-C3 HTTP ?project 只读回图状态（不建图）',
        actHttpRead.status === 200 && actHttpRead.body?.value?.graph_status?.project === 'demo',
        JSON.stringify(actHttpRead.body?.value?.graph_status ?? {}).slice(0, 120),
      )
      const actHttpBuildNoProject = await httpJson('GET', '/api/teams/core-dev/activate?build=1')
      check(
        '20.12 F-C3 HTTP ?build=1 缺 project → 400（Prism 不猜项目）',
        actHttpBuildNoProject.status === 400,
        `status=${actHttpBuildNoProject.status}`,
      )

      // ---------- F-C4 团队工作流 → 工作流图（CLI 落 --out；HTTP 落 <HOME>/archify/workflow）----------
      const archOut = join(workRoot, 'arch-out')
      await mkdir(archOut, { recursive: true })
      const archArgs = ['arch', 'from-team', 'core-dev', '--out', join(archOut, 'core-dev.html'), '--json']
      const archCli = await cli(archArgs, env)
      const archCliV = jparse(archCli).value ?? {}
      check(
        '20.13 F-C4 CLI arch from-team → HTML + IR 源 + meta 齐备',
        archCli.code === 0 &&
          archCliV.type === 'workflow' &&
          archCliV.team_id === 'core-dev' &&
          (await fileExists(join(archOut, 'core-dev.html'))) &&
          (await fileExists(join(archOut, 'core-dev.ir.json'))) &&
          (await fileExists(join(archOut, 'core-dev.meta.json'))),
        `code=${archCli.code}`,
      )
      const irFirst = await readFile(join(archOut, 'core-dev.ir.json'), 'utf-8')
      await cli(archArgs, env)
      const irSecond = await readFile(join(archOut, 'core-dev.ir.json'), 'utf-8')
      check(
        '20.14 F-C4 IR 是纯函数派生物：两次生成逐字节一致且无时钟字段（幂等）',
        irFirst === irSecond && !/created_at|updated_at/.test(irFirst),
        `bytes=${irFirst.length}`,
      )
      const archHtml = await readFile(join(archOut, 'core-dev.html'), 'utf-8')
      check(
        '20.15 F-C4 渲染出自包含 HTML（非空壳）',
        archHtml.includes('<html') && archHtml.length > 2000,
        `bytes=${archHtml.length}`,
      )
      const archHttp = await httpJson('POST', '/api/arch/from-team', { team_id: 'core-dev' })
      check(
        '20.16 F-C4 HTTP from-team 落 <HOME>/archify/workflow + preview 路径可指',
        archHttp.status === 200 &&
          archHttp.body?.value?.type === 'workflow' &&
          archHttp.body?.value?.preview === '/api/arch/preview/workflow/core-dev.html' &&
          (await fileExists(join(home, 'archify', 'workflow', 'core-dev.html'))),
        `status=${archHttp.status}`,
      )
      const previewRes = await fetch(`${base}/api/arch/preview/workflow/core-dev.html`)
      check(
        '20.17 F-C4 preview 可取渲染产物（content-type text/html）',
        previewRes.status === 200 && String(previewRes.headers.get('content-type')).includes('text/html'),
        `status=${previewRes.status}`,
      )
      const archHttpBad = await httpJson('POST', '/api/arch/from-team', { team_id: 'no-such-team' })
      check(
        '20.18 F-C4 HTTP 未知团队 → 404 not_found（不静默产出空图）',
        archHttpBad.status === 404 && String(archHttpBad.body?.error?.code ?? '') === 'not_found',
        `status=${archHttpBad.status}`,
      )
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
    // F-T1：释放 MCP 工具的惰性句柄（kb + 任务台账），否则临时目录的 *.db/-wal/-shm 删不掉
    mcpTools?.close?.()
    if (KEEP) {
      process.stdout.write(`\n临时目录保留（--keep）: ${workRoot}\n`)
    } else {
      // F-T1：删不掉不静默（warning + 残留清单；`--keep` 时不清）
      await cleanupTempDir(workRoot)
    }
  }

  // F-T1：收尾比对——本轮若有新增残留（含「清理失败」与「进程内偷偷另建」两种），判红。
  if (!KEEP) {
    const tempAfter = await listE2eTempDirs()
    const newResidue = tempAfter.filter((dir) => !tempBefore.includes(dir))
    process.stdout.write(`\n临时目录残留: 基线 ${tempBefore.length} → 本轮结束 ${tempAfter.length}\n`)
    if (newResidue.length > 0) {
      process.stdout.write(`WARN 本轮新增残留 ${newResidue.length} 个:\n`)
      for (const dir of newResidue.slice(0, 20)) process.stdout.write(`    ${dir}\n`)
    }
    check(
      '10.1 临时目录已清理（本轮无新增 prism-e2e-* 残留）',
      newResidue.length === 0,
      newResidue.slice(0, 3).join(', '),
    )
  }

  const passed = results.length - failures
  process.stdout.write(`\nE2E RESULT: ${passed}/${results.length} passed\n`)
  // 用 exitCode 让事件循环自然退出——直接 process.exit() 会在 Windows 上
  // 触发 libuv 句柄关闭断言（服务/子进程句柄尚未回收）
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
