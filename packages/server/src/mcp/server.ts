import { createInterface } from 'node:readline'

import { access, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  prismHome,
  PrismError,
} from '@prism/core'
import {
  buildArchitectureIr,
  buildDataflowIr,
  buildSequenceIr,
  buildTaskLifecycleIr,
  buildTeamWorkflowIr,
  ensureHarnessPluginsLoaded,
} from '@prism/agents'
import { listBuiltinSkills } from '@prism/skills'

import {
  activateTeam,
  createRoleDefinition,
  createTeamDefinition,
  deleteRoleDefinition,
  deleteTeamDefinition,
  installedSkillNames,
  installBuiltinSkillDefinitions,
  loadEffectiveSkills,
  loadRole,
  loadRoles,
  loadTeam,
  loadTeams,

  readTeamDetail,
  renderZcodeTeam,
  resolveDirsFromHome,
  harnessPaths,
  harnessAdapterOf,
  parseCategorizeInput,
  roleNotFoundMessage,
  roleRendererFor,
  SkillCategoryStore,
  teamNotFoundMessage,
  uninstallSkillDefinitions,
  updateRoleDefinition,
  updateTeamDefinition,
  type NewTeamBody,
  type RoleWriteBody,
  type UpdateTeamBody,
} from '../roles/index.js'
import {
  runGraphify,
  readCodeGraph,
  graphPath as queryGraphPath,
  graphExplain as queryGraphExplain,
  graphAffected as queryGraphAffected,
  graphGodNodes as queryGraphGodNodes,
  graphSummary as queryGraphSummary,
} from '../graph/graphify.js'
import { renderDiagram, writeArtifactMeta } from '../graph/archify.js'
import { assertProjectRoot, resolveArchPlacement, sanitizeArtifactName } from '../graph/arch-placement.js'
import { inspectGraphStatus, ProjectRegistry } from '../graph/registry.js'
import { mergeProjectGraphs, type MergeProjectInput } from '../graph/merge.js'
import { convertFileToMarkdown } from '../kb/convert-file.js'
import { makeDryRunKb, scanProject } from '../kb/scan.js'
import type { GraphQuery, KnowledgeService, Layer, SearchQuery } from '../kb/port.js'
import { depositWithPolicy, type DepositRequest } from '../kb/deposit-entry.js'
import { loadKnowledgeService } from '../kb/wiring.js'
import { buildContextPack } from '../kb/context-pack.js'
import { writeEnrichment } from '../kb/enrich-writeback.js'
import { DEFAULT_SERVE_PORT, ensureServe } from '../serve-control.js'
import { trashStoreFor } from '../trash.js'

/**
 * MCP stdio 服务（design.md §4 最小集 + design-v3 §3.4 P6 增量，手写 JSON-RPC 2.0）：
 * 知识库 / 图谱 / 角色 / 团队 / 技能，共 48 个工具（v6：角色与团队补齐增删改查；
 * v12 F4：技能分类清单增删改 `prism_skill_category_add|rename|rm`）。
 * ⚠ 上面这个数是**对外口径**，由 `packages/server/test/tool-surface-drift.test.ts` 锁定（MIN-1）。
 * 独立进程运行（`node dist/mcp/server.js`），与 prism serve 经 SQLite WAL 并存。
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602

export interface McpDeps {
  home: string
  /**
   * 宿主根目录（`role_render` 目标提示、`team_activate` 判装配状态）。
   * 缺省由**配置激活的适配器**的默认根决定（`prism.yaml: harness` → 插件 `defaultRoot`）；
   * `PRISM_HARNESS_ROOT` 可覆盖。**不是**硬编码的 `~/.zcode`——那会把插件路径钉死（v6 修）。
   */
  harnessRoot?: string
  kb?: KnowledgeService
  kbFactory?: () => Promise<KnowledgeService>
  graphifyEnv?: NodeJS.ProcessEnv
  graphifyTimeoutMs?: number
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * MCP 工具集：`McpTool[]` + 一个**释放钩子**。
 *
 * 为什么要 close：`kb()` 是**惰性**打开 SQLite 的（知识库），
 * 若调用方不释放，句柄会挂到进程结束——Windows 上表现为「临时目录里的
 * `*.db/-wal/-shm` 删不掉」，e2e 长期静默堆积（F-T1 实测：修前 `D:\tmp` 积压 97 个）。
 * 类型是数组的交叉，既有消费方（`for (const t of tools)` / `tools.length`）不受影响。
 */
export type McpToolSet = McpTool[] & { close: () => void }

