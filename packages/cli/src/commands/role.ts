import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  checkPrincipleConsistency,
  editRole,
  loadRole,
  loadRoles,
  loadTeams,
  newRole,
  removeRole,
  roleNotFoundMessage,
  roleRendererFor,
  installedSkillNames,
  type KnowledgeBinding,
  type RoleColor,
  type RoleDefinition,
} from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { dirProvenanceLabel, expandHome, guardWriteTarget, readStdinDefault, resolveTargetDirs } from '../argv.js'

/**
 * `prism role list|show|new|edit|rm|validate|render`。
 * 目录统一走 resolveDirs：`<PRISM_HOME>/prism.yaml`（可选）覆盖适配器默认；`~` 由 CLI 层展开。
 *
 * 形态口径（2026-09-12）：角色**直接住在 roles_dir**（默认宿主 agents 目录），Prism 不持有副本，
 * 因此没有「装配/导入」这一步。写盘一律走适配器声明的**宿主原生形态**：
 * - `new`  → 渲染 + 写；只给名字写骨架，给了字段就写填好的定义；
 * - `edit` → 外科式字段补丁（正文不重排）；
 * - `rm`   → 删文件本体（默认宿主目录需 `--yes`）。
 * 三个动词在 CLI / HTTP / MCP 上同名同位（`prism_role_new|edit|rm`、`POST|PATCH|DELETE /api/roles`）。
 */
