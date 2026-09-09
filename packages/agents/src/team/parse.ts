/**
 * 团队定义解析（frontmatter + 正文工作流表格 → TeamDefinition）。
 *
 * 工作流只解析标准 Markdown 表格（design-v3 §7）：
 * `| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |`
 * 解析失败抛 TeamParseError（code='team_parse_failed'，带行号）。
 *
 * `roles` 单元格语法：多角色用 `+` 分隔；`dev-1/2` 展开为 `dev-1#1`、`dev-1#2`
 * （实例记号，P1 修订）；`队长`/`leader` 原样保留（校验豁免）。
 */

import { splitFrontmatter, stripPrismMarkerTail, type FrontmatterData, type FrontmatterValue } from '../frontmatter.js'
import type { DepositPolicy, TeamDefinition, TeamMember, WorkflowStage } from '../types.js'

/** 团队文件解析失败。 */
export class TeamParseError extends Error {
  readonly code = 'team_parse_failed'
  readonly line?: number
  readonly path?: string

  constructor(message: string, line?: number, path?: string) {
    super(`team_parse_failed: ${message}${line !== undefined ? ` (line ${line})` : ''}${path ? ` (${path})` : ''}`)
    this.name = 'TeamParseError'
    this.line = line
    this.path = path
  }
}

export interface ParseTeamOptions {
  sourcePath?: string
}

const WORKFLOW_HEADING = '## 工作流'

/** 解析团队 Markdown。frontmatter 不支持语法/表格非法时抛 TeamParseError。 */
export function parseTeamMarkdown(raw: string, opts: ParseTeamOptions = {}): TeamDefinition {
  let data: FrontmatterData | null
  let body: string
  try {
    ;({ data, body } = splitFrontmatter(raw))
  } catch (err) {
    throw new TeamParseError(err instanceof Error ? err.message : String(err), err instanceof Error && 'line' in err ? (err as { line?: number }).line : undefined, opts.sourcePath)
  }
  if (data === null) {
    throw new TeamParseError('缺少 frontmatter（--- 头）', undefined, opts.sourcePath)
  }

  const deposit = parseDeposit(data.deposit)
  // 工作流表格错误行号以**整份文件**计（design-v3 §7）：body 之前的行数 = 基准偏移
  const baseLine = raw.endsWith(body) ? raw.slice(0, raw.length - body.length).split('\n').length - 1 : 0
  const team: TeamDefinition = {
    team_id: str(data.team_id) ?? '',
    name: str(data.name) ?? '',
    description: str(data.description) ?? '',
    default: data.default === true,
    extends: data.extends === undefined ? null : str(data.extends) ?? null,
    members: parseMembers(data.members),
    skills: strArray(data.skills),
    knowledge: parseKnowledge(data.knowledge),
    deposit,
    arbitration: strArray(data.arbitration),
    rework_limit: typeof data.rework_limit === 'number' ? data.rework_limit : 2,
    workflow: parseWorkflowTable(body, baseLine),
    body: stripPrismMarkerTail(body),
  }
  return team
}

function parseDeposit(value: FrontmatterValue): DepositPolicy {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as {
    [key: string]: FrontmatterValue
  }
  const rules = Array.isArray(raw.rules)
    ? raw.rules.map((r) => {
        const item = (typeof r === 'object' && r !== null && !Array.isArray(r) ? r : {}) as {
          [key: string]: FrontmatterValue
        }
        return {
          match: plainRecord(item.match),
          set: plainRecord(item.set),
        }
      })
    : undefined
  return {
    enabled: raw.enabled === true,
    default_layer: (str(raw.default_layer) ?? 'project') as DepositPolicy['default_layer'],
    default_type: str(raw.default_type) ?? 'other',
    priority: (str(raw.priority) ?? 'medium') as DepositPolicy['priority'],
    require_note: raw.require_note === true,
    rules,
  }
}

function parseMembers(value: FrontmatterValue): TeamMember[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const record = (typeof item === 'object' && item !== null && !Array.isArray(item) ? item : {}) as {
      [key: string]: FrontmatterValue
    }
    return {
      role: str(record.role) ?? '',
      count: typeof record.count === 'number' ? record.count : 1,
    }
  })
}

