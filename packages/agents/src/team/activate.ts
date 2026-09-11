/**
 * 启用团队（harness-adapters §6）：返回团队运行时配置 + 每个成员的装配/派发状态。
 *
 * 判定规则（装配语义简化后）：
 * - `installed` = **roles_dir（角色受管目录，新模型下即宿主目录）中存在该角色文件**
 *   （扁平 `<role>.md` 或目录式 `<role>/AGENTS.md` 均认）；
 * - `dispatch` **仅由 installed 推导**：installed → native，否则 fallback；
 *   会话是否已重扫由 hint 提示（Prism 感知不了宿主会话生命周期）；
 * - `definition` = 从 rolesDir 解析出的角色定义本体，供 fallback 派发把契约粘进 prompt；
 * - `targetDir`（可选，兼容旧调用方）：提供且与 rolesDir 不同时，追加判定该目录下的
 *   扁平产物（旧「复制装配」语义的落点）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseRoleMarkdown } from '../role/parse.js'
import type { RoleDefinition, TeamActivation, TeamDefinition } from '../types.js'

export interface ActivateTeamOptions {
  /** 角色受管目录（resolveDirs().rolesDir；兼容扁平与目录式）。 */
  rolesDir: string
  /** 兼容旧签名：显式装配目标目录（旧复制语义的落点）。新模型下 roles_dir 即宿主目录，无需传。 */
  targetDir?: string
}

export async function activateTeam(team: TeamDefinition, opts: ActivateTeamOptions): Promise<TeamActivation> {
  const members = team.members.map((member) => {
    const installed = isInstalled(opts.rolesDir, member.role, opts.targetDir)
    const definition = loadDefinition(opts.rolesDir, member.role)
    const activation: TeamActivation['members'][number] = {
      role: member.role,
      count: member.count,
      installed,
      dispatch: installed ? 'native' : 'fallback',
    }
    if (definition !== undefined) activation.definition = definition
    if (!installed) {
      activation.hint = definition
        ? `角色 ${member.role} 未落在宿主角色目录：当前会话请用 general-purpose 兜底派发并把 definition 契约粘进 prompt；或先运行 prism role init ${member.role}（或直接在该目录写 ${member.role}.md）并重启会话以启用原生派发`
        : `角色 ${member.role} 在角色受管目录（${opts.rolesDir}）中不存在：无法降级派发，请先补齐角色定义（prism role init ${member.role}）`
    }
    return activation
  })

  return {
    team_id: team.team_id,
    team_name: team.name,
    members,
    workflow: team.workflow,
    skills: team.skills,
    knowledge: team.knowledge,
    deposit: team.deposit,
    arbitration: team.arbitration,
    rework_limit: team.rework_limit,
  }
}

/** roles_dir（新模型）或显式 targetDir（旧复制语义）中是否存在该角色文件。 */
function isInstalled(rolesDir: string, role: string, targetDir?: string): boolean {
  // 旧调用方（源目录 ≠ 装配目标）：installed 仅由显式 targetDir 判定（复制装配语义）
  if (targetDir !== undefined && targetDir !== rolesDir) {
    return existsSync(join(targetDir, `${role}.md`))
  }
  // 新模型：roles_dir 即宿主目录，定义存在即已安装（双形态）
  if (existsSync(join(rolesDir, `${role}.md`))) return true
  return existsSync(join(rolesDir, role, 'AGENTS.md'))
}

function loadDefinition(rolesDir: string, role: string): RoleDefinition | undefined {
  for (const candidate of [join(rolesDir, `${role}.md`), join(rolesDir, role, 'AGENTS.md')]) {
    if (!existsSync(candidate)) continue
    try {
      return parseRoleMarkdown(readFileSync(candidate, 'utf8'), { sourcePath: candidate })
    } catch {
      // 定义文件损坏（frontmatter 不支持语法等）：activate 不中断，
      // 该角色按「无定义本体」处理（hint 会提示无法降级派发）；损坏详情由 import/validate 链路报告。
      return undefined
    }
  }
  return undefined
}