/** 组装 MCP 工具集（依赖注入便于测试）。 */
export function createMcpTools(deps: McpDeps): McpToolSet {
  let kbCache: (KnowledgeService & { close?: () => void }) | undefined
  const kb = async (): Promise<KnowledgeService> => {
    if (deps.kb !== undefined) {
      return deps.kb
    }
    if (kbCache === undefined) {
      kbCache = await (deps.kbFactory ?? (() => loadKnowledgeService(deps.home)))()
    }
    return kbCache
  }

  const registry = new ProjectRegistry(deps.home)

  const requireProjectRoot = async (name: string): Promise<{ project: string; root: string }> => {
    const info = await registry.get(name)
    return { project: info.project, root: info.root }
  }

  const graphQuery = async (args: Record<string, unknown>): Promise<unknown> => {
    const q = typeof args.q === 'string' ? args.q.trim() : ''
    const projectName = typeof args.project === 'string' ? args.project.trim() : ''
    if (q === '' || projectName === '') {
      throw new Error('prism_graph_query 需要 { q, project }')
    }
    const { root } = await requireProjectRoot(projectName)
    const graph = join(root, 'graphify-out', 'graph.json')
    try {
      await access(graph)
    } catch {
      throw new Error(`图谱不存在: ${graph}（请先建图）`)
    }
    const result = await runGraphify(['query', q, '--graph', graph], {
      cwd: root,
      timeoutMs: deps.graphifyTimeoutMs,
      env: deps.graphifyEnv,
    })
    return { project: projectName, output: result.stdout.trim() }
  }

  const graphStatus = async (args: Record<string, unknown>): Promise<unknown> => {
    const projectName = typeof args.project === 'string' ? args.project.trim() : ''
    if (projectName === '') {
      throw new Error('prism_graph_status 需要 { project }')
    }
    const info = await registry.get(projectName)
    return await inspectGraphStatus(info.project, info.root, info.built_at)
  }

  const requireProject = async (args: Record<string, unknown>, tool: string): Promise<{ project: string; root: string }> => {
    const projectName = typeof args.project === 'string' ? args.project.trim() : ''
    if (projectName === '') {
      throw new Error(`${tool} 需要 { project }`)
    }
    return await requireProjectRoot(projectName)
  }

  const graphPath = async (args: Record<string, unknown>): Promise<unknown> => {
    const from = typeof args.from === 'string' ? args.from.trim() : ''
    const to = typeof args.to === 'string' ? args.to.trim() : ''
    if (from === '' || to === '') throw new Error('prism_graph_path 需要 { from, to, project }')
    const { project, root } = await requireProject(args, 'prism_graph_path')
    const result = await queryGraphPath(root, from, to, {
      cwd: root,
      ...(deps.graphifyEnv !== undefined ? { env: deps.graphifyEnv } : {}),
      ...(deps.graphifyTimeoutMs !== undefined ? { timeoutMs: deps.graphifyTimeoutMs } : {}),
    })
    return { project, ...result }
  }

  const graphExplain = async (args: Record<string, unknown>): Promise<unknown> => {
    const node = typeof args.node === 'string' ? args.node.trim() : ''
    if (node === '') throw new Error('prism_graph_explain 需要 { node, project }')
    const { project, root } = await requireProject(args, 'prism_graph_explain')
    const result = await queryGraphExplain(root, node, {
      cwd: root,
      ...(deps.graphifyEnv !== undefined ? { env: deps.graphifyEnv } : {}),
      ...(deps.graphifyTimeoutMs !== undefined ? { timeoutMs: deps.graphifyTimeoutMs } : {}),
    })
    return { project, ...result }
  }

  const graphAffected = async (args: Record<string, unknown>): Promise<unknown> => {
    const node = typeof args.node === 'string' ? args.node.trim() : ''
    if (node === '') throw new Error('prism_graph_affected 需要 { node, project }')
    const { project, root } = await requireProject(args, 'prism_graph_affected')
    const result = await queryGraphAffected(root, node, {
      cwd: root,
      ...(typeof args.depth === 'number' ? { depth: args.depth } : {}),
      ...(deps.graphifyEnv !== undefined ? { env: deps.graphifyEnv } : {}),
      ...(deps.graphifyTimeoutMs !== undefined ? { timeoutMs: deps.graphifyTimeoutMs } : {}),
    })
    return { project, ...result }
  }

  const graphSummary = async (args: Record<string, unknown>): Promise<unknown> => {
    const { project, root } = await requireProject(args, 'prism_graph_summary')
    const summary = await queryGraphSummary(root)
    if (!summary.exists) {
      throw new Error(`图谱不存在: ${summary.path}（请先建图）`)
    }
    return { project, ...summary }
  }

  const graphGodNodes = async (args: Record<string, unknown>): Promise<unknown> => {
    const { project, root } = await requireProject(args, 'prism_graph_god_nodes')
    const result = await queryGraphGodNodes(root, {
      cwd: root,
      ...(typeof args.top === 'number' ? { top: args.top } : {}),
      ...(deps.graphifyEnv !== undefined ? { env: deps.graphifyEnv } : {}),
      ...(deps.graphifyTimeoutMs !== undefined ? { timeoutMs: deps.graphifyTimeoutMs } : {}),
    })
    return { project, ...result }
  }

  /**
   * 多项目图谱合并（v5 F-C2 / 裁决 D2 + D8）。
   * 只读/生成型：**不触发建图**（无 prism_graph_build 工具），输入项目必须已建图；
   * 产物落 `<PRISM_HOME>/graphify-merged/`；返回**摘要**（不带 graphify 原始 stdout，守 R4）。
   */
  const graphMerge = async (args: Record<string, unknown>): Promise<unknown> => {
    const names = Array.isArray(args.projects)
      ? args.projects
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item !== '')
      : []
    if (names.length < 2) {
      throw new Error('prism_graph_merge 需要 { projects }（至少 2 个已建图的项目名）')
    }
    const targets: MergeProjectInput[] = []
    for (const name of names) {
      targets.push(await requireProjectRoot(name))
    }
    const outDir = typeof args.out_dir === 'string' && args.out_dir.trim() !== '' ? args.out_dir.trim() : undefined
    const result = await mergeProjectGraphs(targets, {
      home: deps.home,
      ...(outDir !== undefined ? { outDir } : {}),
      ...(deps.graphifyEnv !== undefined ? { env: deps.graphifyEnv } : {}),
      ...(deps.graphifyTimeoutMs !== undefined ? { timeoutMs: deps.graphifyTimeoutMs } : {}),
    })
    return {
      projects: result.projects,
      outDir: result.outDir,
      graphPath: result.graphPath,
      htmlPath: result.htmlPath,
      htmlExists: result.htmlExists,
      nodes: result.nodes,
      edges: result.edges,
    }
  }

  // ---- 角色 / 团队（design-v3 §3.4 P6：宿主拉配置主链路；数据源与 CLI 同源 resolveDirs，B8）----
  // 根目录：显式 deps > 通用 env `PRISM_HARNESS_ROOT` > **激活适配器默认根**。
  // 不用 `ZCODE_DIR`/`~/.zcode` 兜底——那是 zcode 专属旧变量，会泄漏到插件 harness
  // （zcode 适配器自己会消费 ZCODE_DIR/PRISM_ZCODE_DIR）。未显式指定时不传 root，
  // 让 `resolveDirs` 走适配器 defaultRoot。
  const rootOverride = deps.harnessRoot ?? process.env['PRISM_HARNESS_ROOT']
  const dirs = resolveDirsFromHome(deps.home, {
    ...(rootOverride !== undefined && rootOverride !== ''
      ? { harnessRoot: rootOverride, rootExplicit: true }
      : {}),
  })
  const harnessRoot = dirs.harnessRoot
  const rolesDir = dirs.rolesDir
  const teamsDir = dirs.teamsDir
  const hostPaths = harnessPaths(harnessRoot, deps.home)
  /**
   * 回收站（v9 F3）：删除角色/团队/Skill 走 `TrashStore.put`，trashDir 与审计都归属
   * `deps.home`（不落默认 `~/.prism`）。三个删除工具只传 `trigger: 'MCP'` 定界来源。
   */
  const trash = trashStoreFor(deps.home)
  /** 技能分类映射（design-v8 §3 F7）：`<PRISM_HOME>/skill-categories.json`，与 HTTP/CLI 同一实现。 */
  const skillCategories = new SkillCategoryStore(deps.home)

  const requireTeam = async (teamId: unknown) => {
    const id = asString(teamId)
    if (id === undefined) {
      throw new Error('缺少 team_id')
    }
    const team = await loadTeam(teamsDir, id, { rolesDir })
    if (team === null) {
      throw new Error(teamNotFoundMessage(teamsDir, id))
    }
    return team
  }

  const roleList = async (): Promise<unknown> => {
    const roles = await loadRoles(rolesDir)
    // 键名 = 写参数名（roles_dir）：宿主读回后可直接回填 prism_role_new|edit|rm 的 roles_dir。
    // 旧名 agents_dir 是 zcode 遗留命名，已删（它与实际读取的 roles_dir 不一定是同一个路径）。
    return { count: roles.length, roles, roles_dir: rolesDir }
  }

  /**
   * 上下文包（knowledge-injection.md §4 模式 B）：
   * 按角色知识绑定 + 任务关键词检索，组装带预算的包。Prism 只产包、不写 prompt。
   *
   * F-B1/F-B2：增 `layers`/`books`/`symbols`/`max_excerpt_chars`（全部可选，缺省行为不变）。
   */
  const contextPack = async (args: Record<string, unknown>): Promise<unknown> => {
    const roleName = asString(args.role)
    const task = asString(args.task)
    if (roleName === undefined || task === undefined) {
      throw new Error('prism_context_pack 需要 { role, task }')
    }
    const role = await loadRole(rolesDir, roleName)
    if (role === null) {
      throw new Error(roleNotFoundMessage(rolesDir, roleName))
    }
    const layers = asStringArray(args.layers)
    const books = asStringArray(args.books)
    const symbols = asStringArray(args.symbols)
    const maxExcerptChars = asPositiveInt(args.max_excerpt_chars)
    return await buildContextPack(await kb(), {
      role: roleName,
      binding: role.knowledge,
      task,
      ...(typeof args.budget_tokens === 'number' ? { budgetTokens: args.budget_tokens } : {}),
      ...(layers !== undefined ? { layers: layers as Layer[] } : {}),
      ...(books !== undefined ? { books } : {}),
      ...(symbols !== undefined ? { symbols } : {}),
      ...(maxExcerptChars !== undefined ? { maxExcerptChars } : {}),
    })
  }

  /**
   * 条目版本历史（F-B4）：`{ id }` → `{ versions: EntryVersion[] }`（降序 + `is_latest`）。
   * 不存在 id → 空数组（不报错）。
   */
  const kbVersions = async (args: Record<string, unknown>): Promise<unknown> => {
    const id = asString(args.id)
    if (id === undefined) {
      throw new Error('prism_kb_versions 需要 { id }')
    }
    return { versions: await (await kb()).listVersions(id) }
  }

  /**
   * 书结构（F-A1/F-A2，design-v4 §3.4 冻结面）：`{ action: show|generate|freeze, layer, book, ... }`。
   *
   * 与 CLI `prism kb structure`（t14）**同口径**：
   * - `show` → `BookStructure`（`modules` 已是父链在前、本地覆盖同名的**合并结果**）；
   *   结构未生成（或书不存在）→ `not_found`（**不是**空结构）；
   * - `generate` → `{ structure, files }`（零 LLM；幂等：`revision` 只有 freeze 递增）；
   * - `freeze` → `BookStructure`（`revision+1`；`modules` 省略则沿用当前清单/接受建议）；
   * - 字段名 `inherited_from`/`frozen_at`/`confirmed_by` **原样 snake_case**（不做驼峰改写）。
   *
   * 非法层/同名书多 owner/非法 slug/无条目书 → 知识侧 `bad_request`（owner 消歧是契约行为，不是缺陷）。
   */
  const kbBookStructure = async (args: Record<string, unknown>): Promise<unknown> => {
    const action = asString(args.action)
    if (action !== 'show' && action !== 'generate' && action !== 'freeze') {
      throw new PrismError(
        'bad_request',
        `prism_kb_book_structure 的 action 必须为 show/generate/freeze: ${JSON.stringify(args.action ?? null)}`,
      )
    }
    const layer = asString(args.layer)
    const book = asString(args.book)
    if (layer === undefined || book === undefined) {
      throw new PrismError('bad_request', 'prism_kb_book_structure 需要 { action, layer, book }')
    }
    const service = await kb()
    if (action === 'show') {
      const structure = await service.bookStructure(layer, book)
      if (structure === null) {
        throw new PrismError('not_found', `书结构不存在: ${layer}/${book}（尚未 generate/freeze，或该书无条目）`)
      }
      return structure
    }
    const confirmedBy = asString(args.confirmed_by)
    if (action === 'generate') {
      return await service.generateBookStructure({
        layer,
        book,
        ...(confirmedBy !== undefined ? { confirmed_by: confirmedBy } : {}),
      })
    }
    // freeze：显式给 modules 但筛完为空 → bad_request（对齐 CLI：给了空值不静默当「没给」）
    let modules: string[] | undefined
    if (args.modules !== undefined) {
      if (!Array.isArray(args.modules) || args.modules.some((m) => typeof m !== 'string')) {
        throw new PrismError('bad_request', 'prism_kb_book_structure 的 modules 必须是字符串数组')
      }
      modules = (args.modules as string[]).map((m) => m.trim()).filter((m) => m !== '')
      if (modules.length === 0) {
        throw new PrismError('bad_request', 'modules 需要至少一个模块 slug（如 ["core","api"]）')
      }
    }
    const note = asString(args.note)
    return await service.freezeBookStructure({
      layer,
      book,
      ...(modules !== undefined ? { modules } : {}),
      ...(confirmedBy !== undefined ? { confirmed_by: confirmedBy } : {}),
      ...(note !== undefined ? { note } : {}),
    })
  }

  /**
   * F-D2 有效 Skill 集：`{ role, team? }` → `EffectiveSkillSet`。
   * 与 HTTP `GET /api/skills/effective`、CLI `prism skill effective` 共用
   * `loadEffectiveSkills`（口径一致由该单点保证）；角色/团队不存在 → `not_found`。
   */
  const skillEffective = async (args: Record<string, unknown>): Promise<unknown> => {
    const roleName = asString(args.role)
    if (roleName === undefined) {
      throw new Error('prism_skill_effective 需要 { role }')
    }
    const teamId = asString(args.team)
    return await loadEffectiveSkills({
      roleId: roleName,
      teamsDir,
      rolesDir,
      harnessRoot,
      home: deps.home,
      ...(teamId !== undefined ? { teamId } : {}),
    })
  }

  /**
   * 内置 Skill 清单（读）：让宿主先「看见有什么可装」，并拿到 `skills_dir` 回填给
   * `prism_skill_install|uninstall`（键名 = 写参数名，与 `roles_dir` / `teams_dir` 同一纪律）。
   * `installed` 由宿主 skills 目录实测（与 `installedSkillNames` 同源）。
   *
   * v8 F7（design-v8 §3 / R-v8-5）：每个 skill **合并 `category` 字段**（映射里没有该技能
   * 则**不加键**——与 HTTP `GET /api/skills` 完全同口径，见 `people.ts` 同名注释）。
   */
  const skillList = async (): Promise<unknown> => {
    const installed = new Set((await installedSkillNames(harnessRoot, deps.home)) ?? [])
    const { mapping: categoryOf } = await skillCategories.all()
    const skills = listBuiltinSkills().map((s) => ({
      name: s.name,
      description: s.description,
      installed: installed.has(s.name),
      ...(categoryOf[s.name] !== undefined ? { category: categoryOf[s.name] } : {}),
    }))
    return { count: skills.length, skills, skills_dir: dirs.skillsDir }
  }

  /**
   * 技能分类（写）：`{ names: string[], category? }` → 写 `<PRISM_HOME>/skill-categories.json`。
   * 与 HTTP `POST /api/skills/categorize`、CLI `prism skill categorize` 共用 `SkillCategoryStore`
   * （入参归一化同为 `parseCategorizeInput`）。`category` 省略 / 空串 = **清除**；`names` 空 → 报错。
   * **不校验技能是否存在**（映射独立于技能台账；R3 不做审核——分类判断归宿主）。
   */
  const skillCategorize = async (args: Record<string, unknown>): Promise<unknown> => {
    const input = parseCategorizeInput({ names: args.names, category: args.category })
    return await skillCategories.categorize(input.names, input.category)
  }

  /**
   * 技能分类清单的增 / 改名 / 删（v12 F4 / SPEC-4.9）——三个动作与 HTTP 三条路由
   * （`POST|PATCH|DELETE /api/skills/categories[/:name]`）、CLI `prism skill category add|rename|rm`
   * **同名同位**；实现一律转发 `SkillCategoryStore`（`roles/skill-categories.ts` 是唯一读写逻辑，
   * 此处**不镜像第二份**——仓库红线「镜像契约」）。
   *
   * 错误码与 HTTP 同码（`PrismError` → MCP 侧带 `[code]` 前缀的 `isError` 文本）：
   * 重名 / 改名目标重名 = `id_conflict`；源分类不存在 = `not_found`；名字 trim 后为空 = `bad_request`。
   * `rename` 的入参取 `{ from, to }`（与 `prism_kb_path` / `prism_graph_path` 及 store 的
   * `renameCategory(from, to)` 同惯例）；`from === to` 幂等 no-op。
   */
  const skillCategoryAdd = async (args: Record<string, unknown>): Promise<unknown> =>
    await skillCategories.addCategory(asString(args.name) ?? '')

  const skillCategoryRename = async (args: Record<string, unknown>): Promise<unknown> =>
    await skillCategories.renameCategory(asString(args.from) ?? '', asString(args.to) ?? '')

  const skillCategoryRm = async (args: Record<string, unknown>): Promise<unknown> =>
    await skillCategories.removeCategory(asString(args.name) ?? '')

  /**
   * 安装内置 Skill（写）：与 CLI `prism skill install`、HTTP `POST /api/skills/install`
   * 共用 `installBuiltinSkillDefinitions`（`skills_dir` **必填**——写路径一律显式参数化，
   * 绝不回落到默认宿主目录）。冲突策略（design-v3 §5）：人写的 Skill（无 Prism marker）
   * 不覆盖，写 `.prism-new` 供对比。
   */
  const skillInstall = async (args: Record<string, unknown>): Promise<unknown> =>
    await installBuiltinSkillDefinitions({
      skills_dir: args.skills_dir,
      names: args.names,
      force: args.force,
    })

  /**
   * 卸载 Skill（写）：与 CLI `prism skill uninstall`、HTTP `POST /api/skills/uninstall`
   * 共用 `uninstallSkillDefinitions`。**只回收 Prism 产物**——人写的 Skill 一律不动并记入 `kept`。
   * `skills_dir` 必填；`names` 缺省 = 扫描该目录下全部 Skill。删除进回收站（可 restore）。
   */
  const skillUninstall = async (args: Record<string, unknown>): Promise<unknown> =>
    await uninstallSkillDefinitions(
      {
        skills_dir: args.skills_dir,
        names: args.names,
      },
      trash,
      'MCP',
    )

  /** 取单个角色定义（装配器按名拉取，免拉全量）。 */
  const roleGet = async (args: Record<string, unknown>): Promise<unknown> => {
    const name = asString(args.name)
    if (name === undefined) {
      throw new Error('prism_role_get 需要 { name }')
    }
    const role = await loadRole(rolesDir, name, { knownSkills: await installedSkillNames(harnessRoot, deps.home) })
    if (role === null) {
      throw new Error(roleNotFoundMessage(rolesDir, name))
    }
    return role
  }

  const roleRender = async (args: Record<string, unknown>): Promise<unknown> => {
    const name = asString(args.name)
    if (name === undefined) {
      throw new Error('缺少 name')
    }
    const role = await loadRole(rolesDir, name)
    if (role === null) {
      throw new Error(roleNotFoundMessage(rolesDir, name))
    }
    const model = asString(args.model)
    const thoughtLevel = asString(args.thought_level) ?? asString(args.thoughtLevel)
    const content = harnessAdapterOf(harnessRoot, deps.home).renderRole(role, {
      ...(model !== undefined ? { model } : {}),
      ...(thoughtLevel !== undefined ? { thoughtLevel } : {}),
    }).content
    return { name, target: join(rolesDir, `${name}.md`), content }
  }

  /** 新建角色：与 `POST /api/roles`、CLI `prism role new` 同一实现（渲染走宿主原生形态）。 */
  const roleNew = async (args: Record<string, unknown>): Promise<unknown> =>
    await createRoleDefinition(args as RoleWriteBody, { renderRole: roleRendererFor(harnessRoot, deps.home) })

  /** 修改角色（字段补丁；正文不重排）。 */
  const roleEdit = async (args: Record<string, unknown>): Promise<unknown> => {
    const name = asString(args.name)
    if (name === undefined) {
      throw new Error('缺少 name')
    }
    return await updateRoleDefinition(name, args as RoleWriteBody, { renderRole: roleRendererFor(harnessRoot, deps.home) })
  }

  /** 删除角色本体：搬进回收站（v9 F3），返回体带 `trash_id`。 */
  const roleRemove = async (args: Record<string, unknown>): Promise<unknown> => {
    const name = asString(args.name)
    if (name === undefined) {
      throw new Error('缺少 name')
    }
    return await deleteRoleDefinition(name, args.roles_dir, trash, 'MCP')
  }

  const teamList = async (): Promise<unknown> => {
    const teams = await loadTeams(teamsDir, { rolesDir })
    return { count: teams.length, teams, teams_dir: teamsDir }
  }

  /**
   * 修改团队（字段补丁；改 members 时工作流就地收窄；给 workflow 时结构化保存；if_match 防陈旧写）。
   * 与 HTTP `PATCH /api/teams/:id`、CLI `prism team edit` 共用 `updateTeamDefinition`（三入口同口径）。
   */
  const teamEdit = async (args: Record<string, unknown>): Promise<unknown> => {
    const teamId = asString(args.team_id)
    if (teamId === undefined) {
      throw new Error('缺少 team_id')
    }
    return await updateTeamDefinition(teamId, args as UpdateTeamBody)
  }

  /** 删除团队本体：搬进回收站（v9 F3），返回体带 `trash_id`。 */
  const teamRemove = async (args: Record<string, unknown>): Promise<unknown> => {
    const teamId = asString(args.team_id)
    if (teamId === undefined) {
      throw new Error('缺少 team_id')
    }
    return await deleteTeamDefinition(teamId, args.teams_dir, trash, 'MCP')
  }

  /** 团队渲染预览（不写盘；与 role_render 对称）。 */
  const teamRender = async (args: Record<string, unknown>): Promise<unknown> => {
    const team = await requireTeam(args.team_id)
    return { team_id: team.team_id, target: join(teamsDir, `${team.team_id}.md`), content: renderZcodeTeam(team) }
  }

  /**
   * 取单个团队 + 工作流底账（v11 派修 M-3）：与 HTTP `GET /api/teams/:id` 共用
   * `roles/team-read.ts` 的单点，故响应含 `workflow_raw`（rowIds/proseText 等）与
   * `source_mtime`——`prism_team_edit` 的 schema 以二者为前置（rowId 对齐未映射列、
   * if_match 防陈旧写），此前 MCP 面拿不到，照 schema 走会丢自定义列值。
   */
  const teamGet = async (args: Record<string, unknown>): Promise<unknown> => {
    const id = asString(args.team_id)
    if (id === undefined) {
      throw new Error('缺少 team_id')
    }
    const detail = await readTeamDetail(teamsDir, id, { rolesDir })
    if (detail === null) {
      throw new Error(teamNotFoundMessage(teamsDir, id))
    }
    return { ...detail.team, workflow_raw: detail.workflow_raw, source_mtime: detail.source_mtime }
  }

  const teamActivate = async (args: Record<string, unknown>): Promise<unknown> => {
    const team = await requireTeam(args.team_id)
    return await activateTeam(team, { rolesDir, targetDir: hostPaths.agentsDir })
  }

  /** archify 五类图（与 CLI `arch from-*` 同一批纯函数生成器）。 */
  const ARCH_DIAGRAM_TYPES = ['workflow', 'architecture', 'sequence', 'lifecycle', 'dataflow'] as const

  /**
   * `prism_arch_generate`：**五类图的统一派生入口**（CLI `arch from-team|from-graph|from-state` 的 MCP 版）。
   *
   * 分工与 CLI 完全一致：读盘（registry / graph.json）在 server，派生 IR 在
   * `@prism/agents` 的**纯函数**生成器，最后交给 vendored archify 渲染。
   * 宿主/用户**一行 IR 都不用写**——这正是红线 R7「IR 是派生视图」的落地方式。
   *
   * 落盘（v9 F1）：project 派生三类图 → `<projectRoot>/.prism/arch/<type>/`（未注册拒绝、
   * root 缺失报 `project_root_missing` 且不重建）；workflow/lifecycle → `<PRISM_HOME>/archify/`；
   * 显式 `out` 完全接管。口径与 HTTP/CLI 同源，见 `graph/arch-placement.ts`。
   *
   * **写 sidecar**（v9.1 E-1，本条订正旧注释）：`writeArtifactMeta` 就在本包
   * `graph/archify.ts`，不存在「server 反向依赖 CLI」问题；可选 `book`/`module` 一并落进
   * sidecar，界面才能把项目图挂到知识库树上（旧行为「只落 HTML + IR」让项目图无书归属、
   * 只能进全局图集）。
   */
  const archGenerate = async (args: Record<string, unknown>): Promise<unknown> => {
    const type = asString(args.type)
    if (type === undefined || !(ARCH_DIAGRAM_TYPES as readonly string[]).includes(type)) {
      throw new Error(`prism_arch_generate 的 type 必须是 ${ARCH_DIAGRAM_TYPES.join(' / ')}`)
    }

    let ir: unknown
    let name: string
    let scope: Record<string, unknown> = {}
    /** 项目源时由分支填项目名（落点解析用）。 */
    let project: string | undefined

    if (type === 'workflow') {
      const teamId = asString(args.team)
      if (teamId === undefined) throw new Error('prism_arch_generate 生成 workflow 需要 { team }')
      const team = await loadTeam(teamsDir, teamId, { rolesDir })
      if (team === null) throw new Error(teamNotFoundMessage(teamsDir, teamId))
      name = teamId
      scope = { team_id: teamId }
      ir = buildTeamWorkflowIr(team)
    } else if (type === 'lifecycle') {
      name = 'task-state-machine'
      ir = buildTaskLifecycleIr(asString(args.title) !== undefined ? { title: asString(args.title)! } : {})
    } else {
      const projectName = asString(args.project)
      if (projectName === undefined) throw new Error(`prism_arch_generate 生成 ${type} 需要 { project }`)
      const info = await requireProjectRoot(projectName)
      project = info.project
      // root 存在性校验先于读图谱：root 被删/被挪时报 `project_root_missing`（而非含糊的
      // 「图谱不存在」），且**绝不 mkdir 复活**它（v9.1 B-1）。
      await assertProjectRoot(info.root, info.project)
      const graph = await readCodeGraph(info.root)
      const top = typeof args.top === 'number' ? args.top : undefined
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      name = projectName
      scope = { project: info.project, root: info.root }
      const title = asString(args.title) ?? `${info.project} · ${type}`
      if (type === 'architecture') {
        ir = buildArchitectureIr(graph, {
          title,
          ...(top !== undefined ? { maxComponents: top } : {}),
          ...(limit !== undefined ? { maxConnections: limit } : {}),
        })
      } else if (type === 'sequence') {
        ir = buildSequenceIr(graph, {
          title,
          ...(top !== undefined ? { maxParticipants: top } : {}),
          ...(limit !== undefined ? { maxMessages: limit } : {}),
        })
      } else {
        ir = buildDataflowIr(graph, {
          title,
          ...(top !== undefined ? { maxComponents: top } : {}),
          ...(limit !== undefined ? { maxFlows: limit } : {}),
        })
      }
    }

    const explicitOut = asString(args.out)
    // 落点与 HTTP/CLI 同源（`graph/arch-placement.ts`）：project 三类图 → 项目内
    // `.prism/arch/<type>/`；workflow/lifecycle → 全局；`out` 完全接管（跳过项目解析）。
    const placement = await resolveArchPlacement({
      type,
      home: deps.home,
      name: sanitizeArtifactName(name, type),
      ...(explicitOut !== undefined ? { out: explicitOut } : project !== undefined ? { project } : {}),
    })
    await mkdir(placement.dir, { recursive: true })
    const htmlPath = placement.htmlPath
    // 渲染前 archify 会先校验；不过直接抛 → 不产出坏图
    const rendered = await renderDiagram(type, ir, htmlPath, {
      ...(deps.graphifyEnv !== undefined ? { env: deps.graphifyEnv } : {}),
      ...(deps.graphifyTimeoutMs !== undefined ? { timeoutMs: deps.graphifyTimeoutMs } : {}),
    })
    const irPath = htmlPath.replace(/\.html$/i, '.ir.json')
    await writeFile(irPath, `${JSON.stringify(ir, null, 2)}\n`, 'utf-8')
    // sidecar（v9.1 E-1）：作用域（可选 book/module）+ 渲染器版本 + IR 哈希。
    // 与 HTTP `POST /api/arch/render`、CLI `arch from-*` 同口径；历史产物无 sidecar
    // 也照常可列（`GET /api/arch/diagrams` 按 `*.html` 扫，缺 meta 容错）。
    const book = asString(args.book)
    const moduleName = asString(args.module)
    await writeArtifactMeta(htmlPath, ir, {
      ...(book !== undefined ? { book } : {}),
      ...(moduleName !== undefined ? { module: moduleName } : {}),
    })

    const meta = (ir as { meta?: { title?: string; subtitle?: string } }).meta ?? {}
    return {
      type,
      ...scope,
      html: rendered.htmlPath,
      ir: irPath,
      bytes: rendered.bytes,
      title: meta.title,
      subtitle: meta.subtitle,
      source: placement.project !== undefined ? 'project' : 'global',
      ...(placement.project !== undefined ? { project: placement.project } : {}),
      ...(book !== undefined ? { book } : {}),
      ...(moduleName !== undefined ? { module: moduleName } : {}),
    }
  }

  const tools: McpTool[] = [
    {
      name: 'prism_kb_search',
      description: '检索 Prism 知识库（bigram 中文检索；支持 layer/owner/book/module 过滤，默认只返回最新版次）',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '检索词' },
          layers: { type: 'array', items: { enum: ['global', 'project', 'role'] } },
          owner: { type: 'string' },
          book: { type: 'string' },
          module: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
          all_versions: { type: 'boolean' },
          visibilities: {
            type: 'array',
            items: { enum: ['global', 'project', 'role'] },
            description: '按可见性收窄读取面（B3，opt-in）',
          },
        },
        required: ['q'],
      },
      call: async (args) => {
        const q = typeof args.q === 'string' ? args.q.trim() : ''
        if (q === '') {
          throw new Error('缺少检索词 q')
        }
        const query: SearchQuery = {
          q,
          layers: Array.isArray(args.layers) ? (args.layers as SearchQuery['layers']) : undefined,
          owner: asString(args.owner),
          book: asString(args.book),
          module: asString(args.module),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          all_versions: typeof args.all_versions === 'boolean' ? args.all_versions : undefined,
          ...(Array.isArray(args.visibilities)
            ? { visibilities: args.visibilities as SearchQuery['visibilities'] }
            : {}),
        }
        return await (await kb()).search(query)
      },
    },
    {
      name: 'prism_kb_get',
      description: '取单条知识条目（可指定版次；不传取最新版）',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      call: async (args) => {
        const id = asString(args.id)
        if (id === undefined || id === '') {
          throw new Error('缺少 id')
        }
        const entry = await (await kb()).get(id, typeof args.version === 'number' ? args.version : undefined)
        return entry ?? { not_found: id }
      },
    },
    {
      name: 'prism_kb_versions',
      description: '列某条目的全部版次历史（降序 + is_latest；不存在 id → 空数组，不报错）',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '知识条目 id' } },
        required: ['id'],
      },
      call: kbVersions,
    },
    {
      name: 'prism_kb_book_structure',
      description:
        '书结构（F-A1/F-A2）：action=show 读回合并后的模块清单（父链在前）+ inherited_from + revision/frozen_at/confirmed_by/suggested；action=generate 零 LLM 推导并产 _modules.yaml + 书级/模块级 _summary.md（幂等，返回 {structure, files}）；action=freeze 固化模块清单（revision+1；省略 modules 则沿用当前清单或接受建议）。与 CLI `prism kb structure` 同口径（字段名 snake_case 原样，结构未生成 → not_found）',
      inputSchema: {
        type: 'object',
        properties: {
          action: { enum: ['show', 'generate', 'freeze'], description: '动作' },
          layer: { enum: ['global', 'project', 'role'], description: '层' },
          book: { type: 'string', description: '书（project/role 层同名书多 owner → bad_request，不猜）' },
          modules: {
            type: 'array',
            items: { type: 'string' },
            description: 'freeze 专用：显式冻结的模块 slug 清单（省略则沿用当前清单或接受建议）',
          },
          confirmed_by: { type: 'string', description: 'generate/freeze 专用：确认人留痕' },
          note: { type: 'string', description: 'freeze 专用：备注' },
        },
        required: ['action', 'layer', 'book'],
      },
      call: kbBookStructure,
    },
    {
      name: 'prism_kb_deposit',
      description: '落库一条知识（宿主说落就落）；project/role 层必须提供 owner',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          type: { enum: ['rule', 'doc', 'guide', 'pitfall', 'pattern', 'diagram', 'summary', 'other'] },
          layer: { enum: ['global', 'project', 'role'] },
          owner: { type: 'string' },
          book: { type: 'string' },
          module: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          risk: { enum: ['low', 'medium', 'high'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          overrides: { type: 'array', items: { type: 'string' }, description: '显式声明的层间覆盖（低层条目 id）' },
          visibility: { enum: ['global', 'project', 'role'] },
          source: {
            type: 'object',
            properties: { kind: { enum: ['import', 'agent', 'manual', 'task'] }, ref: { type: 'string' } },
          },
          deposited_by: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              team: { type: 'string' },
              task_id: { type: 'string' },
            },
            description: '留痕：谁/哪个团队落库',
          },
          team_id: {
            type: 'string',
            description: '按该团队的 deposit 策略机械校验（enabled/require_note/rules）；省略则不校验',
          },
          task_id: {
            type: 'string',
            description: 'F-E2 任务来源：写 origin_task.task_id，并把 source.kind 置为 task',
          },
          dag_id: { type: 'string', description: 'F-E2 任务来源：写 origin_task.dag_id' },
          stage: { type: 'string', description: 'F-E2 任务来源：写 origin_task.stage' },
        },
        required: ['title', 'type', 'layer', 'book', 'content'],
      },
      call: async (args) => {
        const raw = args as unknown as DepositRequest & Record<string, unknown>
        // F-E2：`task_id`/`dag_id`/`stage` → `origin_task` + `source.kind='task'`（与 HTTP/CLI 同口径）
        const taskId = asString(raw['task_id'])
        const dagId = asString(raw['dag_id'])
        const stage = asString(raw['stage'])
        const originTask =
          taskId !== undefined
            ? {
                task_id: taskId,
                ...(dagId !== undefined ? { dag_id: dagId } : {}),
                ...(stage !== undefined ? { stage } : {}),
              }
            : undefined
        const source =
          originTask !== undefined
            ? { kind: 'task' as const, ...(raw.source?.ref !== undefined ? { ref: raw.source.ref } : {}) }
            : raw.source
        // 团队沉淀策略：机械校验 + 默认值 + rules 覆盖（team-definition.md §5）
        // 实现单点在 kb/deposit-entry.ts，与 HTTP `POST /api/kb/deposit` 共用
        return await depositWithPolicy(
          {
            kb,
            loadTeam: async (teamId) => await requireTeam(teamId),
          },
          {
            ...raw,
            ...(source !== undefined ? { source } : {}),
            ...(originTask !== undefined ? { origin_task: originTask } : {}),
          },
        )
      },
    },
    {
      name: 'prism_kb_convert',
      description:
        '把任意文档转成 Markdown（本地转换，零 LLM、零网络）。支持 docx/pdf/xlsx/pptx/csv/epub 等二进制格式；md/txt/html 直接读原文。图片型扫描 PDF 返回 needs_ocr。**不落库**——转换结果由你（宿主）提炼后经 prism_kb_deposit 落库',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '待转换文件的绝对路径' },
          max_chars: {
            type: 'integer',
            minimum: 1,
            description: '返回正文上限（默认 200000；超出截断并标记 truncated）',
          },
        },
        required: ['path'],
      },
      call: async (args) => {
        const path = asString(args.path)
        if (path === undefined) throw new Error('prism_kb_convert 需要 { path }')
        return await convertFileToMarkdown(path, {
          ...(typeof args.max_chars === 'number' ? { maxChars: args.max_chars } : {}),
        })
      },
    },
    {
      name: 'prism_kb_import',
      description:
        '把项目文档目录扫描成「引用型」索引（项目文件为真相，Prism 只存索引 + 转换后的检索副本，只读不改原文件）。默认只扫文档集（md/txt/pdf/docx/…；html/htm 与构建文件/配置默认不扫，后者计入 by_skip_reason），需要源码等额外扩展用 include_ext 显式纳入。适合宿主批量导入项目知识：先 import 建索引，再对重点条目用 prism_kb_enrich 补实体/摘要',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目根目录绝对路径' },
          owner: { type: 'string', description: '项目名（project 层 owner）' },
          book: { type: 'string', description: '书（默认取项目名）' },
          module: { type: 'string', description: '模块（默认按目录推断）' },
          dry_run: { type: 'boolean', description: '只报告不落库（默认 false）' },
          respect_gitignore: {
            type: 'boolean',
            description:
              '是否读项目根 .gitignore 并跳过其中忽略的路径（默认 true）。置 false 只按内置目录名过滤',
          },
          include_ext: {
            type: 'array',
            items: { type: 'string' },
            description:
              '显式纳入的扩展名（默认只扫文档集：md/txt/pdf/docx/… 但 html/htm 默认不扫）。写法随手：h / .c / cpp 都认；纳入的非 anydoc 扩展走纯文本直读',
          },
        },
        required: ['path', 'owner'],
      },
      call: async (args) => {
        const root = asString(args.path)
        const owner = asString(args.owner)
        if (root === undefined || owner === undefined) {
          throw new Error('prism_kb_import 需要 { path, owner }')
        }
        const dryRun = args.dry_run === true
        const includeExt = Array.isArray(args.include_ext)
          ? args.include_ext.filter((v): v is string => typeof v === 'string')
          : undefined
        const service = await kb()
        const target = dryRun ? makeDryRunKb(service) : service
        const report = await scanProject(target, {
          root,
          layer: 'project',
          owner,
          ...(asString(args.book) !== undefined ? { book: asString(args.book)! } : {}),
          ...(asString(args.module) !== undefined ? { module: asString(args.module)! } : {}),
          ...(typeof args.respect_gitignore === 'boolean'
            ? { respectGitignore: args.respect_gitignore }
            : {}),
          ...(includeExt !== undefined && includeExt.length > 0 ? { includeExt } : {}),
        })
        return {
          root: report.root,
          discovered: report.discovered,
          created: report.created,
          updated: report.updated,
          unchanged: report.unchanged,
          skipped: report.skipped,
          // 未纳入分列（design-v8 §4：纳入/跳过对账物，含被扩展门/文件名表挡掉的）
          by_skip_reason: report.by_skip_reason,
          truncated: report.truncated,
          missing: report.missing,
          ignored_dirs: report.ignored_dirs,
          ignored_files: report.ignored_files,
          dry_run: dryRun,
        }
      },
    },
    {
      name: 'prism_kb_enrich',
      description:
        '回写一次富化结果（工作队列已移除：宿主用自己的 LLM 产出后直接调本工具落库，Prism 只做确定性写入）。kind=summarize/classify/extract_entities/diagram_ir；各 kind 的 result 结构见 description 尾注。Prism 不审核、不调 LLM',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['summarize', 'classify', 'extract_entities', 'diagram_ir'],
            description:
              'summarize:{entry_id,summary} / classify:{entry_id,labels[]} / extract_entities:{entities[],relations[]} / diagram_ir:{diagram_type,meta}',
          },
          payload: { description: '原条目上下文：{ entry_id, layer?, owner?, book?, module?, type? }' },
          result: { description: '你的 LLM 产出结果（结构随 kind 而定）' },
          by: { type: 'string', description: '执行者标识（会话/agent 名，写入 deposited_by）' },
        },
        required: ['kind', 'payload', 'result'],
      },
      call: async (args) => {
        const kind = asString(args.kind)
        if (kind === undefined) throw new Error('prism_kb_enrich 需要 { kind, payload, result }')
        const rec = (v: unknown): v is Record<string, unknown> =>
          typeof v === 'object' && v !== null && !Array.isArray(v)
        if (!rec(args.payload) || !rec(args.result)) {
          throw new Error('prism_kb_enrich 的 payload 与 result 必须是对象')
        }
        // diagram_ir 不回写知识库（由 arch render 消费），显式提示避免静默无操作
        if (kind === 'diagram_ir') {
          return {
            kind,
            action: 'skipped',
            detail: 'diagram_ir 不回写知识库；用 prism arch render 消费该 IR',
          }
        }
        const by = asString(args.by)
        return await writeEnrichment(
          await kb(),
          { kind, payload: args.payload, result: args.result },
          { deposited_by: by !== undefined ? { subject: by } : undefined },
        )
      },
    },
    {
      name: 'prism_kb_graph',
      description: '查询知识图谱（单一边表：双链 references / 层间覆盖 overrides / 版次 supersedes）；给 id 返回邻域，不给返回概览',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '中心节点 id（省略则返回全图概览）' },
          depth: { type: 'integer', minimum: 1, maximum: 3, description: '邻域跳数，默认 1' },
          relations: {
            type: 'array',
            items: { enum: ['references', 'overrides', 'supersedes', 'related'] },
          },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: '节点上限，默认 50' },
          layer: { enum: ['global', 'project', 'role'], description: '限定层' },
          owner: { type: 'string', description: '限定 owner（project/role 层）' },
          book: { type: 'string', description: '限定书' },
          module: { type: 'string', description: '限定模块（_inbox 表示待归类）' },
        },
      },
      call: async (args) => {
        const query: GraphQuery = {
          id: asString(args.id),
          depth: typeof args.depth === 'number' ? args.depth : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          relations: Array.isArray(args.relations) ? (args.relations as GraphQuery['relations']) : undefined,
          layer: asString(args.layer) as GraphQuery['layer'],
          owner: asString(args.owner),
          book: asString(args.book),
          module: asString(args.module),
        }
        return await (await kb()).graph(query)
      },
    },
    {
      name: 'prism_kb_tree',
      description: '知识库结构树（层→书→模块的计数），回答「知识库里有什么」',
      inputSchema: {
        type: 'object',
        properties: {
          layer: { enum: ['global', 'project', 'role'] },
          owner: { type: 'string', description: '限定 owner（project/role 层）' },
        },
      },
      call: async (args) =>
        await (
          await kb()
        ).tree(
          asString(args.layer) as 'global' | 'project' | 'role' | undefined,
          asString(args.owner),
        ),
    },
    {
      name: 'prism_kb_stats',
      description: '知识库统计（条目/书/各层分布），回答「知识库有多大」',
      inputSchema: { type: 'object', properties: {} },
      call: async () => await (await kb()).stats(),
    },
    {
      name: 'prism_kb_catalog',
      description: '全量目录（最新版，带出入度）；供星图/下钻渲染，支持 layer/owner/book 过滤',
      inputSchema: {
        type: 'object',
        properties: {
          layer: { enum: ['global', 'project', 'role'] },
          owner: { type: 'string' },
          book: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 5000 },
        },
      },
      call: async (args) =>
        await (await kb()).catalog({
          layer: asString(args.layer) as 'global' | 'project' | 'role' | undefined,
          owner: asString(args.owner),
          book: asString(args.book),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }),
    },
    {
      name: 'prism_kb_path',
      description: '知识条目之间的最短路径（无向 BFS）；不可达返回 null',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          relations: {
            type: 'array',
            items: { enum: ['references', 'overrides', 'supersedes', 'related'] },
          },
        },
        required: ['from', 'to'],
      },
      call: async (args) => {
        const from = asString(args.from)
        const to = asString(args.to)
        if (from === undefined || to === undefined) {
          throw new Error('prism_kb_path 需要 { from, to }')
        }
        const relations = Array.isArray(args.relations)
          ? (args.relations as GraphQuery['relations'])
          : undefined
        return await (await kb()).path(from, to, relations)
      },
    },
    {
      name: 'prism_kb_remove',
      description: '删除知识条目：默认软删（置 deprecated，可恢复）；hard=true 硬删（被引用时拒绝）',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          hard: { type: 'boolean', description: '默认 false（软删）；true 需无引用' },
        },
        required: ['id'],
      },
      call: async (args) => {
        const id = asString(args.id)
        if (id === undefined) throw new Error('prism_kb_remove 需要 { id }')
        const service = await kb()
        if (service.remove === undefined) throw new Error('当前知识服务未实现 remove')
        return await service.remove(id, { hard: args.hard === true })
      },
    },
    {
      name: 'prism_kb_restore',
      description: '恢复软删条目（deprecated → active）；幂等，本就 active 时 restored=false',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      call: async (args) => {
        const id = asString(args.id)
        if (id === undefined) throw new Error('prism_kb_restore 需要 { id }')
        const service = await kb()
        if (service.restore === undefined) throw new Error('当前知识服务未实现 restore')
        return await service.restore(id)
      },
    },
    {
      name: 'prism_kb_conflicts',
      description: '层间冲突列表（同名跨层且未声明 overrides）；默认只返回未处理的',
      inputSchema: {
        type: 'object',
        properties: { include_resolved: { type: 'boolean' } },
      },
      call: async (args) => {
        const service = await kb()
        if (service.conflicts === undefined) throw new Error('当前知识服务未实现 conflicts')
        return await service.conflicts({ includeResolved: args.include_resolved === true })
      },
    },
    {
      name: 'prism_kb_resolve_conflict',
      description: '标记一条层间冲突已处理（只改标记，不删记录）',
      inputSchema: {
        type: 'object',
        properties: { conflict_id: { type: 'string' } },
        required: ['conflict_id'],
      },
      call: async (args) => {
        const id = asString(args.conflict_id)
        if (id === undefined) throw new Error('prism_kb_resolve_conflict 需要 { conflict_id }')
        const service = await kb()
        if (service.resolveConflict === undefined) throw new Error('当前知识服务未实现 resolveConflict')
        return { resolved: await service.resolveConflict(id) }
      },
    },
    {
      name: 'prism_graph_query',
      description: '查询已建图的代码图谱（graphify query；返回子图/摘要，不返回全图）',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' }, project: { type: 'string', description: '注册的图谱项目名' } },
        required: ['q', 'project'],
      },
      call: graphQuery,
    },
    {
      name: 'prism_graph_status',
      description: '图谱陈旧状态（纯文件哈希比对，不读 git）',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
      call: graphStatus,
    },
    {
      name: 'prism_graph_path',
      description: '代码图谱两节点最短路径（graphify path；返回跳数与链路）',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起点节点标签' },
          to: { type: 'string', description: '终点节点标签' },
          project: { type: 'string' },
        },
        required: ['from', 'to', 'project'],
      },
      call: graphPath,
    },
    {
      name: 'prism_graph_explain',
      description: '解释单个节点及其邻居（graphify explain；返回 id/来源/社区/度数/连接）',
      inputSchema: {
        type: 'object',
        properties: { node: { type: 'string' }, project: { type: 'string' } },
        required: ['node', 'project'],
      },
      call: graphExplain,
    },
    {
      name: 'prism_graph_affected',
      description: '反向遍历求变更影响面（graphify affected；depth 默认 2）',
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: 'string' },
          depth: { type: 'integer', minimum: 1, maximum: 10 },
          project: { type: 'string' },
        },
        required: ['node', 'project'],
      },
      call: graphAffected,
    },
    {
      name: 'prism_graph_summary',
      description: '图谱规模统计（节点/边/社区数；读 graph.json，不调 CLI）',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
      call: graphSummary,
    },
    {
      name: 'prism_graph_god_nodes',
      description: '枢纽节点排行（graphify god-nodes；度数最高的架构中心）',
      inputSchema: {
        type: 'object',
        properties: {
          top: { type: 'integer', minimum: 1, maximum: 100 },
          project: { type: 'string' },
        },
        required: ['project'],
      },
      call: graphGodNodes,
    },
    {
      name: 'prism_graph_merge',
      description:
        '把多个已建图项目的代码图谱合并成一张（graphify merge-graphs + cluster-only 渲染）。产物落 <PRISM_HOME>/graphify-merged/，绝不落任何项目根。只读/生成型：不触发建图（未建图请先自行 prism graph build）。返回摘要（不含 graphify 原始 stdout）',
      inputSchema: {
        type: 'object',
        properties: {
          projects: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            description: '至少 2 个已注册且已建图的项目名',
          },
          out_dir: { type: 'string', description: '可选：覆盖产物目录（落在任一项目根内会被拒绝）' },
        },
        required: ['projects'],
      },
      call: graphMerge,
    },
    {
      name: 'prism_arch_generate',
      description:
        '派生并渲染 archify 架构图（五类：workflow / architecture / sequence / lifecycle / dataflow），返回 HTML 与 IR 路径。IR 全部由 Prism 内置纯函数生成器派生——调用方不需要写任何 IR。workflow 需 { team }；architecture/sequence/dataflow 需 { project }（已注册且已建图，产物落 <projectRoot>/.prism/arch/<type>/）；lifecycle 无需入参（源自 @prism/core 的任务状态机常量）。可选 { book, module } 写进产物 sidecar，让项目图挂到知识库树对应书/模块下（缺省则进全局图集）。生成器在数据不足时会**明确报错而不是造图**（如图谱没有跨文件 calls 边 → 无法画时序图；所有源文件同目录 → 无法分层画依赖流向）。',
      inputSchema: {
        type: 'object',
        properties: {
          type: { enum: ['workflow', 'architecture', 'sequence', 'lifecycle', 'dataflow'] },
          team: { type: 'string', description: 'type=workflow 时的团队 id' },
          project: { type: 'string', description: 'type=architecture|sequence|dataflow 时的已建图项目名' },
          title: { type: 'string', description: '可选：覆盖图标题' },
          top: { type: 'integer', minimum: 1, description: '可选：组件/参与者上限' },
          limit: { type: 'integer', minimum: 1, description: '可选：连线/消息上限' },
          book: { type: 'string', description: '可选：知识库书（写进 sidecar，界面按书挂载该图）' },
          module: { type: 'string', description: '可选：书内模块（写进 sidecar）' },
          out: { type: 'string', description: '可选：覆盖 HTML 产物路径（给了就完全接管落点；缺省见描述）' },
        },
        required: ['type'],
      },
      call: archGenerate,
    },
    {
      name: 'prism_role_list',
      description:
        '列出角色库角色（数据源 = 当前角色目录，只读不写盘）。返回体含 roles_dir——它就是要传给 prism_role_new|edit|rm 的 roles_dir（读回即可回填）',
      inputSchema: { type: 'object', properties: {} },
      call: roleList,
    },
    {
      name: 'prism_role_get',
      description: '取单个角色定义（含 skills/知识绑定/核心第一原则/校验 issues）',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '角色名（kebab-case）' } },
        required: ['name'],
      },
      call: roleGet,
    },
    {
      name: 'prism_role_new',
      description:
        '新建角色（按宿主原生形态写 <roles_dir>/<name>.md；与 HTTP POST /api/roles、CLI `prism role new` 同一实现）。只给 name → 写骨架（描述为占位 TODO）；给出 description/skills/knowledge/body → 写出的就是填好的定义。roles_dir 必填——写路径一律显式参数化，绝不回落到默认宿主目录',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '角色名（kebab-case，= 落盘文件名）' },
          roles_dir: {
            type: 'string',
            description: '**必填**：写入目录（防误写真实宿主）。取值来自 prism_role_list 的 roles_dir',
          },
          description: { type: 'string', description: '一句话职责（含适用/不适用，供派遣决策）' },
          skills: { type: 'array', items: { type: 'string' }, description: 'Skill 白名单' },
          knowledge: {
            type: 'object',
            description: '知识绑定：{layers:[global|project|role], books:[...]}（可选）',
          },
          body: { type: 'string', description: '正文（缺省用内置骨架：核心第一原则/职责/边界/协作位置/完成判定）' },
          color: { type: 'string' },
          model: { type: 'string' },
          thought_level: { enum: ['low', 'high', 'max'] },
          force: { type: 'boolean', description: '已存在时覆盖（缺省跳过，绝不覆盖人写文件）' },
        },
        required: ['name', 'roles_dir'],
      },
      call: roleNew,
    },
    {
      name: 'prism_role_edit',
      description:
        '修改角色（字段补丁：description/skills/knowledge/body/color/model/thought_level）。只改点名的字段——正文与未知 frontmatter 键原样保留，不整文件重排。roles_dir 必填',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '角色名（kebab-case）' },
          roles_dir: { type: 'string', description: '**必填**：角色所在目录' },
          description: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' }, description: '能力白名单；[] = 清空' },
          knowledge: { type: 'object', description: '{layers:[...], books:[...]}；{layers:[]} = 清空' },
          body: { type: 'string', description: '整段替换正文（缺省不动）' },
          color: { type: 'string', description: '角色色（red/blue/green/yellow/purple/orange/pink/cyan）；空串 = 清除' },
          model: { type: 'string', description: '空串 = 清除' },
          thought_level: { enum: ['low', 'high', 'max'], description: '空串 = 清除' },
        },
        required: ['name', 'roles_dir'],
      },
      call: roleEdit,
    },
    {
      name: 'prism_role_rm',
      description:
        '删除角色文件本体（扁平 <name>.md 与兼容形态 <name>/AGENTS.md 都删，整目录搬走不留残目录）。**删除进回收站**，默认 3 天后彻底清除；自动清除需 serve 运行（纯 CLI 部署靠 `prism trash purge` 兜底）。返回体含 trash_id，可经 `prism trash restore <trash_id>` 还原——roles_dir 必填，绝不回落到默认宿主目录',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '角色名（kebab-case）' },
          roles_dir: { type: 'string', description: '**必填**：角色所在目录' },
        },
        required: ['name', 'roles_dir'],
      },
      call: roleRemove,
    },
    {
      name: 'prism_context_pack',
      description:
        '组装上下文包：按角色知识绑定 + 任务关键词检索，返回带预算截断的知识条目与来源（Prism 只产包，prompt 由宿主决定）',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: '角色名（用其 knowledge 绑定限定层/书）' },
          task: { type: 'string', description: '任务描述（作为检索词）' },
          budget_tokens: { type: 'integer', minimum: 100, maximum: 100000, description: 'token 预算，默认 4000' },
          layers: {
            type: 'array',
            items: { enum: ['global', 'project', 'role'] },
            description: 'F-B1：显式覆盖角色绑定的层集合（缺省取角色绑定）',
          },
          books: {
            type: 'array',
            items: { type: 'string' },
            description: 'F-B1：显式覆盖角色绑定的书过滤（缺省取角色绑定）',
          },
          symbols: {
            type: 'array',
            items: { type: 'string' },
            description: 'F-B2：代码符号/文件路径；命中 title+excerpt 的条目 relevance×1.15 并在 graph_hits 写出',
          },
          max_excerpt_chars: {
            type: 'integer',
            minimum: 1,
            maximum: 100000,
            description: '每项最多保留的正文字符数，默认 600',
          },
        },
        required: ['role', 'task'],
      },
      call: contextPack,
    },
    {
      name: 'prism_skill_effective',
      description:
        '有效 Skill 集（F-D2）：角色 ×（可选）团队 → 能用的 skill（含来源标注 global/team/role 与宿主是否已装）+ 缺失告警。与 HTTP /api/skills/effective、CLI 同口径',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: '角色名（kebab-case）' },
          team: { type: 'string', description: '团队 id（可选；提供则并入团队声明的 skills）' },
        },
        required: ['role'],
      },
      call: skillEffective,
    },
    {
      name: 'prism_skill_list',
      description:
        '列出内置 Skill（只读）。返回体含 skills_dir——它就是要传给 prism_skill_install|uninstall 的 skills_dir（读回即可回填）；installed 为宿主 skills 目录实测结果',
      inputSchema: { type: 'object', properties: {} },
      call: skillList,
    },
    {
      name: 'prism_skill_install',
      description:
        '安装内置 Skill 到宿主（写 <skills_dir>/<name>/SKILL.md；与 HTTP POST /api/skills/install、CLI `prism skill install` 同一实现）。names 缺省 = 装全部内置。人写的 Skill（无 Prism marker）不覆盖，写 .prism-new 供对比（force=true 强制覆盖）。skills_dir 必填——写路径一律显式参数化，绝不回落到默认宿主目录',
      inputSchema: {
        type: 'object',
        properties: {
          skills_dir: {
            type: 'string',
            description: '**必填**：安装目标目录（防误写真实宿主）。取值来自 prism_skill_list 的 skills_dir',
          },
          names: {
            type: 'array',
            items: { type: 'string' },
            description: '要安装的 Skill 名（缺省 = 全部内置）',
          },
          force: { type: 'boolean', description: '覆盖人写的同名 Skill（缺省不覆盖，写 .prism-new 供对比）' },
        },
        required: ['skills_dir'],
      },
      call: skillInstall,
    },
    {
      name: 'prism_skill_uninstall',
      description:
        '卸载 Skill（**只删 Prism 产物**：SKILL.md 含 marker；人写的 Skill 一律不动并记入 kept）。names 缺省 = 扫描 skills_dir 下全部 Skill。**删除进回收站**，默认 3 天后彻底清除；自动清除需 serve 运行（纯 CLI 部署靠 `prism trash purge` 兜底）。返回体含 trash_ids，可经 `prism trash restore <trash_id>` 还原——skills_dir 必填，绝不回落到默认宿主目录',
      inputSchema: {
        type: 'object',
        properties: {
          skills_dir: { type: 'string', description: '**必填**：Skill 所在目录' },
          names: { type: 'array', items: { type: 'string' }, description: '要卸载的 Skill 名（缺省 = 目录下全部）' },
        },
        required: ['skills_dir'],
      },
      call: skillUninstall,
    },
    {
      name: 'prism_skill_categorize',
      description:
        '给技能打分类标签（v8 F7）：写 <PRISM_HOME>/skill-categories.json 的 Prism 侧映射（**不碰宿主技能文件、不校验技能是否存在**——分类判断归宿主）。category 省略或空串 = **清除**该技能的分类；names 必填且非空。与 HTTP POST /api/skills/categorize、CLI `prism skill categorize` 同一实现',
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: '要设置分类的技能名（必填且非空；可一次多个）',
          },
          category: {
            type: 'string',
            description: '分类名；省略或空串 = 清除这些技能的分类（不校验技能是否存在）',
          },
        },
        required: ['names'],
      },
      call: skillCategorize,
    },
    {
      name: 'prism_skill_category_add',
      description:
        '新建技能分类（v12 F4）：写 <PRISM_HOME>/skill-categories.json 的 categories 清单（**只登记分类名、不写 mapping**——空分类要存得住）。name trim 后为空 → bad_request；重名 → id_conflict。与 HTTP POST /api/skills/categories、CLI `prism skill category add` 同一实现',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '分类名（trim 后非空；重名报 id_conflict）' } },
        required: ['name'],
      },
      call: skillCategoryAdd,
    },
    {
      name: 'prism_skill_category_rename',
      description:
        '技能分类改名（v12 F4）：级联改 mapping（分类在原位置就地替换，保序）——组内技能自动跟到新名下。from 不存在 → not_found；to 与**另一个**现存分类重名 → id_conflict；from === to 幂等 no-op。与 HTTP PATCH /api/skills/categories/:name、CLI `prism skill category rename` 同一实现',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '旧分类名（不存在报 not_found）' },
          to: { type: 'string', description: '新分类名（与另一现存分类重名报 id_conflict）' },
        },
        required: ['from', 'to'],
      },
      call: skillCategoryRename,
    },
    {
      name: 'prism_skill_category_rm',
      description:
        '删除技能分类（v12 F4）：从 categories 移除，并清掉指向它的 mapping 条目（**组内技能回未分类**，不是指向空串）。name 不存在 → not_found。与 HTTP DELETE /api/skills/categories/:name、CLI `prism skill category rm` 同一实现',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '分类名（不存在报 not_found）' } },
        required: ['name'],
      },
      call: skillCategoryRm,
    },
    {
      name: 'prism_role_render',
      description:
        '渲染单个角色为宿主原生形态（只预览不写盘）——与 prism_role_new 同一渲染器。用途：看「若新建/归一化，落盘会是什么样」，或校验手写角色能否被宿主认',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '角色名（kebab-case）' },
          model: { type: 'string', description: '覆盖环境属性 model（宿主本机可用模型）' },
          thought_level: { enum: ['low', 'high', 'max'] },
        },
        required: ['name'],
      },
      call: roleRender,
    },
    {
      name: 'prism_team_list',
      description: '列出团队库团队（数据源 = 宿主团队目录 teams_dir；只读）',
      inputSchema: { type: 'object', properties: {} },
      call: teamList,
    },
    {
      name: 'prism_team_get',
      description:
        '取团队定义（frontmatter + 工作流 + 沉淀规则；数据源 = 宿主团队目录 teams_dir）。v11：响应增只读 `workflow_raw`（被编辑文件本体的原始工作流表：columns/rows/rowIds/unmapped/prose/sectionMissing/proseText，**不经 extends 合并**）与 `source_mtime`（epoch 毫秒整数）——前者供 prism_team_edit 的 rowId 对齐未映射列，后者供 if_match 防陈旧写；读侧行级诊断以 warning 并入 issues',
      inputSchema: {
        type: 'object',
        properties: { team_id: { type: 'string' } },
        required: ['team_id'],
      },
      call: teamGet,
    },
    {
      name: 'prism_team_activate',
      description:
        '启用团队：返回成员（含每个角色的 installed/dispatch 状态与 fallback 角色定义本体）+ 工作流 + Skill/知识绑定 + 沉淀规则 + 仲裁链',
      inputSchema: {
        type: 'object',
        properties: { team_id: { type: 'string' } },
        required: ['team_id'],
      },
      call: teamActivate,
    },
    {
      name: 'prism_team_new',
      description:
        '新建团队定义（写 <teams_dir>/<team_id>.md；与 HTTP POST /api/teams、CLI `prism team new` 同一实现）。teams_dir 必填——写路径一律显式参数化，绝不回落到默认宿主目录。成员角色须已存在于角色库（roles_dir 可显式指定，缺省取当前角色目录）',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: '新团队 id（kebab-case，= 落盘文件名）' },
          name: { type: 'string', description: '中文名（缺省 = team_id）' },
          description: { type: 'string' },
          members: {
            type: 'array',
            items: {
              type: 'object',
              properties: { role: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
              required: ['role'],
            },
            description: '成员角色（必须已存在于角色库）',
          },
          deposit: {
            type: 'object',
            description: '沉淀策略（enabled/default_layer/default_type/priority/require_note；可选）',
          },
          workflow_template: { enum: ['minimal', 'core-dev'], description: '工作流模板，缺省 minimal' },
          workflow: {
            type: 'object',
            description:
              '结构化保存工作流（v11 F2）：{ stages: [...], columns?: [...] }。stages 为空数组 = 清空工作流；每项 {rowId?, order, stage, roles?, mode?, input?, output?, done?, reflow?, extra?}，缺省 roles=[] / mode=serial / 文本字段为空串。新建无原行身份，rowId 通常省略（= 模板行全换为提交行）；columns = 提交列集（含未映射列，非空、trim 后唯一）；不给 = 模板列集',
            properties: {
              stages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    rowId: { type: 'string', description: '原 raw 行身份（对齐未映射列合并用；新行省略）' },
                    order: { type: 'number' },
                    stage: { type: 'string' },
                    roles: { type: 'array', items: { type: 'string' } },
                    mode: { enum: ['serial', 'parallel'] },
                    input: { type: 'string' },
                    output: { type: 'string' },
                    done: { type: 'string' },
                    reflow: { type: 'string' },
                    extra: { type: 'object', description: '未映射列值（列名 → 单元格文本）' },
                  },
                  required: ['order', 'stage'],
                },
              },
              columns: {
                type: 'array',
                items: { type: 'string' },
                description: '提交列集（含未映射列，保持列序；非空、trim 后唯一）；不给 = 模板列集',
              },
            },
            required: ['stages'],
          },
          teams_dir: { type: 'string', description: '**必填**：写入目录（防误写真实宿主）' },
          roles_dir: {
            type: 'string',
            description: '校验成员角色用的角色库（可选；缺省取当前角色目录）。取值来自 prism_role_list 的 roles_dir',
          },
        },
        required: ['team_id', 'members', 'teams_dir'],
      },
      call: async (args) => await createTeamDefinition(args as NewTeamBody, rolesDir),
    },
    {
      name: 'prism_team_edit',
      description:
        '修改团队（字段补丁：name/description/members/deposit/workflow）。改 members 时工作流表**就地按名册收窄**（剔除不属于名册的角色，空阶段删除并重编号），并校验角色都在角色库中。**workflow = 结构化保存工作流**（每项含 rowId/order/stage/roles/mode/input/output/done/reflow/extra；raw 底账由服务端重读文件并按 rowId 合并未映射列）——members 与 workflow 同给时 **workflow 胜**（编辑器所见即所存）。if_match 取 prism_team_get 同源的 source_mtime，不匹配 → 409 stale_write。teams_dir 必填',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string' },
          teams_dir: { type: 'string', description: '**必填**：团队所在目录' },
          name: { type: 'string' },
          description: { type: 'string' },
          members: {
            type: 'array',
            items: {
              type: 'object',
              properties: { role: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
              required: ['role'],
            },
            description: '新名册（替换式；给定时必须同时给 roles_dir；与 workflow 同给时 workflow 胜）',
          },
          roles_dir: { type: 'string', description: '改 members 时必填：用于校验角色存在' },
          deposit: { type: 'object', description: '沉淀策略补丁（只覆盖给出的键）' },
          workflow: {
            type: 'object',
            description:
              '结构化保存工作流（v11 F2）：{ stages: [...], columns?: [...] }。stages 为空数组 = 清空工作流；每项 {rowId?, order, stage, roles?, mode?, input?, output?, done?, reflow?, extra?}，缺省 roles=[] / mode=serial / 文本字段为空串。rowId 取自 prism_team_get 的 workflow_raw.rowIds（缺省 = 新增行；原行未提交 = 删除该行）。columns = 提交列集（含未映射列，保持列序；非空且 trim 后唯一，非法 400 workflow_invalid）：核心字段列不在其中 = 该列不入表，自定义列按名取 extra；不给 = 沿用原表列集',
            properties: {
              stages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    rowId: { type: 'string', description: '原 raw 行身份（对齐未映射列合并用；新行省略）' },
                    order: { type: 'number' },
                    stage: { type: 'string' },
                    roles: { type: 'array', items: { type: 'string' } },
                    mode: { enum: ['serial', 'parallel'] },
                    input: { type: 'string' },
                    output: { type: 'string' },
                    done: { type: 'string' },
                    reflow: { type: 'string' },
                    extra: { type: 'object', description: '未映射列值（列名 → 单元格文本）' },
                  },
                  required: ['order', 'stage'],
                },
              },
              columns: {
                type: 'array',
                items: { type: 'string' },
                description: '提交列集（含未映射列，保持列序；非空、trim 后唯一）；不给 = 沿用原表列集',
              },
            },
            required: ['stages'],
          },
          if_match: {
            type: 'integer',
            description: '陈旧写防护：取 GET 的 source_mtime（epoch 毫秒整数）；与磁盘 mtime 不符 → 409 stale_write',
          },
        },
        required: ['team_id', 'teams_dir'],
      },
      call: teamEdit,
    },
    {
      name: 'prism_team_rm',
      description:
        '删除团队（扁平 <id>.md 与兼容形态 <id>/AGENTS.md 都删，整目录搬走不留残目录）。**删除进回收站**，默认 3 天后彻底清除；自动清除需 serve 运行（纯 CLI 部署靠 `prism trash purge` 兜底）。返回体含 trash_id，可经 `prism trash restore <trash_id>` 还原——teams_dir 必填，绝不回落到默认宿主目录',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string' },
          teams_dir: { type: 'string', description: '**必填**：团队所在目录' },
        },
        required: ['team_id', 'teams_dir'],
      },
      call: teamRemove,
    },
    {
      name: 'prism_team_render',
      description: '渲染单个团队为宿主原生形态（只预览不写盘）——与 prism_team_new 同一渲染器',
      inputSchema: {
        type: 'object',
        properties: { team_id: { type: 'string' } },
        required: ['team_id'],
      },
      call: teamRender,
    },
  ]

  // 释放惰性打开的句柄（幂等）。见 `McpToolSet` 注释：不释放会导致 Windows 上
  // 临时目录的 `*.db/-wal/-shm` 删不掉（F-T1）。
  return Object.assign(tools, {
    close: (): void => {
      kbCache?.close?.()
      kbCache = undefined
    },
  })
}

