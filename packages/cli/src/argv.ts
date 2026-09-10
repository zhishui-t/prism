import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import { parseArgs } from 'node:util'

import { prismHome, type PrismPersistence } from '@prism/core'
import { resolveDirsFromHome, type ResolvedDirs } from '@prism/agents'
import { defaultZcodeDir } from '@prism/server'
import type { BuildRunner, KnowledgeService } from '@prism/server'
import { runInit } from './commands/init.js'
import { runServe } from './commands/serve.js'
import { runDoctor } from './commands/doctor.js'
import { runKb } from './commands/kb.js'
import { runWork } from './commands/work.js'
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
}

export const USAGE = `prism — 企业级智能研发效能平台 CLI

用法：
  prism --version
  prism init [--home <PRISM_HOME>] [--zcode-dir <~/.zcode>] [--force]   接入初始化（五步）
  prism serve [--port 7777] [--host <h>]   启动 HTTP 服务（控制台 + API）
  prism doctor [--port 7777]               环境自检
  prism role list [--source <dir>]         列出角色（默认 roles_dir，见下）
  prism role show <name>                   查看角色定义
  prism role init <name> [--force]         从模板创建角色到 roles_dir（新命令）
  prism role import [--from <dir>] [--to <dir>]   从 ZCode agents 目录导入（默认 --from ~/.zcode/agents，--to roles_dir）
  prism role validate [--source <dir>]     校验角色定义
  prism role render <name> [--model --thought-level]   渲染 ZCode 格式（预览，不写盘）
  prism role install <name...> [--source <dir>] [--force]   角色（源≠roles_dir 时）初始化/迁移到 roles_dir
  prism team list | show <id> | validate <id>
  prism team install <id> [--force]        校验团队与成员；确保团队定义在 teams_dir（旧源目录一次性迁移）
  prism team activate <id>
  prism skill list | install | update | uninstall | validate [name...] [--force]

目录解析（装配语义简化——角色/团队/Skill 直接住在宿主目录）：
  <PRISM_HOME>/prism.yaml 可选覆盖：roles_dir（默认 ~/.zcode/agents）、
  teams_dir（默认 ~/.zcode/teams，roles_dir 同级——不在 agents/ 内，避开 ZCode 递归扫描）、skills_dir（默认 ~/.zcode/skills）；
  --zcode-dir 仅作为默认推导基准。
  prism kb import <file.md> [--layer --owner --book --module]
  prism kb sync <项目名|项目根> [--owner --book --module] [--enqueue] [--dry-run]   扫描项目文档建引用索引
  prism kb search <query> [--layer --book --limit]
  prism kb get <id[@version]>
  prism kb tree [--layer]
  prism kb stats
  prism kb graph [id] [--depth 1] [--limit 50] [--relations references,overrides]   图谱邻域/概览
  prism kb path <from> <to> [--relations ...]                                      两节点最短路径
  prism kb export [--format html|obsidian|svg|graphml|wiki]                          知识图谱导出（借 Graphify）
  prism kb remove <id> [--hard --yes]     软删（默认置 deprecated）；硬删需 --hard 且无引用
  prism kb conflicts [--all]              层间冲突列表（默认未处理）
  prism kb resolve <conflict-id>          标记冲突已处理
  prism kb reindex                        以文件为真相重建索引（手工改过知识文件后用）
  prism work pending [--kind --limit]     列出待办 LLM 工作（拉取式）
  prism work enqueue --kind <k> --payload <json> [--priority N]
  prism work claim <id> [--by <who>]      认领（签发 attempt token）
  prism work complete <id> --token <t> --result <json>
  prism work fail <id> --token <t> [--error <msg>]
  prism work reclaim | stats              超时回收 / 队列水位
  prism task list [--dag --status]        任务台账（被动记录，不驱动）
  prism task show <task-id> | graph <dag-id> | stats
  prism task register --dag <id> --file <dag.json> --session --team --project
  prism task report <task-id> --to <STATUS> --by <who> [--from --revision]
  prism arch types | validate <type> <ir.json> | render <type> <ir.json> [--out <html>]
  prism audit query [--type ...] [--task/--request/--knowledge/--session <id>] [--limit N]
  prism harness list | show               运行时宿主适配器（prism.yaml: harness 键）
  prism graph build <项目根目录> [--name <项目名>] [--incremental] [--timeout <秒>]
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

全局：--home <path>  --json  --zcode-dir <path>（role/team/skill/install 类统一收 ZCode 根，~ 自动展开）
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
  timeout: { type: 'string' },
  // design-v3 §3.5 F10 / §5 P14：role/team/skill 命令面
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
  top: { type: 'string' },
  format: { type: 'string' },
  'dry-run': { type: 'boolean' },
  remove: { type: 'boolean' },
  enqueue: { type: 'boolean' },
  hard: { type: 'boolean' },
  audit_type: { type: 'string' },
  visibility: { type: 'string' },
  knowledge: { type: 'string' },
  incremental: { type: 'boolean' },
  task: { type: 'string' },
  request: { type: 'string' },
  all: { type: 'boolean' },
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
  top?: string
  format?: string
  'dry-run'?: boolean
  remove?: boolean
  enqueue?: boolean
  hard?: boolean
  visibility?: string
  knowledge?: string
  incremental?: boolean
  task?: string
  request?: string
  audit_type?: string
  all?: boolean
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
 * role/team/skill 子命令的统一目录解析（装配语义简化：直接住在宿主目录）：
 * `<PRISM_HOME>/prism.yaml`（可选）覆盖适配器默认；`--zcode-dir` 只作为默认推导基准。
 * 优先级：prism.yaml 显式键 > --zcode-dir 推导 > 内置默认（~/.zcode）。
 *
 * 显式性口径（B6 守卫）：只有 **--zcode-dir** / prism.yaml 键算「用户显式指定」；
 * env `ZCODE_DIR` 不算（保持守卫生效），缺省回落真实 ~/.zcode 一律 guard=true。
 */
export function resolveTargetDirs(ctx: CommandContext, values: ArgValues): ResolvedDirs {
  const explicit = values['zcode-dir'] !== undefined
  const zcodeDir = explicit ? expandHome(values['zcode-dir'] as string) : defaultZcodeDir()
  return resolveDirsFromHome(ctx.home, { zcodeDir, zcodeDirExplicit: explicit })
}

export type GuardedTarget = 'roles' | 'teams' | 'skills'

/**
 * B6 写守卫：目标目录取自默认链（非 --zcode-dir / prism.yaml 显式指定 → 真实宿主目录）时，
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
    `已阻止写入 [guard_required]: 检测到目标为默认宿主目录 ${dirPath}（未经 --zcode-dir / prism.yaml 显式指定），` +
      `将写入 ${plannedWrites} 个文件；加 --zcode-dir 指定其他位置，或加 --yes 确认。`,
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
    ...overrides,
  }
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
    switch (command) {
      case 'init':
        return await runInit(effective, rest, values)
      case 'serve':
        return await runServe(effective, rest, values)
      case 'doctor':
        return await runDoctor(effective, rest, values)
      case 'kb':
        return await runKb(effective, rest, values)
      case 'work':
        return await runWork(effective, rest, values)
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
