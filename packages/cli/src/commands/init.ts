import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listBuiltinSkills, installSkills } from '@prism/skills'
import { prismHome, prismPaths, PrismError, type McpConvention } from '@prism/core'
import { harnessPaths, defaultHarnessRoot } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { expandHome } from '../argv.js'
import { formatCliLine, registerCli, type InitCliReport } from './init-cli.js'

export const DEFAULT_CONFIG = (home: string): Record<string, unknown> => ({
  version: 1,
  home,
  server: { host: '127.0.0.1', port: 7777 },
  graphify: { timeout_ms: 300_000, bin_env: 'GRAPHIFY_BIN' },
})

export interface InitReport {
  home: string
  harnessRoot: string
  harnessDetected: boolean
  dirs: string[]
  homeConfig: string
  skills: { written: string[]; skipped: Array<{ path: string; reason: string }> }
  mcp: {
    status: 'written' | 'unchanged' | 'conflict' | 'forced' | 'unsupported'
    configFile: string | null
    entry?: unknown
    backup?: string
  }
  /** CLI 全局注册（design-v12 §F5 / SPEC-5.1–5.6；`--skip-cli` → status=skipped） */
  cli: InitCliReport
}

/**
 * `prism init [--home] [--harness-root] [--force] [--skip-cli]`（design-v3 §3.6 五步
 * + design-v12 §F5 第六步）：
 * ① 探测宿主目录（默认取**激活适配器**的 defaultRoot，不存在则警告但继续）
 * ② 建 <PRISM_HOME> 骨架：roles/ skills/ knowledge/ state/ catalog/ audit/
 *    （**不落任何团队**——是否建团队、建几个、用什么编制，是使用者的事，
 *      不替使用者做决定；需要时由使用者运行 `prism team new`）
 *    **不建 teams/**：受管团队位置由适配器/prism.yaml 决定（默认 <harnessRoot>/teams）；
 *    旧版的 `<PRISM_HOME>/teams` 源目录已随 `team install` 移除而废弃（`PrismPaths.teamsDir` 已删），
 *    新装用户不需要它——建出来只会与受管位置同名异位、诱导误判（B9 遗留半边）。
 * ③ 安装内置 Skill 到 <harnessRoot>/skills/（目标目录来自 --harness-root 推导，不硬编码）
 * ④ 写 MCP 注册到 <harnessRoot>/cli/config.json（合并、写前备份；已有 prism 项指向
 *    不同路径时不覆盖，提示 --force）
 * ⑤ **CLI 全局注册**（发行态 `npm install -g <发行根>`；仓库态写全局 bin shim；
 *    `--skip-cli` 跳过）——失败只记 `cli.status=failed` + 手动指引，**不中断其余步骤**
 * ⑥ 输出报告 + 提示「重启会话生效」
 * 幂等：重复执行结果一致。
 */