/** 本包版本：读自身 package.json（MCP `initialize` 的 serverInfo 用）。
 *  曾经硬编码 '0.1.0'，发版后与真实版本脱节——宿主据此做的版本判断会失真。
 *  开发态（src/mcp/）与打包态（node_modules/@prism/server/dist/mcp/）到
 *  package.json 的相对层级一致，都是上两级。 */
const SERVER_VERSION = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 处理单条 JSON-RPC 请求（纯函数式，便于测试）。 */
export async function handleRpcRequest(request: JsonRpcRequest, tools: McpTool[]): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null
  const isNotification = request.id === undefined || request.id === null

  if (request.method.startsWith('notifications/')) {
    return null
  }

  const respond = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
  const respondError = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })

  switch (request.method) {
    case 'initialize':
      return respond({
        protocolVersion:
          typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'prism-mcp', version: SERVER_VERSION },
      })
    case 'ping':
      return respond({})
    case 'tools/list':
      return respond({
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
    case 'tools/call': {
      const name = typeof request.params?.name === 'string' ? request.params.name : ''
      const tool = tools.find((t) => t.name === name)
      if (tool === undefined) {
        return respondError(ERR_METHOD_NOT_FOUND, `未知工具: ${name}`)
      }
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const value = await tool.call(args)
        return respond({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false })
      } catch (error) {
        // 工具执行错误按 MCP 约定走 result.isError，而非 JSON-RPC error。
        // PrismError 带上 [code] 前缀——宿主需要按错误码分支（如 bad_request / harness_not_found）。
        const text =
          error instanceof PrismError
            ? `[${error.code}] ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error)
        return respond({ content: [{ type: 'text', text }], isError: true })
      }
    }
    default:
      if (isNotification) {
        return null
      }
      return respondError(ERR_METHOD_NOT_FOUND, `未知方法: ${request.method}`)
  }
}

/** 参数校验错误统一为 invalid_params。 */
export function invalidParams(message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: null, error: { code: ERR_INVALID_PARAMS, message } }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 字符串数组参数（F-B1/F-B2 的 layers/books/symbols）：非数组 → undefined；元素只取非空字符串。 */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === 'string' && v !== '')
}

/** 正整数参数（max_excerpt_chars）：非法/缺省 → undefined（不静默改成别的值）。 */
function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

/**
 * 宿主启动时**顺带把控制台拉起来** —— 这就是「harness 用的时候自动拉起来」。
 *
 * 三条纪律（违反任何一条都会把 MCP 弄坏）：
 * 1. **不 await**：ensure 最长等 30s 就绪，阻塞启动会让宿主连接超时 → fire-and-forget；
 * 2. **不写 stdout**：stdout 是 JSON-RPC 通道，输出污染即协议损坏 → 只写 stderr；
 * 3. **失败不致命**：控制台起不来只影响 UI，MCP 工具照常可用 → 全部 catch。
 *
 * 关闭：`PRISM_SERVE_AUTOSTART=0`；换端口：`PRISM_SERVE_PORT=<n>`。
 */
function autostartConsole(home: string): void {
  if (process.env['PRISM_SERVE_AUTOSTART'] === '0') return
  const port = Number(process.env['PRISM_SERVE_PORT'] ?? DEFAULT_SERVE_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return
  void ensureServe({ home, host: '127.0.0.1', port }).catch((error: unknown) => {
    process.stderr.write(
      `[prism-mcp] 控制台自动拉起失败（不影响 MCP 工具）: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  })
}

