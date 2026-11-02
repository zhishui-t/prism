/**
 * AGENTS.md 注入块（knowledge-injection.md §5 模式 C）。
 *
 * 把「已接入 Prism + 先查再答」的指引写进项目 AGENTS.md 的**标记块**内：
 * - 已有块 → 只更新块内内容（块外用户手写内容一字不动）；
 * - 无块 → 追加到末尾；
 * - 文件不存在 → 创建。
 *
 * 红线：只动 `<!-- prism:begin -->…<!-- prism:end -->` 之间的内容，
 * 块内视为 Prism 管辖（用户手改会被下次更新覆盖，设计明示）。
 */

import { readFile, writeFile } from 'node:fs/promises'

import { PrismError } from '@prism/core'

export const PRISM_BLOCK_BEGIN = '<!-- prism:begin -->'
export const PRISM_BLOCK_END = '<!-- prism:end -->'

/** 团队约定块的起止标记（各适配器 `renderTeamInstructions` 的标记契约**单点**——防镜像漂移）。 */
export function teamBlockStart(teamId: string): string {
  return `<!-- prism:team:${teamId}:start -->`
}

/** 团队约定块的结束标记（与 {@link teamBlockStart} 成对）。 */
export function teamBlockEnd(teamId: string): string {
  return `<!-- prism:team:${teamId}:end -->`
}

/** 生成的块内容（不带 begin/end 标记）。 */
function blockContent(options: { teamId?: string; mcpHint?: boolean }): string {
  const lines: string[] = ['## Prism 知识库与代码图谱', '']
  if (options.teamId !== undefined) {
    lines.push(`当前团队：\`${options.teamId}\`（约定以团队定义为准）。`, '')
  }
  lines.push(
    '本项目已接入 Prism。回答架构/规范问题前，**先查询 Prism**（不要凭记忆回答）：',
    '',
    '- 知识检索：`prism_kb_search`（支持按层/书/模块过滤）',
    '- 代码图谱：`prism_graph_query` / `prism_graph_path` / `prism_graph_explain`',
    '- 变更影响面：`prism_graph_affected`',
    '- 团队知识包：`prism_context_pack`（按角色知识绑定组装上下文）',
    '',
    '知识分层：global（公司规范）/ project（本项目）/ role（专家专属）。',
    '引用知识时标注来源地址（如 `global/java-standards/exception-handling/JAVA-01-002@v2`）。',
  )
  if (options.mcpHint !== false) {
    lines.push(
      '',
      '工具经 MCP 调用；CLI 等价命令见 `prism --help`（知识库 `prism kb …`、图谱 `prism graph …`）。',
    )
  }
  return lines.join('\n')
}

export interface InjectResult {
  path: string
  /** created=新建文件；appended=追加块；updated=更新已有块 */
  action: 'created' | 'appended' | 'updated'
}

/** 检测文本中的 prism 块位置（无 → null）。 */
export function findPrismBlock(text: string): { start: number; end: number } | null {
  const begin = text.indexOf(PRISM_BLOCK_BEGIN)
  if (begin === -1) return null
  const end = text.indexOf(PRISM_BLOCK_END, begin)
  if (end === -1) return null
  return { start: begin, end: end + PRISM_BLOCK_END.length }
}

/** 判断 AGENTS.md 是否已含 prism 块（幂等检测）。 */
export function hasPrismBlock(text: string): boolean {
  return findPrismBlock(text) !== null
}

/**
 * 注入/更新 AGENTS.md 的 prism 块。
 *
 * @param path AGENTS.md 路径（通常是项目根）
 * @param options teamId 显示当前团队；mcpHint=false 时省略 CLI 提示行
 */
export async function injectAgentsBlock(
  path: string,
  options: { teamId?: string; mcpHint?: boolean } = {},
): Promise<InjectResult> {
  const block = `${PRISM_BLOCK_BEGIN}\n${blockContent(options)}\n${PRISM_BLOCK_END}`
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    // 文件不存在 → 创建（只含块）
    await writeFile(path, `${block}\n`, 'utf-8')
    return { path, action: 'created' }
  }

  const pos = findPrismBlock(text)
  if (pos === null) {
    // 无块 → 追加到末尾（保留原内容，块前置空行分隔）
    const separator = text.endsWith('\n') || text === '' ? '' : '\n'
    await writeFile(path, `${text}${separator}\n${block}\n`, 'utf-8')
    return { path, action: 'appended' }
  }
  // 已有块 → 只替换块内内容
  await writeFile(path, text.slice(0, pos.start) + block + text.slice(pos.end), 'utf-8')
  return { path, action: 'updated' }
}