export async function runInit(ctx: CommandContext, _args: string[], values: ArgValues): Promise<number> {
  const home = ctx.home ?? prismHome()
  const paths = prismPaths(home)
  // `--zcode-dir` 是兼容旧名（与 argv 的 harnessRootOverride 同口径）；早期此处写成
  // `values['harness-root'] ?? values['harness-root']`（同一表达式两遍）→ 旧名被静默忽略。
  const rootFlag = values['harness-root'] ?? values['zcode-dir']
  const rootExplicit = rootFlag !== undefined && rootFlag !== ''
  // 默认根取自**配置激活的适配器**（prism.yaml: harness / PRISM_HARNESS），须传 home 才读得到——
  // 否则插件适配器会拿到 zcode 的默认根，MCP 注册与 Skill 全写错宿主（见 defaultHarnessRoot 注释）
  const harnessRoot = expandHome(rootExplicit ? rootFlag : defaultHarnessRoot(home))
  // B6 写守卫：init 会写 <harnessRoot>/skills 与 <harnessRoot>/cli/config.json——
  // 默认链（未显式 --harness-root）落真实宿主目录，需 --yes 确认。
  // 文案只指向 `--yes`：init 的**正常落点就是默认宿主目录**（这就是这个命令要做的事），
  // 旧文案让用户「加 --harness-root 指定其他位置」等于劝他别用 init 的本职；
  // `--harness-root` 在 init 语境是测试/CI 专用（见 USAGE 与成功输出）。
  if (!rootExplicit && values.yes !== true) {
    ctx.stderr(
      `已阻止写入 [guard_required]: 检测到目标为默认宿主目录 ${harnessRoot}（未经 --harness-root 显式指定，该参数测试/CI 专用），` +
        `prism init 将写入 Skill 与 MCP 注册配置；加 --yes 确认写入默认宿主配置。`,
    )
    return 1
  }
  const hostPaths = harnessPaths(harnessRoot, home)
  const force = values.force === true

  // ① 探测 ZCode（不存在 → 警告但继续）
  const harnessDetected = existsSync(harnessRoot)

  // ② <PRISM_HOME> 骨架（roles/catalog 由本命令补齐——core prismPaths 暂无此二键，见报告遗留项）
  //    **不含 teams/**：受管位置由适配器/prism.yaml 决定（默认 <harnessRoot>/teams）；
  //    旧版源目录 <home>/teams 已随 team install 移除而废弃，
  //    新装无需预建——建出来会与受管位置同名异位，正是"团队到底放哪"的误判来源。
  const dirs = [
    paths.home,
    paths.stateDir,
    paths.auditDir,
    paths.knowledgeDir,
    join(home, 'roles'),
    paths.skillsDir,
    join(home, 'catalog'),
    paths.graphDir,
  ]
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }

  // <PRISM_HOME>/config.json 默认配置（保持既有行为：已存在且无 --force → 幂等跳过）
  const configPath = join(paths.home, 'config.json')
  const homeConfigExisted = existsSync(configPath)
  if (!homeConfigExisted || force) {
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG(home), null, 2)}\n`, 'utf-8')
  }

  // ③ 内置 Skill → <harnessRoot>/skills/（§5 冲突策略：人写不覆盖，.prism-new 供对比）
  const skills = await installSkills({ targetDir: hostPaths.skillsDir, skills: listBuiltinSkills(), force })

  // ④ MCP 注册 → <harnessRoot>/cli/config.json（合并 + 备份；冲突不覆盖，P16）
  const mcp = await registerMcp({
    configFile: hostPaths.configFile,
    format: hostPaths.mcpFormat,
    serverName: hostPaths.mcpServerName,
    home,
    force,
    mcpEntry: resolveMcpEntry(),
  })

  // ⑤ CLI 全局注册（design-v12 §F5）：默认执行，`--skip-cli` 跳过。
  //    失败**不中断** init——spec 5.4 要求其余步骤照常完成且 exit 0。
  const cli = await registerCli({ skip: values['skip-cli'] === true })

  const report: InitReport = {
    home,
    harnessRoot,
    harnessDetected,
    dirs,
    homeConfig: configPath,
    skills,
    mcp,
    cli,
  }

  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: report }))
  } else {
    const display = (dir: string): string => (dir === home ? '.' : dir)
    ctx.stdout(`PRISM_HOME: ${home}`)
    ctx.stdout(`① 宿主目录: ${harnessRoot}${harnessDetected ? '' : '（未探测到——将继续；覆盖落点用 --harness-root，该参数测试/CI 专用）'}`)
    ctx.stdout(`② 已建目录: ${dirs.map(display).join(' ')}`)
    if (!homeConfigExisted || force) {
      ctx.stdout(`  已写配置: ${configPath}${homeConfigExisted ? '（--force 重建）' : ''}`)
    } else {
      ctx.stdout(`  已初始化（幂等跳过）: ${configPath}；使用 --force 重建`)
    }
    ctx.stdout('  团队: 未创建（是否建团队由你决定；需要时运行 prism team new）')
    ctx.stdout(
      `③ Skill 安装: 写 ${skills.written.length} 个${
        skills.skipped.length > 0 ? `，跳过 ${skills.skipped.length} 个（${skills.skipped.map((s) => s.path).join('；')}）` : ''
      }`,
    )
    // 文案里的 JSON 路径随**形态**走：平铺宿主（WorkBuddy/VS Code）键在顶层 mcpServers.<name>，
    // 不是 zcode 的 mcp.servers.<name>——写死会让读者按提示去配置里找不到那个键。
    const mcpKeyPath =
      hostPaths.mcpFormat === 'mcpServers-json'
        ? `mcpServers.${hostPaths.mcpServerName}`
        : `mcp.servers.${hostPaths.mcpServerName}`
    const mcpLine: Record<InitReport['mcp']['status'], string> = {
      written: `已注册 ${hostPaths.mcpServerName} MCP → ${mcp.configFile}`,
      unchanged: `MCP 注册未变化（幂等）: ${mcp.configFile}`,
      conflict: `MCP 注册冲突：${mcpKeyPath} 已存在且指向不同路径，未覆盖；确认后加 --force 覆盖（${mcp.configFile}）`,
      forced: `MCP 注册已按 --force 覆盖: ${mcp.configFile}`,
      unsupported: '当前 harness 无 MCP 注册机制（跳过；Skill 仍已安装）',
    }
    ctx.stdout(`④ ${mcpLine[mcp.status]}${mcp.backup !== undefined ? `（备份: ${mcp.backup}）` : ''}`)
    ctx.stdout(formatCliLine(cli))
    ctx.stdout('⑥ 完成。请重启宿主会话使 MCP 与 Skill 生效')
  }
  return 0
}

/**
 * 合并写入 MCP 注册（init-and-registration §4）：
 * 只增/改目标服务条目，**同文件其它键一律原样保留**；改动既有文件前备份
 * （`<configFile>.bak-prism-init-<ts>`）；已存在且指向不同 → 不覆盖并提示 `--force`
 * （status='conflict'）。
 *
 * 写入形态由适配器自述（`McpConvention.format`），两种：
 * - `mcp-servers-json` → `{ mcp: { servers: { <name>: { type, command, args, env, timeoutMs } } } }`（ZCode）
 * - `mcpServers-json`  → `{ mcpServers: { <name>: { command, args, env } } }`（平铺；WorkBuddy / VS Code）
 *
 * 早期实现把 ZCode 形态写死在此——接入 WorkBuddy 时会**静默写错层级**（宿主读不到、
 * 且往人家配置里塞了无意义的 `mcp.servers` 键），故改为按形态分派。
 *
 * 「是否与既有条目等价」走 {@link sameMcpEntry} 的**归一化投影比较**（不再用 `JSON.stringify`
 * 全等——它对键序、`node`/`node.exe`、`\`/`/`、缺省 timeoutMs 这类等价写法全部误报 conflict，
 * 且对宿主自己加的键敏感）。覆盖写回走 {@link mergeMcpEntry}（保留未知键）。
 */
async function registerMcp(opts: {
  configFile: string | null
  format: McpConvention['format']
  serverName: string
  home: string
  force: boolean
  mcpEntry: string
}): Promise<InitReport['mcp']> {
  const { configFile, format, serverName, home, force, mcpEntry } = opts
  // 该 harness 无 MCP 注册机制（适配器 mcp.configFile 为 null）→ 跳过，不报错
  if (configFile === null) {
    return { status: 'unsupported', configFile: null }
  }
  const entry =
    format === 'mcpServers-json'
      ? { command: 'node', args: [mcpEntry], env: { PRISM_HOME: home } }
      : { type: 'stdio', command: 'node', args: [mcpEntry], env: { PRISM_HOME: home }, timeoutMs: 60_000 }

  let cfg: Record<string, unknown> = {}
  let existed = false
  if (existsSync(configFile)) {
    existed = true
    try {
      cfg = JSON.parse(await readFile(configFile, 'utf-8')) as Record<string, unknown>
    } catch (error) {
      throw new PrismError(
        'bad_request',
        `配置不是合法 JSON: ${configFile}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
  }

  const servers = readMcpServers(cfg, format)
  const existing = servers[serverName]

  if (existing !== undefined) {
    if (sameMcpEntry(existing, entry, format)) {
      return { status: 'unchanged', configFile, entry }
    }
    if (!force) {
      return { status: 'conflict', configFile, entry: existing }
    }
  }

  const backup = existed ? `${configFile}.bak-prism-init-${timestamp()}` : undefined
  if (backup !== undefined) {
    await writeFile(backup, await readFile(configFile, 'utf-8'), 'utf-8')
  }

  servers[serverName] = mergeMcpEntry(existing, entry)
  writeMcpServers(cfg, format, servers)
  await mkdir(join(configFile, '..'), { recursive: true })
  await writeFile(configFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8')
  return {
    status: existing !== undefined ? 'forced' : 'written',
    configFile,
    entry,
    ...(backup !== undefined ? { backup } : {}),
  }
}

