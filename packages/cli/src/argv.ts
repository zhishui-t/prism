import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import { parseArgs } from 'node:util'

import { prismHome, type PrismPersistence } from '@prism/core'
import { ensureHarnessPluginsLoaded, resolveDirsFromHome, type ResolvedDirs } from '@prism/agents'
import { applyEmbeddingConfig } from '@prism/server'
import type { BuildRunner, KnowledgeService } from '@prism/server'
import { runInit } from './commands/init.js'
import { runServe } from './commands/serve.js'
import { runDoctor } from './commands/doctor.js'
import { runEmbedding } from './commands/embedding.js'
import { runKb } from './commands/kb.js'
import { runTask } from './commands/task.js'
import { runArch } from './commands/arch.js'
import { runHarness } from './commands/harness.js'
import { runGraph } from './commands/graph.js'
import { runProject } from './commands/project.js'
import { runInject } from './commands/inject.js'
import { runAudit } from './commands/audit.js'
import { runRole } from './commands/role.js'
import { runTeam } from './commands/team.js'
import { runSkill } from './commands/skill.js'

/** CLI 命令上下文（可注入，便于测试）。 */
export interface CommandContext {
  /** 输出流（默认 process.stdout.write + \n） */
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** --home 覆盖 PRISM_HOME */
  home?: string
  /** --json 机器可读输出 */
  json: boolean
  /** 注入知识服务工厂（测试用；缺省运行时经 @prism/knowledge 装载） */
  kbFactory?: () => Promise<KnowledgeService>
  /** 注入建图执行体（测试用） */
  buildRunner?: BuildRunner
  /** graphify 环境覆盖（测试用） */
  graphifyEnv?: NodeJS.ProcessEnv
  /** 注入持久化（测试用；缺省按 home 打开，随命令关闭） */
  persistence?: PrismPersistence
  /**
   * stdin 读取（`--file -` 用；测试可注入）。
   * 缺省读 fd 0（同步一次读完，命令结束后进程即退出）。
   */
  readStdin?: () => Promise<string>
}