/** 移除 prism 块（卸载用；块外内容保留）。返回是否确实移除了。 */
export async function removeAgentsBlock(path: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return false
  }
  const pos = findPrismBlock(text)
  if (pos === null) return false
  let next = text.slice(0, pos.start) + text.slice(pos.end)
  // 清掉块前后的多余空行残留
  next = next.replace(/\n{3,}/g, '\n\n')
  await writeFile(path, next, 'utf-8')
  return true
}

export interface TeamBlockResult {
  path: string
  teamId: string
  action: 'created' | 'appended' | 'updated'
}

/**
 * 注入/更新**团队约定块**（`<!-- prism:team:<id>:start/end -->`）。
 *
 * 内容由适配器 `renderTeamInstructions` 渲染（编制表 + 工作流 + 仲裁链 + 返工上限），
 * 本函数只做标记块合并——与 `prism:begin/end` 知识块同一套纪律：
 * - 已有块 → 只替换块内（含该团队 id 的标记区间），块外用户手写内容一字不动；
 * - 无块 → 追加到末尾；文件不存在 → 创建；
 * - **不同团队各自独立标记块、可共存**（切团队 = 各自注入各自更新，互不覆盖）；
 * - 半截块自愈：start 在而 end 被人手删了 → 从 start 到文末整段替换。
 *
 * `rendered` 必须含该团队的起止标记（适配器契约），否则拒绝写盘（不写无标记的裸内容）。
 */
export async function injectTeamBlock(path: string, teamId: string, rendered: string): Promise<TeamBlockResult> {
  const start = teamBlockStart(teamId)
  const end = teamBlockEnd(teamId)
  if (!rendered.includes(start) || !rendered.includes(end)) {
    throw new PrismError('bad_request', `团队约定块渲染结果缺起止标记（${start} … ${end}）——适配器 renderTeamInstructions 契约破坏`)
  }
  const block = rendered.trimEnd()
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    await writeFile(path, `${block}\n`, 'utf-8')
    return { path, teamId, action: 'created' }
  }
  const s = text.indexOf(start)
  if (s === -1) {
    const separator = text.endsWith('\n') || text === '' ? '' : '\n'
    await writeFile(path, `${text}${separator}\n${block}\n`, 'utf-8')
    return { path, teamId, action: 'appended' }
  }
  const e = text.indexOf(end, s)
  const spanEnd = e === -1 ? text.length : e + end.length
  await writeFile(path, text.slice(0, s) + block + text.slice(spanEnd), 'utf-8')
  return { path, teamId, action: 'updated' }
}

/**
 * 移除**全部**团队约定块（卸载用；`<!-- prism:team:<id>:start -->…<!-- prism:team:<id>:end -->`）。
 * 团队块整体是 Prism 管辖面（同 `prism:begin/end` 纪律）——卸载即全部摘除，不残留过期约束。
 * 返回移除的块数（半截块——start 在 end 缺——同样从 start 摘到文末）。
 */
export async function removeTeamBlocks(path: string): Promise<number> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return 0
  }
  const startRe = /<!-- prism:team:[^\s>]*:start -->[^\n]*\n?/g
  const matches = [...text.matchAll(startRe)]
  if (matches.length === 0) return 0
  let next = text
  for (const m of matches.reverse()) {
    const s = m.index ?? 0
    const endMarkerRe = /<!-- prism:team:[^\s>]*:end -->/
    const rest = next.slice(s + m[0].length)
    const endMatch = endMarkerRe.exec(rest)
    const spanEnd = endMatch === null ? next.length : s + m[0].length + endMatch.index + endMatch[0].length
    next = next.slice(0, s) + next.slice(spanEnd)
  }
  next = next.replace(/\n{3,}/g, '\n\n')
  await writeFile(path, next, 'utf-8')
  return matches.length
}