/**
 * 归一化投影的**字段口径**（按形态）：
 * - 两种形态都比 `command` / `args` / `env`；
 * - 仅 ZCode 形态比 `type`（缺省即 `stdio`）与 `timeoutMs`（缺省补齐 60_000）——
 *   平铺形态本就不写这两个键，拿它们去比会凭空造出 conflict。
 * 其余键（宿主加的 `disabled`、用户加的 env 变量…）**不参与比较**：不是 Prism 写的，就不该算冲突。
 */
function normalizedEntry(entry: unknown, format: McpConvention['format']): Record<string, unknown> {
  if (!isRecord(entry)) return {}
  const out: Record<string, unknown> = {
    command: normalizeCommand(entry['command']),
    args: Array.isArray(entry['args']) ? entry['args'].map(normalizePathValue) : entry['args'],
    env: normalizeEnv(entry['env']),
  }
  if (format === 'mcp-servers-json') {
    out['type'] = entry['type'] ?? 'stdio'
    out['timeoutMs'] = normalizeTimeout(entry['timeoutMs'])
  }
  return out
}

/** 既有条目与新条目**内容等价**？（等价 → unchanged：不报 conflict、不覆盖、不备份） */
function sameMcpEntry(existing: unknown, entry: Record<string, unknown>, format: McpConvention['format']): boolean {
  if (!isRecord(existing)) return false
  const prev = normalizedEntry(existing, format)
  const next = normalizedEntry(entry, format)
  const scalarKeys = format === 'mcp-servers-json' ? ['type', 'command', 'timeoutMs'] : ['command']
  for (const key of scalarKeys) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) return false
  }
  if (JSON.stringify(prev['args']) !== JSON.stringify(next['args'])) return false
  return envSatisfies(prev['env'] as Record<string, unknown>, next['env'] as Record<string, unknown>)
}