export const USAGE = `prism — 企业级智能研发效能平台 CLI

用法：
  prism --version
  prism init [--home <PRISM_HOME>] [--harness-root <路径>] [--force]   接入初始化（五步）
  prism serve [--port 7777] [--host <h>]   启动 HTTP 服务（控制台 + API）
  prism doctor [--port 7777]               环境自检
  prism role list [--source <dir>]         列出角色（默认 roles_dir，见下）
  prism role show <name>                   查看角色定义
  prism role init <name> [--force]         从模板创建角色到 roles_dir（新命令）
  prism role import [--from <dir>] [--to <dir>]   从宿主 agents 目录导入（默认 --from <harness 根>/agents，--to roles_dir）
  prism role validate [--source <dir>]     校验角色定义
  prism role render <name> [--model --thought-level]   渲染为当前 harness 原生格式（预览，不写盘）
  prism role install <name...> [--source <dir>] [--force]   角色（源≠roles_dir 时）初始化/迁移到 roles_dir
  prism team list | show <id> | validate <id>
  prism team init <id> [--from <team>|--members <role[:n],...>] [--name <名>] [--description <述>] [--template minimal|core-dev] [--harness-root <dir>|--yes]
                                           从模板/既有团队脚手架建新团队（自动校验，error 不落盘）
  prism team install <id> [--force]        校验团队与成员；确保团队定义在 teams_dir（旧源目录一次性迁移）
  prism team activate <id>
  prism skill list | install | update | uninstall | validate [name...] [--force]
  prism skill effective --role <r> [--team <t>] [--json]
                                           角色（可选绑定团队）的生效 Skill 集（global∪team∪role + 缺失告警）

目录解析（装配语义简化——角色/团队/Skill 直接住在宿主目录）：
  <PRISM_HOME>/prism.yaml 可选覆盖：roles_dir / teams_dir / skills_dir；
  缺省落点由**激活的 harness 适配器**自述（ZCode 为 ~/.zcode/{agents,teams,skills}）。
  --harness-root 覆盖 harness 根（--zcode-dir 兼容旧名）。
  prism kb import <file.md> [--layer --owner --book --module]
  prism kb sync <项目名|项目根> [--owner --book --module] [--dry-run]   扫描项目文档建引用索引
  prism kb search <query> [--layer --book --limit]
  prism kb get <id[@version]>
  prism kb tree [--layer]
  prism kb stats
  prism kb graph [id] [--depth 1] [--limit 50] [--relations references,overrides]   图谱邻域/概览
  prism kb path <from> <to> [--relations ...]                                      两节点最短路径
  prism kb export [--format html|obsidian|svg|graphml|wiki]                          知识图谱导出（借 Graphify）
  prism kb convert <file> [--out <path>] [--max-chars N]                             文档转 Markdown（anydoc，零 LLM）
  prism kb enrich <kind> --payload <json> --result <json> [--by <who>]               回写富化结果（摘要/标签/实体）
  prism kb remove <id> [--hard --yes]     软删（默认置 deprecated）；硬删需 --hard 且无引用
  prism kb restore <id>                   恢复软删条目（deprecated → active）
  prism kb conflicts [--all]              层间冲突列表（默认未处理）
  prism kb resolve <conflict-id>          标记冲突已处理
  prism kb versions <id> [--json]         条目全部版次（降序 + is_latest）
  prism kb structure <show|generate|freeze> --layer <l> --book <b> [--modules a,b] [--confirmed-by x] [--note s]
                                          书结构：show 读合并清单（父链在前）/ generate 产 _modules.yaml + _summary.md / freeze 固化
  prism kb deposit --file <md|-> --title <t> --type <ty> [--layer --owner --book --module --team --by --task --note --tags]
                                          落库（--team 走团队沉淀策略；--file - 读 stdin）
  prism kb reindex                        以文件为真相重建索引（手工改过知识文件后用）
  prism task list [--dag --status]        任务台账（被动记录，不驱动）
  prism task show <task-id> | graph <dag-id> | stats
  prism task register --dag <id> --file <dag.json> --session --team --project
  prism task report <task-id> --to <STATUS> --by <who> [--from --revision] [--deposit <md|->]
                                          CLOSED 时给沉淀建议清单；COMPLETED 仅提示待收口
  prism arch types | validate <type> <ir.json> | render <type> <ir.json> [--out <html>]
  prism audit query [--type ...] [--task/--request/--knowledge/--session <id>] [--limit N]
  prism harness list | show               运行时宿主适配器（prism.yaml: harness 键）
  prism graph build <项目根目录> [--name <项目名>] [--incremental] [--timeout <秒>]
  prism graph merge <项目名> <项目名> [...] [--out-dir <目录>]   多项目合并（缺省落 <PRISM_HOME>/graphify-merged/）
  prism graph query <q> --project <项目名>                  BFS 遍历查询
  prism graph path <from> <to> --project <项目名>            最短路径
  prism graph explain <node> --project <项目名>              节点解释
  prism graph affected <node> [--depth N] --project <项目名>  变更影响面
  prism graph god-nodes [--top N] --project <项目名>         枢纽节点
  prism graph summary --project <项目名>                     图谱规模统计
  prism graph export <格式> --project <项目名>               导出（obsidian/wiki/svg/graphml/…）
  prism graph status <项目名>
  prism inject <项目根> [--team <团队id>] [--remove]  把 Prism 指引写进项目 AGENTS.md 标记块
  prism project add <项目根目录> [--name <项目名>]   登记项目台账（不建图、不扫描）
  prism project list | show <名> | remove <名> [--yes]
  prism embedding status | install | start | stop | reindex   本地向量化（BGE-M3，Prism 自理）

全局：--home <path>  --json  --harness-root <path>（role/team/skill/install 类统一收宿主根，~ 自动展开；--zcode-dir 为兼容旧名）
      --yes   确认写入默认宿主目录（写守卫；默认链写入无 --yes 会被阻止，B6）`