function parseKnowledge(value: FrontmatterValue): TeamDefinition['knowledge'] {
  const record = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as {
    [key: string]: FrontmatterValue
  }
  const layers = strArray(record.layers).filter((l): l is 'global' | 'project' | 'role' =>
    (['global', 'project', 'role'] as const).includes(l as 'global' | 'project' | 'role'),
  )
  const books = strArray(record.books)
  return books.length > 0 ? { layers, books } : { layers }
}

/**
 * 解析 `## 工作流` 下的标准 Markdown 表格。
 * 无该小节 → 空数组（由上层校验提示）；表格存在但行不合法 → team_parse_failed 带行号。
 * @param baseLine 行号基准偏移（body 在整份文件中之前的行数；错误行号按整份文件计）。
 */
export function parseWorkflowTable(body: string, baseLine = 0): WorkflowStage[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const headingIdx = lines.findIndex((l) => l.trim() === WORKFLOW_HEADING)
  if (headingIdx === -1) return []

  // 找表头行：工作流小节内第一行含「负责角色」的表格行
  let headerCells: string[] | null = null
  const stages: WorkflowStage[] = []
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = baseLine + i + 1
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('|')) {
      if (headerCells !== null) break // 表格结束
      continue
    }
    if (!trimmed.startsWith('|')) continue
    const cells = splitTableRow(trimmed)
    if (headerCells === null) {
      if (!cells.includes('负责角色')) continue // 小节内的其他文字行
      headerCells = cells
      if (!mapHeader(cells)) {
        throw new TeamParseError(`工作流表头不合法：${cells.join(' | ')}`, lineNo, undefined)
      }
      continue
    }
    // 分隔行 | :--- | :--- |
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue
    const stage = parseRow(cells, headerCells, lineNo)
    if (stage) stages.push(stage)
  }
  return stages
}

function mapHeader(cells: string[]): boolean {
  // 必需列齐全才可解析（列序自由）
  const needed = ['#', '阶段', '负责角色', '输入', '输出', '完成判定']
  return needed.every((n) => cells.includes(n))
}

function parseRow(cells: string[], header: string[], line: number): WorkflowStage | null {
  if (cells.length !== header.length) {
    throw new TeamParseError(`工作流表格第 ${line} 行列数（${cells.length}）与表头（${header.length}）不一致`, line)
  }
  const get = (name: string): string => {
    const idx = header.indexOf(name)
    return idx === -1 ? '' : cells[idx].trim()
  }
  const orderText = get('#')
  const order = Number.parseInt(orderText, 10)
  if (orderText === '' || Number.isNaN(order)) {
    throw new TeamParseError(`工作流表格第 ${line} 行的「#」不是数字：${orderText}`, line)
  }
  const modeText = get('串/并行')
  const mode = modeText.includes('并行') ? 'parallel' : 'serial'
  return {
    order,
    stage: get('阶段'),
    roles: parseRoleCell(get('负责角色'), line),
    mode,
    input: get('输入'),
    output: get('输出'),
    done: get('完成判定'),
    reflow: get('回流路径'),
  }
}

/** 解析「负责角色」单元格：`+` 分隔多角色；`dev-1/2` 展开实例；`—` 空。 */
export function parseRoleCell(cell: string, line: number): string[] {
  const text = cell.trim()
  if (text === '' || text === '—' || text === '-') return []
  const tokens = text.split('+').map((t) => t.trim()).filter((t) => t !== '' && t !== '—')
  const roles: string[] = []
  for (const token of tokens) {
    const shorthand = /^([^/#]+)\/(\d+)$/.exec(token)
    if (shorthand) {
      const n = Number.parseInt(shorthand[2], 10)
      if (Number.isNaN(n) || n < 1) {
        throw new TeamParseError(`工作流表格第 ${line} 行的实例记号不合法：${token}`, line)
      }
      for (let k = 1; k <= n; k++) roles.push(`${shorthand[1].trim()}#${k}`)
    } else {
      roles.push(token)
    }
  }
  return roles
}

function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function plainRecord(value: FrontmatterValue): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function str(value: FrontmatterValue): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strArray(value: FrontmatterValue): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}
