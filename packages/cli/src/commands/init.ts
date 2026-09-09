import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listBuiltinSkills, installSkills } from '@prism/skills'
import { prismHome, prismPaths, PrismError } from '@prism/core'
import { CORE_DEV_TEAM_MD, zcodePaths, defaultZcodeDir, resolveDirsFromHome } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { expandHome } from '../argv.js'

export const DEFAULT_CONFIG = (home: string): Record<string, unknown> => ({
  version: 1,
  home,
  server: { host: '127.0.0.1', port: 7777 },
  graphify: { timeout_ms: 300_000, bin_env: 'GRAPHIFY_BIN' },
})

export interface InitReport {
  home: string
  zcodeDir: string
  zcodeDetected: boolean
  dirs: string[]
  seededTeam?: string
  homeConfig: string
  skills: { written: string[]; skipped: Array<{ path: string; reason: string }> }
  mcp: { status: 'written' | 'unchanged' | 'conflict' | 'forced'; configFile: string; entry?: unknown; backup?: string }
}

/**
 * `prism init [--home] [--zcode-dir] [--force]`（design-v3 §3.6 五步）：
 * ① 探测 ZCode 目录（默认 ~/.zcode，不存在则警告但继续）
 * ② 建 <PRISM_HOME> 骨架：roles/ teams/ skills/ knowledge/ state/ catalog/ audit/
 *    （teams/ 为空时另落一份出厂团队模板，供 team 命令开箱可用）
 * ③ 安装内置 Skill 到 <zcodeDir>/skills/（目标目录来自 --zcode-dir 推导，不硬编码）
 * ④ 写 MCP 注册到 <zcodeDir>/cli/config.json（合并、写前备份；已有 prism 项指向
 *    不同路径时不覆盖，提示 --force）
 * ⑤ 输出报告 + 提示「重启会话生效」
 * 幂等：重复执行结果一致。
 */