/** 全部子命令接受的选项（并集；strict:false 容忍未知项）。 */
const CLI_OPTIONS = {
  home: { type: 'string', short: 'H' },
  json: { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  force: { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  layer: { type: 'string' },
  owner: { type: 'string' },
  book: { type: 'string' },
  module: { type: 'string' },
  limit: { type: 'string' },
  name: { type: 'string' },
  project: { type: 'string' },
  /** `team activate --build-project <项目名>`（F-C3：显式建图；缺省绝不建图，守 R1） */
  'build-project': { type: 'string' },
  timeout: { type: 'string' },
  // design-v3 §3.5 F10 / §5 P14：role/team/skill 命令面
  /** harness 根目录（通用名；`--zcode-dir` 为兼容旧名，见 harnessRootOverride） */
  'harness-root': { type: 'string' },
  'zcode-dir': { type: 'string' },
  yes: { type: 'boolean' },
  from: { type: 'string' },
  to: { type: 'string' },
  source: { type: 'string' },
  model: { type: 'string' },
  'thought-level': { type: 'string' },
  depth: { type: 'string' },
  relations: { type: 'string' },
  kind: { type: 'string' },
  payload: { type: 'string' },
  priority: { type: 'string' },
  'priority-min': { type: 'string' },
  id: { type: 'string' },
  token: { type: 'string' },
  result: { type: 'string' },
  by: { type: 'string' },
  error: { type: 'string' },
  dag: { type: 'string' },
  session: { type: 'string' },
  team: { type: 'string' },
  difficulty: { type: 'string' },
  'dag-version': { type: 'string' },
  file: { type: 'string' },
  revision: { type: 'string' },
  'error-type': { type: 'string' },
  status: { type: 'string' },
  out: { type: 'string' },
  /** `graph merge --out-dir <目录>`（多项目合并产物目录；缺省 <PRISM_HOME>/graphify-merged/） */
  'out-dir': { type: 'string' },
  top: { type: 'string' },
  format: { type: 'string' },
  'dry-run': { type: 'boolean' },
  remove: { type: 'boolean' },
  hard: { type: 'boolean' },
  audit_type: { type: 'string' },
  visibility: { type: 'string' },
  knowledge: { type: 'string' },
  incremental: { type: 'boolean' },
  task: { type: 'string' },
  request: { type: 'string' },
  all: { type: 'boolean' },
  /** 变更 2：`prism embedding <install|status|stop|reindex>` 子动作 */
  action: { type: 'string' },
  'no-embedding': { type: 'boolean' },
  /** embedding 模型档位（small|default|large） */
  tier: { type: 'string' },
  /** kb convert 正文上限 */
  'max-chars': { type: 'string' },
  // design-v4 §3.5（流 3 命令面）
  /** team init --members <role[:n],...> */
  members: { type: 'string' },
  /** team init --template minimal|core-dev */
  template: { type: 'string' },
  /** team init --description <描述> */
  description: { type: 'string' },
  /** kb deposit --title <t> */
  title: { type: 'string' },
  /** kb deposit --type <rule|pitfall|...> */
  type: { type: 'string' },
  /** kb deposit --note <说明>（落 source.ref，满足团队 require_note） */
  note: { type: 'string' },
  /** kb deposit --tags a,b */
  tags: { type: 'string' },
  /** skill effective --role <r> */
  role: { type: 'string' },
  /** task report --deposit <md|->：终态一步落库（复用 kb deposit 路径） */
  deposit: { type: 'string' },
  /** kb structure freeze --modules a,b（显式冻结清单） */
  modules: { type: 'string' },
  /** kb structure generate|freeze --confirmed-by <who> */
  'confirmed-by': { type: 'string' },
} as const

export interface ParsedInvocation {
  positionals: string[]
  values: ArgValues
}

/** 全部子命令选项的并集。 */
export type ArgValues = {
  home?: string
  json?: boolean
  version?: boolean
  help?: boolean
  force?: boolean
  port?: string
  host?: string
  layer?: string
  owner?: string
  book?: string
  module?: string
  limit?: string
  name?: string
  project?: string
  timeout?: string
  'harness-root'?: string
  'zcode-dir'?: string
  yes?: boolean
  from?: string
  to?: string
  source?: string
  model?: string
  'thought-level'?: string
  depth?: string
  relations?: string
  kind?: string
  payload?: string
  priority?: string
  'priority-min'?: string
  id?: string
  token?: string
  result?: string
  by?: string
  error?: string
  dag?: string
  session?: string
  team?: string
  difficulty?: string
  'dag-version'?: string
  file?: string
  revision?: string
  'error-type'?: string
  status?: string
  out?: string
  /** `graph merge --out-dir <目录>` */
  'out-dir'?: string
  /** `team activate --build-project <项目名>`（F-C3：显式建图；缺省绝不建图） */
  'build-project'?: string
  top?: string
  format?: string
  'dry-run'?: boolean
  remove?: boolean
  hard?: boolean
  visibility?: string
  knowledge?: string
  incremental?: boolean
  task?: string
  request?: string
  audit_type?: string
  all?: boolean
  action?: string
  'no-embedding'?: boolean
  tier?: string
  'max-chars'?: string
  members?: string
  template?: string
  description?: string
  title?: string
  type?: string
  note?: string
  tags?: string
  role?: string
  deposit?: string
  modules?: string
  'confirmed-by'?: string
}

/** `~`/`~\/` 前缀展开为用户主目录（Windows/Node 不自动展开；CLI 层统一负责，design-v3 §5 P14）。 */
export function expandHome(path: string): string {
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return joinPath(homedir(), path.slice(2))
  }
  return path
}

/**
 * 解析「显式指定的 harness 根」——**只认 flag 与 env 覆盖，无则 undefined**。
 *
 * 与 `defaultHarnessRoot()` 的区别很关键：后者总会回落到 **zcode 的**默认根，若拿它去
 * 解析插件适配器，会把 `~/.zcode` 硬塞给插件，覆盖插件自述的 `defaultRoot`（实测 bug）。
 * 未显式指定时应返回 undefined，让 `harnessLayout()` 用**被激活适配器**的默认根。
 *
 * 返回值同时给出 explicit（仅 flag 算显式；env 只重定向不解除写守卫）。
 */
export function harnessRootOverride(values: ArgValues): { root?: string; explicit: boolean } {
  const flag = values['harness-root'] ?? values['zcode-dir']
  if (flag !== undefined && flag !== '') return { root: expandHome(flag), explicit: true }
  // 只认**通用** env；`ZCODE_DIR` 是 zcode 专属旧变量，由 zcode 适配器自己消费——
  // 在此读取会把它泄漏给其它 harness（插件实测：覆盖插件 defaultRoot）
  const envRoot = process.env['PRISM_HARNESS_ROOT']
  if (envRoot !== undefined && envRoot !== '') return { root: expandHome(envRoot), explicit: false }
  return { explicit: false }
}

/**
 * role/team/skill 子命令的统一目录解析（装配语义简化：直接住在宿主目录）：
 * `<PRISM_HOME>/prism.yaml`（可选）覆盖适配器默认；`--harness-root` 只作为默认推导基准。
 * 优先级：prism.yaml 显式键 > 显式根覆盖 > **激活适配器的默认根**。
 *
 * 显式性口径（B6 守卫）：只有 **--harness-root（或旧名 `--zcode-dir`）** / prism.yaml 键
 * 算「用户显式指定」；env `PRISM_HARNESS_ROOT` 不算（保持守卫生效）。
 */
export function resolveTargetDirs(ctx: CommandContext, values: ArgValues): ResolvedDirs {
  const { root, explicit } = harnessRootOverride(values)
  return resolveDirsFromHome(ctx.home, { ...(root !== undefined ? { harnessRoot: root } : {}), rootExplicit: explicit })
}

export type GuardedTarget = 'roles' | 'teams' | 'skills'

/**
 * B6 写守卫：目标目录取自默认链（非 --harness-root / prism.yaml 显式指定 → 真实宿主目录）时，
 * 必须显式 `--yes` 才放行；否则打印提示并返回 false（调用方立即退出，不产生任何写入）。
 * 返回 true = 放行（目录显式指定，或用户已 --yes 确认）。
 */
export function guardWriteTarget(
  ctx: CommandContext,
  values: ArgValues,
  dirs: ResolvedDirs,
  target: GuardedTarget,
  plannedWrites: number,
): boolean {
  if (!dirs.guard[target] || plannedWrites <= 0) return true
  const dirPath = target === 'roles' ? dirs.rolesDir : target === 'teams' ? dirs.teamsDir : dirs.skillsDir
  if (values.yes === true) {
    ctx.stdout(`--yes：确认写入默认宿主目录 ${dirPath}（${plannedWrites} 个文件）`)
    return true
  }
  ctx.stderr(
    `已阻止写入 [guard_required]: 检测到目标为默认宿主目录 ${dirPath}（未经 --harness-root / prism.yaml 显式指定），` +
      `将写入 ${plannedWrites} 个文件；加 --harness-root 指定其他位置，或加 --yes 确认。`,
  )
  return false
}

/** 解析 argv（node:util.parseArgs，允许位置参数与选项交错）。 */
export function parseArgv(argv: string[]): ParsedInvocation {
  const { values, positionals } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  })
  return { positionals, values: values as unknown as ParsedInvocation['values'] }
}