/**
 * stdio 传输：逐行读 JSON-RPC，逐行写响应（启动 MCP：`node dist/mcp/server.js`）。
 *
 * **先加载 harness 插件再建工具**：适配器（含插件提供的）要在 `createMcpTools` 里被
 * `resolveDirs`/`resolveHarness` 解析，故加载完成前不开始读 stdin（加载很快）。
 */
export function runMcpStdio(options: { home?: string; harnessRoot?: string } = {}): void {
  const home = options.home ?? prismHome()
  void ensureHarnessPluginsLoaded(home)
    .catch(() => {
      // 插件加载异常不得阻断 MCP 启动（内部已逐项容错，这里兜底）
    })
    .then(() => serveMcpStdio(home, options))
}

/** 建立工具并开始服务（插件已加载后调用）。 */
function serveMcpStdio(home: string, options: { harnessRoot?: string }): void {
  autostartConsole(home)
  const tools = createMcpTools({ home, harnessRoot: options.harnessRoot })
  const input = createInterface({ input: process.stdin })
  const write = (response: JsonRpcResponse | null): void => {
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`)
    }
  }
  input.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed === '') {
      return
    }
    let request: JsonRpcRequest
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      write(invalidParams(`不是合法 JSON: ${trimmed.slice(0, 100)}`))
      return
    }
    void handleRpcRequest(request, tools)
      .then(write)
      .catch((error: unknown) => {
        process.stderr.write(`prism-mcp 内部错误: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      })
  })
  process.stderr.write(`prism-mcp ready (home=${home})\n`)
}

/** 直接以本文件为入口运行时启动 stdio 服务：`node dist/mcp/server.js` */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpStdio()
}