export async function runInit(ctx: CommandContext, _args: string[], values: ArgValues): Promise<number> {
  const home = ctx.home ?? prismHome()
  const paths = prismPaths(home)
  const zcodeDirExplicit = values['zcode-dir'] !== undefined
  const zcodeDir = expandHome(values['zcode-dir'] ?? defaultZcodeDir())
  // B6 写守卫：init 会写 <zcodeDir>/skills 与 <zcodeDir>/cli/config.json——
  // 默认链（未显式 --zcode-dir）落真实 ~/.zcode，需 --yes 确认
  if (!zcodeDirExplicit && values.yes !== true) {
    ctx.stderr(
      `已阻止写入 [guard_required]: 检测到目标为默认宿主目录 ${zcodeDir}（未经 --zcode-dir 显式指定），` +
        `prism init 将写入 Skill 与 MCP 注册配置；加 --zcode-dir 指定其他位置，或加 --yes 确认。`,
    )
    return 1
  }
  const zcode = zcodePaths(zcodeDir)
  const force = values.force === true

  // ① 探测 ZCode（不存在 → 警告但继续）
  const zcodeDetected = existsSync(zcodeDir)

  // ② <PRISM_HOME> 骨架（roles/catalog 由本命令补齐——core prismPaths 暂无此二键，见报告遗留项）
  //    出厂团队模板落**受管 teams_dir**（resolveDirs：prism.yaml 覆盖 → 默认 <zcodeDir>/teams），
  //    而非固定 <PRISM_HOME>/teams——否则 team list 读不到（B9）。
  const resolved = resolveDirsFromHome(home, { zcodeDir, zcodeDirExplicit })
  const dirs = [
    paths.home,
    paths.stateDir,
    paths.auditDir,
    paths.knowledgeDir,
    join(home, 'roles'),
    paths.teamsDir,
    paths.skillsDir,
    join(home, 'catalog'),
    paths.graphDir,
  ]
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }
  const seededTeam = seedFactoryTeam(resolved.teamsDir)

  // <PRISM_HOME>/config.json 默认配置（保持既有行为：已存在且无 --force → 幂等跳过）
  const configPath = join(paths.home, 'config.json')
  const homeConfigExisted = existsSync(configPath)
  if (!homeConfigExisted || force) {
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG(home), null, 2)}\n`, 'utf-8')
  }

  // ③ 内置 Skill → <zcodeDir>/skills/（§5 冲突策略：人写不覆盖，.prism-new 供对比）
  const skills = await installSkills({ targetDir: zcode.skillsDir, skills: listBuiltinSkills(), force })

  // ④ MCP 注册 → <zcodeDir>/cli/config.json（合并 + 备份；冲突不覆盖，P16）
  const mcp = await registerMcp({
    configFile: zcode.configFile,
    home,
    force,
    mcpEntry: resolveMcpEntry(),
  })

  const report: InitReport = {
    home,
    zcodeDir,
    zcodeDetected,
    dirs,
    ...(seededTeam !== undefined ? { seededTeam } : {}),
    homeConfig: configPath,
    skills,
    mcp,
  }

  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: report }))
  } else {
    const display = (dir: string): string => (dir === home ? '.' : dir)
    ctx.stdout(`PRISM_HOME: ${home}`)
    ctx.stdout(`① ZCode 目录: ${zcodeDir}${zcodeDetected ? '' : '（未探测到——将继续，可用 --zcode-dir 指定）'}`)
    ctx.stdout(`② 已建目录: ${dirs.map(display).join(' ')}`)
    if (!homeConfigExisted || force) {
      ctx.stdout(`  已写配置: ${configPath}${homeConfigExisted ? '（--force 重建）' : ''}`)
    } else {
      ctx.stdout(`  已初始化（幂等跳过）: ${configPath}；使用 --force 重建`)
    }
    if (seededTeam !== undefined) {
      ctx.stdout(`  出厂团队模板: ${seededTeam}`)
    }
    ctx.stdout(
      `③ Skill 安装: 写 ${skills.written.length} 个${
        skills.skipped.length > 0 ? `，跳过 ${skills.skipped.length} 个（${skills.skipped.map((s) => s.path).join('；')}）` : ''
      }`,
    )
    const mcpLine: Record<InitReport['mcp']['status'], string> = {
      written: `已注册 prism MCP → ${mcp.configFile}`,
      unchanged: `MCP 注册未变化（幂等）: ${mcp.configFile}`,
      conflict: `MCP 注册冲突：mcp.servers.prism 已存在且指向不同路径，未覆盖；确认后加 --force 覆盖（${mcp.configFile}）`,
      forced: `MCP 注册已按 --force 覆盖: ${mcp.configFile}`,
    }
    ctx.stdout(`④ ${mcpLine[mcp.status]}${mcp.backup !== undefined ? `（备份: ${mcp.backup}）` : ''}`)
    ctx.stdout('⑤ 完成。请重启 ZCode 会话使 MCP 与 Skill 生效')
  }
  return 0
}

/** teams/ 为空（无 <id>/AGENTS.md）时落出厂模板；幂等。 */
function seedFactoryTeam(teamsDir: string): string | undefined {
  if (existsSync(teamsDir)) {
    const hasTeam = readdirSync(teamsDir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && existsSync(join(teamsDir, e.name, 'AGENTS.md')),
    )
    if (hasTeam) {
      return undefined
    }
  }
  const target = join(teamsDir, 'core-dev', 'AGENTS.md')
  mkdirSync(join(teamsDir, 'core-dev'), { recursive: true })
  writeFileSync(target, CORE_DEV_TEAM_MD, 'utf-8')
  return target
}

/**
 * 合并写入 `mcp.servers.prism`（init-and-registration §4）：
 * 只增/改该键，其余键原样保留；改动既有文件前备份（`config.json.bak-prism-init-<ts>`）；
 * 已存在且指向不同 → 不覆盖并提示 --force（status='conflict'）。
 */
async function registerMcp(opts: {
  configFile: string
  home: string
  force: boolean
  mcpEntry: string
}): Promise<InitReport['mcp']> {
  const { configFile, home, force, mcpEntry } = opts
  const entry = {
    type: 'stdio',
    command: 'node',
    args: [mcpEntry],
    env: { PRISM_HOME: home },
    timeoutMs: 60_000,
  }

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

  const mcp = (cfg['mcp'] ?? {}) as Record<string, unknown>
  const servers = (mcp['servers'] ?? {}) as Record<string, unknown>
  const existing = servers['prism']

  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(entry)) {
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

  servers['prism'] = entry
  mcp['servers'] = servers
  cfg['mcp'] = mcp
  await mkdir(join(configFile, '..'), { recursive: true })
  await writeFile(configFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8')
  return {
    status: existing !== undefined ? 'forced' : 'written',
    configFile,
    entry,
    ...(backup !== undefined ? { backup } : {}),
  }
}

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