export function defaultContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    home: prismHome(),
    json: false,
    readStdin: readStdinDefault,
    ...overrides,
  }
}

/**
 * 缺省 stdin 读取（`--file -`）：一次性读完 fd 0。
 * 用 fs.readFileSync(0) 而非 process.stdin 流——后者在无管道时会挂住不返回。
 */
export async function readStdinDefault(): Promise<string> {
  const { readFileSync } = await import('node:fs')
  return readFileSync(0, 'utf-8')
}

/**
 * 执行 CLI 调用，返回进程退出码。
 * 命令面：design.md §5（init/serve/doctor/kb/graph）+ design-v3 §3.5（role/team/skill）。
 */
export async function runCommand(ctx: CommandContext, argv: string[]): Promise<number> {
  const { positionals, values } = parseArgv(argv)
  const effective: CommandContext = { ...ctx, home: values.home ?? ctx.home, json: values.json ?? ctx.json }

  if (values.version === true) {
    effective.stdout(`prism ${await cliVersion()}`)
    return 0
  }
  const [command, ...rest] = positionals
  if (command === undefined || values.help === true) {
    effective.stdout(USAGE)
    return command === undefined && argv.length === 0 ? 0 : values.help === true ? 0 : 0
  }

  try {
    // 应用 prism.yaml 配置（embedding 档位等）——须在派发前，保证所有命令
    // （status/reindex/search…）看到一致的生效档位；env PRISM_EMBEDDING_MODEL 优先级更高。
    applyEmbeddingConfig(effective.home)
    // 加载 harness 插件（<PRISM_HOME>/harnesses/）——让 harness list / role/team/skill
    // 等命令看到第三方适配器。加载失败不阻断（内部逐项容错）。
    await ensureHarnessPluginsLoaded(effective.home).catch(() => undefined)
    switch (command) {
      case 'init':
        return await runInit(effective, rest, values)
      case 'serve':
        return await runServe(effective, rest, values)
      case 'doctor':
        return await runDoctor(effective, rest, values)
      case 'embedding':
        return await runEmbedding(effective, rest, values)
      case 'kb':
        return await runKb(effective, rest, values)
      case 'task':
        return await runTask(effective, rest, values)
      case 'arch':
        return await runArch(effective, rest, values)
      case 'harness':
        return await runHarness(effective, rest, values)
      case 'graph':
        return await runGraph(effective, rest, values)
      case 'project':
        return await runProject(effective, rest, values)
      case 'inject':
        return await runInject(effective, rest, values)
      case 'audit':
        return await runAudit(effective, rest, values)
      case 'role':
        return await runRole(effective, rest, values)
      case 'team':
        return await runTeam(effective, rest, values)
      case 'skill':
        return await runSkill(effective, rest, values)
      default:
        effective.stderr(`未知命令: ${command}\n${USAGE}`)
        return 1
    }
  } catch (error) {
    const code = (error as { code?: string }).code
    const message = error instanceof Error ? error.message : String(error)
    effective.stderr(code !== undefined ? `错误 [${code}] ${message}` : `错误 ${message}`)
    return 1
  }
}

let cachedVersion: string | null = null

/** CLI 版本（读自身 package.json）。 */
export async function cliVersion(): Promise<string> {
  if (cachedVersion !== null) {
    return cachedVersion
  }
  try {
    const { readFile } = await import('node:fs/promises')
    const pkgPath = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string }
    cachedVersion = pkg.version ?? '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}