export async function runRole(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const dirs = resolveTargetDirs(ctx, values)
  // v6.1：`--source` 对读写**一律生效**（此前只被 list/show/validate/render 用，写命令静默忽略
  // → `role rm --source <dir>` 实际删的是默认宿主目录那份，不可逆）。显式给出即视为「用户指定了
  // 目录」，与 --harness-root 同口径解除写守卫（目标已不是默认宿主目录）。
  const sourceExplicit = values.source !== undefined
  const rolesDir = sourceExplicit ? expandHome(values.source!) : dirs.rolesDir
  const writeDirs = sourceExplicit ? { ...dirs, guard: { ...dirs.guard, roles: false } } : dirs
  // 根目录取自解析结果（未显式指定时 = 激活适配器的默认根，不再是硬编码 ~/.zcode）
  const harnessRoot = dirs.harnessRoot
  /** 宿主原生形态渲染器（`new` 用；`edit` 走外科式补丁，不需要它）。 */
  const renderRole = roleRendererFor(harnessRoot, ctx.home)

  switch (sub) {
    case 'list': {
      const roles = await loadRoles(rolesDir, { knownSkills: await installedSkillNames(harnessRoot, ctx.home) })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: roles }))
        return 0
      }
      if (roles.length === 0) {
        ctx.stdout(`角色库为空: ${rolesDir}（用 prism role new <name> 新建，或直接在该目录写 <name>.md）`)
        return 0
      }
      for (const role of roles) {
        const errors = (role.issues ?? []).filter((i) => i.level === 'error').length
        const warnings = (role.issues ?? []).filter((i) => i.level === 'warning').length
        const tag = errors + warnings > 0 ? `issues(${errors}E/${warnings}W)` : 'ok'
        ctx.stdout(`${role.name}  ${role.description.split('\n')[0].slice(0, 60)}  skills=[${role.skills.join(',') || '待填'}]  ${tag}`)
      }
      ctx.stdout(`共 ${roles.length} 个角色（数据源 ${rolesDir}）`)
      return 0
    }

    case 'show': {
      const name = rest[0]
      if (name === undefined) {
        ctx.stderr('用法: prism role show <name> [--source <dir>]')
        return 1
      }
      const role = await loadRole(rolesDir, name, { knownSkills: await installedSkillNames(harnessRoot, ctx.home) })
      if (role === null) {
        ctx.stderr(`错误 [not_found] ${roleNotFoundMessage(rolesDir, name)}`)
        return 1
      }
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: role }))
        return 0
      }
      ctx.stdout(`name: ${role.name}`)
      ctx.stdout(`description: ${role.description.split('\n')[0]}`)
      if (role.color !== undefined) ctx.stdout(`color: ${role.color}`)
      if (role.model !== undefined) ctx.stdout(`model: ${role.model}`)
      if (role.thoughtLevel !== undefined) ctx.stdout(`thoughtLevel: ${role.thoughtLevel}`)
      ctx.stdout(`skills: [${role.skills.join(', ')}]`)
      ctx.stdout(`knowledge.layers: [${role.knowledge.layers.join(', ')}]`)
      for (const issue of role.issues ?? []) {
        ctx.stdout(`${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
      }
      ctx.stdout('--- 正文 ---')
      ctx.stdout(role.body)
      return 0
    }

    case 'new': {
      const name = rest[0]
      if (name === undefined) {
        ctx.stderr(ROLE_NEW_USAGE)
        return 1
      }
      // B6 写守卫：目标为默认宿主目录（未经显式指定）时需 --yes 确认
      if (!guardWriteTarget(ctx, values, writeDirs, 'roles', 1)) return 1
      if (!ctx.json) {
        ctx.stdout(`目标 roles_dir: ${rolesDir}（来源：${sourceExplicit ? '--source' : dirProvenanceLabel(dirs.provenance.roles)}）`)
      }

      // `--from`：复用既有角色的正文（描述/skills/知识绑定也可作缺省）
      let from: RoleDefinition | undefined
      const fromName = values.from
      if (fromName !== undefined) {
        const loaded = await loadRole(rolesDir, fromName)
        if (loaded === null) {
          ctx.stderr(`错误 [not_found] --from 源角色不存在：${fromName}（数据源 ${rolesDir}）`)
          return 1
        }
        from = loaded
      }

      // 正文：`--body-file` 优先于 `--from`
      let body: string | undefined
      try {
        body = (await readBodyFile(ctx, values)) ?? from?.body
      } catch (error) {
        ctx.stderr(`错误 [bad_request] 读取 --body-file 失败：${error instanceof Error ? error.message : String(error)}`)
        return 1
      }

      const explicitLayers = parseLayers(values.layers)
      const books = parseCsv(values.books)
      let knowledge: KnowledgeBinding | undefined
      if (explicitLayers !== undefined || books !== undefined) {
        knowledge = { layers: explicitLayers ?? ['global', 'project'], ...(books !== undefined ? { books } : {}) }
      } else if (from !== undefined) {
        knowledge = from.knowledge
      }
      const skills = parseCsv(values.skills) ?? from?.skills
      const description = values.description ?? from?.description

      try {
        const result = await newRole({
          name,
          rolesDir,
          ...(description !== undefined ? { description } : {}),
          ...(skills !== undefined ? { skills } : {}),
          ...(knowledge !== undefined ? { knowledge } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(optional(values.color) !== undefined ? { color: optional(values.color) as RoleColor } : {}),
          ...(optional(values.model) !== undefined ? { model: optional(values.model)! } : {}),
          ...(optional(values['thought-level']) !== undefined
            ? { thoughtLevel: optional(values['thought-level'])! }
            : {}),
          ...(values.force === true ? { force: true } : {}),
          renderRole,
        })
        if (ctx.json) {
          ctx.stdout(JSON.stringify({ ok: true, value: { rolesDir, name, ...result } }))
          return 0
        }
        for (const p of result.written) ctx.stdout(`  已创建 ${p}`)
        for (const s of result.skipped) ctx.stdout(`  跳过 ${s.path}: ${s.reason}`)
        if (result.written.length > 0) {
          ctx.stdout(`角色 ${name} 已创建（宿主原生形态：frontmatter 只含宿主白名单字段，skills/知识绑定落在正文小节）`)
          if (description === undefined) ctx.stdout('提示: 描述仍是占位 TODO——用 prism role edit ' + name + ' --description "…" 补上')
          ctx.stdout('提示: prism role validate 可看到待填项；宿主在会话启动时扫描角色——下一会话生效')
        } else {
          ctx.stdout(`角色 ${name} 已存在，未做任何改动`)
        }
        return 0
      } catch (error) {
        return reportError(ctx, error)
      }
    }

    case 'edit': {
      const name = rest[0]
      if (name === undefined) {
        ctx.stderr(ROLE_EDIT_USAGE)
        return 1
      }
      const explicitLayers = parseLayers(values.layers)
      const books = parseCsv(values.books)
      let body: string | undefined
      try {
        body = await readBodyFile(ctx, values)
      } catch (error) {
        ctx.stderr(`错误 [bad_request] 读取 --body-file 失败：${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
      const patch = {
        ...(values.description !== undefined ? { description: values.description } : {}),
        ...(values.skills !== undefined ? { skills: parseCsv(values.skills) ?? [] } : {}),
        ...(explicitLayers !== undefined || books !== undefined
          ? { knowledge: { layers: explicitLayers ?? [], ...(books !== undefined ? { books } : {}) } }
          : {}),
        ...(body !== undefined ? { body } : {}),
        ...(clearable(values.color) !== undefined ? { color: clearable(values.color)! } : {}),
        ...(clearable(values.model) !== undefined ? { model: clearable(values.model)! } : {}),
        ...(clearable(values['thought-level']) !== undefined
          ? { thoughtLevel: clearable(values['thought-level'])! }
          : {}),
      }
      if (Object.keys(patch).length === 0) {
        ctx.stderr('错误 [bad_request] 未给出任何要修改的字段')
        ctx.stderr(ROLE_EDIT_USAGE)
        return 1
      }
      if (!guardWriteTarget(ctx, values, writeDirs, 'roles', 1)) return 1
      try {
        const result = await editRole({ name, rolesDir, patch })
        if (ctx.json) {
          ctx.stdout(JSON.stringify({ ok: true, value: { rolesDir, name, ...result, fields: Object.keys(patch) } }))
          return 0
        }
        for (const p of result.written) ctx.stdout(`  已更新 ${p}`)
        ctx.stdout(`角色 ${name} 已更新（改动字段: ${Object.keys(patch).join(', ')}；正文与未知 frontmatter 键原样保留）`)
        return 0
      } catch (error) {
        return reportError(ctx, error)
      }
    }

    case 'rm': {
      const name = rest[0]
      if (name === undefined) {
        ctx.stderr('用法: prism role rm <name> [--source <dir>] [--harness-root <dir>|--yes]')
        return 1
      }
      if (!guardWriteTarget(ctx, values, writeDirs, 'roles', 1, 'delete')) return 1
      try {
        const result = await removeRole({ name, rolesDir: rolesDir })
        if (ctx.json) {
          ctx.stdout(JSON.stringify({ ok: true, value: { name, removed: result.removed } }))
          return 0
        }
        for (const p of result.removed) ctx.stdout(`  已删除 ${p}`)
        ctx.stdout(`角色 ${name} 已删除（不可逆；宿主在会话启动时扫描——下一会话生效）`)
        return 0
      } catch (error) {
        return reportError(ctx, error)
      }
    }

    case 'validate': {
      const roles = await loadRoles(rolesDir, { knownSkills: await installedSkillNames(harnessRoot, ctx.home) })
      // 原则一致性（role-definition.md §2.1）：跨角色 + 团队仲裁链的组合校验
      const teams = await loadTeams(dirs.teamsDir)
      const consistency = checkPrincipleConsistency({ roles, teams })
      const consistencyIssues: Array<{ role: string; level: string; code: string; message: string }> = []
      for (const [name, issues] of consistency.entries()) {
        for (const issue of issues) {
          consistencyIssues.push({ role: name, level: issue.level, code: issue.code, message: issue.message })
        }
      }
      const invalid = roles.filter((r) => (r.issues ?? []).some((i) => i.level === 'error'))
      if (ctx.json) {
        ctx.stdout(
          JSON.stringify({
            ok: invalid.length === 0,
            value: {
              roles: roles.map((r) => ({
                name: r.name,
                ok: (r.issues ?? []).every((i) => i.level !== 'error'),
                issues: [...(r.issues ?? []), ...(consistency.get(r.name) ?? [])],
              })),
              consistency: consistencyIssues,
            },
          }),
        )
      } else {
        for (const role of roles) {
          const issues = role.issues ?? []
          if (issues.length === 0) {
            ctx.stdout(`${role.name}: ok`)
          }
          for (const issue of issues) {
            ctx.stdout(`${role.name}: ${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
          }
        }
        for (const issue of consistencyIssues) {
          ctx.stdout(`${issue.role}: WARN [${issue.code}] ${issue.message}`)
        }
        ctx.stdout(
          `校验 ${roles.length} 个角色: ${invalid.length === 0 ? '全部通过' : `${invalid.length} 个存在 error`}` +
            (consistencyIssues.length > 0 ? `（另 ${consistencyIssues.length} 条原则一致性提示）` : ''),
        )
      }
      return invalid.length === 0 ? 0 : 1
    }

    case 'render': {
      const name = rest[0]
      if (name === undefined) {
        ctx.stderr('用法: prism role render <name> [--model <id>] [--thought-level low|high|max]')
        return 1
      }
      const role = await loadRole(rolesDir, name)
      if (role === null) {
        ctx.stderr(`错误 [not_found] ${roleNotFoundMessage(rolesDir, name)}`)
        return 1
      }
      const content = renderRole({
        ...role,
        ...(values.model !== undefined ? { model: values.model } : {}),
        ...(values['thought-level'] !== undefined
          ? { thoughtLevel: values['thought-level'] as RoleDefinition['thoughtLevel'] }
          : {}),
      })
      if (ctx.json) {
        // target = **真实落点**（rolesDir，即宿主 agents 目录或 prism.yaml 的覆盖值）——
        // 与 MCP `prism_role_render` 同一口径（旧写法固定拼 harnessRoot/agents 会在
        // prism.yaml 覆盖 roles_dir 时报出一个文件并不在的路径）
        ctx.stdout(JSON.stringify({ ok: true, value: { name, target: join(rolesDir, `${name}.md`), content } }))
      } else {
        ctx.stdout(content)
      }
      return 0
    }

    default:
      ctx.stderr(`未知子命令: role ${sub ?? ''}\n用法: prism role list|show|new|edit|rm|validate|render`)
      return 1
  }
}

const ROLE_NEW_USAGE =
  '用法: prism role new <name> [--source <dir>] [--description <述>] [--skills a,b] [--layers global,project] [--books x,y] [--color <色>] [--model <id>] [--thought-level low|high|max] [--from <角色>] [--body-file <md|->] [--force] [--harness-root <dir>|--yes]'

const ROLE_EDIT_USAGE =
  '用法: prism role edit <name> [--source <dir>] [--description <述>] [--skills a,b] [--layers global,project] [--books x,y] [--color <色>] [--model <id>] [--thought-level low|high|max] [--body-file <md|->] [--harness-root <dir>|--yes]'

/** `--body-file <md|->`（`-` 读 stdin）；未给 → undefined。 */
async function readBodyFile(ctx: CommandContext, values: ArgValues): Promise<string | undefined> {
  const target = values['body-file']
  if (target === undefined) return undefined
  if (target === '-') return await (ctx.readStdin ?? readStdinDefault)()
  return readFileSync(expandHome(target), 'utf8')
}

/** 逗号分隔列表（trim + 去空）；无有效项 → undefined。 */
function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const items = value.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return items.length > 0 ? items : undefined
}

/** `--layers` → 合法层名集合（未知层名丢弃；无有效项 → undefined）。 */
function parseLayers(value: string | undefined): KnowledgeBinding['layers'] | undefined {
  const items = parseCsv(value)
  if (items === undefined) return undefined
  const allowed = ['global', 'project', 'role'] as const
  return items.filter((l): l is (typeof allowed)[number] => (allowed as readonly string[]).includes(l))
}

/** `new` 的可选串字段：未给或空串 → `undefined`（不写该字段）。 */
function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** `edit` 的可选串字段：未给 → `undefined`（不改）；**空串 → `null`（清除该 frontmatter 键）**。 */
function clearable(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 统一错误出口：agents 的 RoleWriteError 带 code；其余归 bad_request。 */
function reportError(ctx: CommandContext, error: unknown): number {
  const code = (error as { code?: string }).code ?? 'bad_request'
  ctx.stderr(`错误 [${code}] ${error instanceof Error ? error.message : String(error)}`)
  return 1
}