/**
 * env 等价判据：只要求**我们管的键**（PRISM_HOME）逐键一致——键序无关；
 * 宿主/用户往该条目里加的其它环境变量（`NODE_OPTIONS` 之类）不算冲突，且 `--force` 时保留。
 */
function envSatisfies(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return Object.keys(next).every((key) => JSON.stringify(prev[key]) === JSON.stringify(next[key]))
}

/**
 * 覆盖写回的合并：Prism 管的字段取新值，既有其它键**原样保留**（不静默丢弃宿主/用户写的键）；
 * `env` 单独逐键合并，免掉整块替换时抹掉用户往该条目里加的环境变量。
 */
function mergeMcpEntry(existing: unknown, entry: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(existing)) return entry
  const merged: Record<string, unknown> = { ...existing, ...entry }
  if (isRecord(existing['env']) && isRecord(entry['env'])) {
    merged['env'] = { ...existing['env'], ...entry['env'] }
  }
  return merged
}

/** 可执行体形态归一：`node` 与 `node.exe`（大小写不限）视为同一可执行体；路径分隔符一并归一。 */
function normalizeCommand(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value.replace(/\\/g, '/').replace(/\.exe$/i, '')
}

/** 路径分隔符归一（`\` ↔ `/`）：args 逐项、env 逐值比较时用。 */
function normalizePathValue(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : value
}

/** env 值归一：字符串按路径分隔符归一；键排序后返回（消除键序差异）。 */
function normalizeEnv(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = normalizePathValue(value[key])
  }
  return out
}

/** `timeoutMs` 归一：`"60000"` → `60000`；缺省（undefined/null）→ 60_000（ZCode 形态默认值）。 */
function normalizeTimeout(value: unknown): unknown {
  if (value === undefined || value === null) return 60_000
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value)
  return value
}

/** 按形态从既有配置里**浅拷**出服务表（避免污染原对象；缺则空表）。 */
function readMcpServers(cfg: Record<string, unknown>, format: McpConvention['format']): Record<string, unknown> {
  if (format === 'mcpServers-json') {
    const flat = cfg['mcpServers']
    return isRecord(flat) ? { ...flat } : {}
  }
  const mcp = isRecord(cfg['mcp']) ? cfg['mcp'] : {}
  const servers = mcp['servers']
  return isRecord(servers) ? { ...servers } : {}
}

/** 按形态把服务表写回配置对象（**只动目标层，其余键不碰**）。 */
function writeMcpServers(
  cfg: Record<string, unknown>,
  format: McpConvention['format'],
  servers: Record<string, unknown>,
): void {
  if (format === 'mcpServers-json') {
    cfg['mcpServers'] = servers
    return
  }
  const mcp = isRecord(cfg['mcp']) ? { ...cfg['mcp'] } : {}
  mcp['servers'] = servers
  cfg['mcp'] = mcp
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** MCP stdio 入口（packages/server/dist/mcp/server.js）；可用 PRISM_MCP_ENTRY 覆盖。 */
function resolveMcpEntry(): string {
  const fromEnv = process.env['PRISM_MCP_ENTRY']
  if (fromEnv !== undefined && fromEnv !== '') {
    return expandHome(fromEnv)
  }
  return fileURLToPath(new URL('../../../server/dist/mcp/server.js', import.meta.url))
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 读 <PRISM_HOME>/config.json（serve/doctor 用；无文件返回内置默认）。 */
export function readConfig(home: string): Record<string, unknown> {
  const configPath = join(home, 'config.json')
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG(home)
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return DEFAULT_CONFIG(home)
  }
}
