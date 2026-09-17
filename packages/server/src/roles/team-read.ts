/**
 * 单个团队的**读侧单点**（v11 派修 M-3）：`GET /api/teams/:id` 与 MCP `prism_team_get`
 * 共用同一包装——两处各自实现过一次（HTTP 在 `people.ts`、MCP 只走 `requireTeam`），
 * 结果 MCP 面拿不到 `workflow_raw`/`source_mtime`，而 `prism_team_edit` 的 schema 又以
 * 「rowId 取自 GET」「if_match 取 GET 的 source_mtime」为前置（照 schema 走必丢未映射列）。
 *
 * 形状与 HTTP 响应片段**逐字段一致**（内层 camelCase：`rowIds`/`prose`/`proseText` 等），
 * 故两个消费方直接 spread，不产生第二份映射。
 */

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { parseWorkflowSection, resolveTeamFile } from '@prism/agents'
import type { TeamDefinition, ValidationIssue } from '@prism/agents'

import { loadTeam } from './wiring.js'

/** `workflow_raw` 字段形状（GET /api/teams/:id 与 MCP prism_team_get 一致）。 */
export interface TeamWorkflowRaw {
  columns: string[]
  rows: string[][]
  rowIds: string[]
  /** 未映射列名。 */
  unmapped: string[]
  /** 小节在但无表格。 */
  prose: boolean
  /** 全文无 `## 工作流` 小节。 */
  sectionMissing: boolean
  /** prose 原文（字符串恒存在；非 prose 为 ''）。 */
  proseText: string
}

export interface TeamReadDetail {
  /** 团队定义（`issues` 已并入读侧 ParseIssue 的 warning）。 */
  team: TeamDefinition
  workflow_raw: TeamWorkflowRaw
  /** 被编辑文件本体的 epoch 毫秒整数（写入 `if_match` 用）。 */
  source_mtime: number
}

/**
 * 读团队 + 工作流底账：`loadTeam`（含 extends 合并）→ `resolveTeamFile`（**落点单点**）→
 * 读该文件本体 → `parseWorkflowSection`。
 *
 * `workflow_raw` 取**被编辑文件本体**的小节原文——**不经 extends 合并**（否则写回会打到错文件）；
 * 返回 `null` = 团队不存在（两形态都不在，或 loadTeam 与落点判定分叉）。
 */
export async function readTeamDetail(
  teamsDir: string,
  teamId: string,
  opts: { rolesDir?: string; knownSkills?: string[] } = {},
): Promise<TeamReadDetail | null> {
  const team = await loadTeam(teamsDir, teamId, opts)
  if (team === null) return null
  const file = resolveTeamFile(teamsDir, teamId)
  if (file === null) return null
  const parsed = parseWorkflowSection(await readFile(file, 'utf-8'))
  return {
    team: {
      ...team,
      issues: [
        ...(team.issues ?? []),
        ...parsed.issues.map(
          (issue): ValidationIssue => ({
            level: 'warning',
            code: issue.code,
            message: issue.line !== undefined ? `${issue.message}（第 ${issue.line} 行）` : issue.message,
          }),
        ),
      ],
    },
    workflow_raw: {
      columns: parsed.raw?.columns ?? [],
      rows: parsed.raw?.rows ?? [],
      rowIds: parsed.raw?.rowIds ?? [],
      unmapped: parsed.unmappedColumns,
      prose: parsed.prose === true,
      sectionMissing: parsed.sectionMissing === true,
      proseText: parsed.proseText ?? '',
    },
    source_mtime: Math.round(statSync(file).mtimeMs),
  }
}
