/**
 * 角色/团队注册表（design-v3 §3.1 RoleRegistry / TeamRegistry）。
 *
 * importFromDir / loadFromDir 同时兼容两种形态（design-v3 §3.3 P10）：
 * - 扁平：`<dir>/<name>.md`
 * - 目录式：`<dir>/<name>/AGENTS.md`（Prism 原生角色存储）
 *
 * 导入后即跑 validateRole（带目录名基准）并把 issues 挂到角色上——
 * server `/api/roles` 直接透传即可满足 P9「返回携带校验状态」。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseRoleMarkdown, toRoleParseError } from './role/parse.js'
import { validateRole } from './role/validate.js'
import { parseTeamMarkdown } from './team/parse.js'
import type { RoleDefinition, RoleRegistry, TeamDefinition, TeamRegistry } from './types.js'

export interface ImportFailures {
  roles: RoleDefinition[]
  /** 解析失败的文件（不中断整体导入）。 */
  failures: Array<{ path: string; code: string; message: string }>
}

/** 创建角色注册表。 */
export function createRoleRegistry(): RoleRegistry & { importFromDirDetailed(dir: string): Promise<ImportFailures> } {
  const roles = new Map<string, RoleDefinition>()

  const importFromDirDetailed = async (dir: string): Promise<ImportFailures> => {
    const failures: ImportFailures['failures'] = []
    for (const entry of listMarkdownSources(dir)) {
      try {
        const raw = readFileSync(entry.path, 'utf8')
        const role = parseRoleMarkdown(raw, { sourcePath: entry.path })
        // 校验基准：扁平文件 → 文件名（去 .md）；目录式 → 目录名（design-v3 §3.3 P10）
        const result = validateRole(role, { dirname: entry.name })
        role.issues = result.issues
        // 角色库内 name 唯一（§4.1）：重名时后到者标注并跳过入库，先到者保留
        if (roles.has(role.name)) {
          role.issues.push({
            level: 'error',
            code: 'role_duplicate',
            message: `角色库内 name 重复：${role.name}（${entry.path}）`,
            where: entry.path,
          })
          failures.push({ path: entry.path, code: 'role_duplicate', message: `重名角色未入库：${role.name}` })
          continue
        }
        roles.set(role.name, role)
      } catch (err) {
        const parseErr = toRoleParseError(err, entry.path)
        failures.push({ path: entry.path, code: parseErr.code, message: parseErr.message })
      }
    }
    return { roles: list(), failures }
  }

  const list = (): RoleDefinition[] => [...roles.values()]

  return {
    list,
    get: (name) => roles.get(name),
    importFromDir: async (dir) => (await importFromDirDetailed(dir)).roles,
    importFromDirDetailed,
  }
}

/** 创建团队注册表。 */
export function createTeamRegistry(): TeamRegistry & {
  loadFromDirDetailed(dir: string): Promise<{ teams: TeamDefinition[]; failures: ImportFailures['failures'] }>
} {
  const teams = new Map<string, TeamDefinition>()

  const loadFromDirDetailed = async (dir: string) => {
    const failures: ImportFailures['failures'] = []
    for (const entry of listMarkdownSources(dir)) {
      try {
        const team = parseTeamMarkdown(readFileSync(entry.path, 'utf8'), { sourcePath: entry.path })
        if (teams.has(team.team_id)) {
          failures.push({ path: entry.path, code: 'team_duplicate', message: `team_id 重复未入库：${team.team_id}` })
          continue
        }
        teams.set(team.team_id, team)
      } catch (err) {
        failures.push({
          path: entry.path,
          code: 'team_parse_failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { teams: [...teams.values()], failures }
  }

  return {
    list: () => [...teams.values()],
    get: (teamId) => teams.get(teamId),
    loadFromDir: async (dir) => (await loadFromDirDetailed(dir)).teams,
    loadFromDirDetailed,
  }
}

interface MarkdownSource {
  name: string
  path: string
  kind: 'file' | 'dir'
}

/** 列出目录下的角色/团队 Markdown 源：`<name>.md` 与 `<name>/AGENTS.md`（按名称排序，保证确定性）。 */
function listMarkdownSources(dir: string): MarkdownSource[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  const out: MarkdownSource[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (entry.endsWith('.md')) {
      out.push({ name: entry.slice(0, -3), path: join(dir, entry), kind: 'file' })
      continue
    }
    const sub = join(dir, entry)
    const agentsMd = join(sub, 'AGENTS.md')
    if (statSync(sub).isDirectory() && existsSync(agentsMd)) {
      out.push({ name: entry, path: agentsMd, kind: 'dir' })
    }
  }
  return out
}
