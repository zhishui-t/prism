import { createInterface } from 'node:readline'

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AuditLog, prismHome, openPersistence, prismPaths, PrismError, TaskLedger } from '@prism/core'
import { ensureHarnessPluginsLoaded } from '@prism/agents'

import {
  activateTeam,
  applyDepositPolicy,
  installedSkillNames,
  loadRole,
  loadRoles,
  loadTeam,
  renderZcodeRole,
  resolveDirsFromHome,
  harnessPaths,
} from '../roles/index.js'
import {
  runGraphify,
  graphPath as queryGraphPath,
  graphExplain as queryGraphExplain,
  graphAffected as queryGraphAffected,
  graphGodNodes as queryGraphGodNodes,
  graphSummary as queryGraphSummary,
} from '../graph/graphify.js'
import { inspectGraphStatus, ProjectRegistry } from '../graph/registry.js'
import { convertFileToMarkdown } from '../kb/convert-file.js'
import { makeDryRunKb, scanProject } from '../kb/scan.js'
import type { DepositInput, GraphQuery, KnowledgeService, SearchQuery } from '../kb/port.js'
import { loadKnowledgeService } from '../kb/wiring.js'
import { buildContextPack } from '../kb/context-pack.js'
import { writeEnrichment } from '../kb/enrich-writeback.js'

/**
 * MCP stdio 服务（design.md §4 最小集 + design-v3 §3.4 P6 增量，手写 JSON-RPC 2.0）：
 * prism_kb_search / prism_kb_get / prism_kb_deposit / prism_graph_query / prism_graph_status
 * + prism_role_list / prism_role_render / prism_team_get / prism_team_activate。
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
  /** ZCode 宿主根目录（role_render 目标提示、team_activate 判装配状态）；默认 PRISM_HARNESS_ROOT → ~/.zcode */
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

/** 组装 MCP 工具集（依赖注入便于测试）。 */
export function createMcpTools(deps: McpDeps): McpTool[] {
  let kbCache: KnowledgeService | undefined
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

  // 任务台账（被动台账，task-center.md）：宿主登记 DAG / 回报状态；Prism 只记录
  let taskLedger: TaskLedger | undefined
  const ledger = async (): Promise<TaskLedger> => {
    if (taskLedger === undefined) {
      const persistence = openPersistence({ home: deps.home })
      taskLedger = new TaskLedger({
        persistence,
        audit: new AuditLog({ dir: prismPaths(deps.home).auditDir, queue: persistence.queue }),
      })
    }
    return taskLedger
  }

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
  const zcode = harnessPaths(harnessRoot)

  const requireTeam = async (teamId: unknown) => {
    const id = asString(teamId)
    if (id === undefined) {
      throw new Error('缺少 team_id')
    }
    const team = await loadTeam(teamsDir, id, { rolesDir })
    if (team === null) {
      throw new Error(`团队不存在: ${id}（数据源 ${teamsDir}/<id>/AGENTS.md）`)
    }
    return team
  }

  const roleList = async (): Promise<unknown> => {
    const roles = await loadRoles(rolesDir)
    return { count: roles.length, roles, agents_dir: zcode.agentsDir }
  }

  /**
   * 上下文包（knowledge-injection.md §4 模式 B）：
   * 按角色知识绑定 + 任务关键词检索，组装带预算的包。Prism 只产包、不写 prompt。
   */
  const contextPack = async (args: Record<string, unknown>): Promise<unknown> => {
    const roleName = asString(args.role)
    const task = asString(args.task)
    if (roleName === undefined || task === undefined) {
      throw new Error('prism_context_pack 需要 { role, task }')
    }
    const role = await loadRole(rolesDir, roleName)
    if (role === null) {
      throw new Error(`角色不存在: ${roleName}（数据源 ${rolesDir}/<name>/AGENTS.md）`)
    }
    return await buildContextPack(await kb(), {
      role: roleName,
      binding: role.knowledge,
      task,
      ...(typeof args.budget_tokens === 'number' ? { budgetTokens: args.budget_tokens } : {}),
    })
  }

  /** 取单个角色定义（装配器按名拉取，免拉全量）。 */
  const roleGet = async (args: Record<string, unknown>): Promise<unknown> => {
    const name = asString(args.name)
    if (name === undefined) {
      throw new Error('prism_role_get 需要 { name }')
    }
    const role = await loadRole(rolesDir, name, { knownSkills: await installedSkillNames(harnessRoot) })
    if (role === null) {
      throw new Error(`角色不存在: ${name}（数据源 ${rolesDir}/<name>/AGENTS.md）`)
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
      throw new Error(`角色不存在: ${name}（数据源 ${rolesDir}/<name>/AGENTS.md）`)
    }
    const env: { model?: string; thoughtLevel?: string } = {}
    const model = asString(args.model)
    const thoughtLevel = asString(args.thought_level) ?? asString(args.thoughtLevel)
    if (model !== undefined) {
      env['model'] = model
    }
    if (thoughtLevel !== undefined) {
      env['thoughtLevel'] = thoughtLevel
    }
    const content = renderZcodeRole(role, env)
    return { name, target: join(zcode.agentsDir, `${name}.md`), content }
  }

  const teamGet = async (args: Record<string, unknown>): Promise<unknown> => {
    return await requireTeam(args.team_id)
  }

  const teamActivate = async (args: Record<string, unknown>): Promise<unknown> => {
    const team = await requireTeam(args.team_id)
    return await activateTeam(team, { rolesDir, targetDir: zcode.agentsDir })
  }

  return [
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
            properties: { kind: { enum: ['import', 'agent', 'manual'] }, ref: { type: 'string' } },
          },
          deposited_by: {
            type: 'object',
            properties: { subject: { type: 'string' }, team: { type: 'string' } },
            description: '留痕：谁/哪个团队落库',
          },
          team_id: {
            type: 'string',
            description: '按该团队的 deposit 策略机械校验（enabled/require_note/rules）；省略则不校验',
          },
        },
        required: ['title', 'type', 'layer', 'book', 'content'],
      },
      call: async (args) => {
        const raw = args as unknown as DepositInput & { team_id?: string }
        const teamId = asString(raw.team_id)
        // 团队沉淀策略：机械校验 + 默认值 + rules 覆盖（team-definition.md §5）
        if (teamId !== undefined) {
          const team = await requireTeam(teamId)
          const outcome = applyDepositPolicy(team.deposit, {
            title: raw.title,
            type: raw.type,
            layer: raw.layer,
            book: raw.book,
            content: raw.content,
            ...(raw.owner !== undefined ? { owner: raw.owner } : {}),
            ...(raw.module !== undefined ? { module: raw.module } : {}),
            ...(raw.tags !== undefined ? { tags: raw.tags } : {}),
            ...(raw.risk !== undefined ? { risk: raw.risk } : {}),
            ...(raw.source !== undefined ? { source: raw.source } : {}),
          })
          if (!outcome.allowed) {
            throw new Error(`沉淀策略拒绝：${outcome.errors.join('；')}`)
          }
          const p = outcome.input
          return await (await kb()).deposit({
            title: p.title,
            type: p.type as DepositInput['type'],
            layer: p.layer as DepositInput['layer'],
            book: p.book,
            content: p.content,
            ...(p.owner !== undefined ? { owner: p.owner } : {}),
            ...(p.module !== undefined ? { module: p.module } : {}),
            ...(p.tags !== undefined ? { tags: p.tags } : {}),
            ...(p.risk !== undefined ? { risk: p.risk as DepositInput['risk'] } : {}),
            ...(p.source !== undefined ? { source: p.source } : {}),
            ...(p.visibility !== undefined
              ? { visibility: p.visibility as DepositInput['visibility'] }
              : {}),
            ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
            ...(raw.overrides !== undefined ? { overrides: raw.overrides } : {}),
            ...(raw.deposited_by !== undefined ? { deposited_by: raw.deposited_by } : {}),
          })
        }
        return await (await kb()).deposit(raw)
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
        '把项目文档目录扫描成「引用型」索引（项目文件为真相，Prism 只存索引 + 转换后的检索副本，只读不改原文件）。适合宿主批量导入项目知识：先 import 建索引，再对重点条目用 prism_kb_enrich 补实体/摘要',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目根目录绝对路径' },
          owner: { type: 'string', description: '项目名（project 层 owner）' },
          book: { type: 'string', description: '书（默认取项目名）' },
          module: { type: 'string', description: '模块（默认按目录推断）' },
          dry_run: { type: 'boolean', description: '只报告不落库（默认 false）' },
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
        const service = await kb()
        const target = dryRun ? makeDryRunKb(service) : service
        const report = await scanProject(target, {
          root,
          layer: 'project',
          owner,
          ...(asString(args.book) !== undefined ? { book: asString(args.book)! } : {}),
          ...(asString(args.module) !== undefined ? { module: asString(args.module)! } : {}),
        })
        return {
          root: report.root,
          discovered: report.discovered,
          created: report.created,
          updated: report.updated,
          unchanged: report.unchanged,
          skipped: report.skipped,
          truncated: report.truncated,
          missing: report.missing,
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
      name: 'prism_role_list',
      description: '列出 Prism 角色库角色（数据源 <PRISM_HOME>/roles/；供装配器拉取定义）',
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
      name: 'prism_context_pack',
      description:
        '组装上下文包：按角色知识绑定 + 任务关键词检索，返回带预算截断的知识条目与来源（Prism 只产包，prompt 由宿主决定）',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: '角色名（用其 knowledge 绑定限定层/书）' },
          task: { type: 'string', description: '任务描述（作为检索词）' },
          budget_tokens: { type: 'integer', minimum: 100, maximum: 100000, description: 'token 预算，默认 4000' },
        },
        required: ['role', 'task'],
      },
      call: contextPack,
    },
    {
      name: 'prism_role_render',
      description: '渲染单个角色为 ZCode 格式（含 marker；装配器按返回 target 写入 agents 目录）',
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
      name: 'prism_team_get',
      description: '取团队定义（frontmatter + 工作流 + 沉淀规则；数据源 <PRISM_HOME>/teams/）',
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
      name: 'prism_task_register',
      description:
        '批量登记任务 DAG（被动台账：只记录不触发执行）。校验任务 id 唯一、依赖同批内存在、无环',
      inputSchema: {
        type: 'object',
        properties: {
          dag_id: { type: 'string' },
          session_id: { type: 'string' },
          team_id: { type: 'string' },
          project_id: { type: 'string' },
          version: { type: 'string' },
          difficulty: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                depends_on: { type: 'array', items: { type: 'string' } },
                write_scopes: { type: 'array', items: { type: 'string' } },
                assigned_agent: { type: 'string' },
                executor: { type: 'string' },
                stage: { type: 'string' },
              },
              required: ['id', 'description'],
            },
          },
        },
        required: ['dag_id', 'session_id', 'team_id', 'project_id', 'version', 'difficulty', 'tasks'],
      },
      call: async (args) => await (await ledger()).registerDag(args as never),
    },
    {
      name: 'prism_task_report',
      description:
        '回报任务状态（被动台账：执行方推状态，Prism 只记录）。状态机校验转移合法性 + 乐观并发（expected_revision）',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          from_status: { type: 'string', description: '执行方声明的当前状态（并发守卫）' },
          to_status: { type: 'string' },
          by: { type: 'string', description: '回报者标识' },
          expected_revision: { type: 'integer', description: '期望 revision（乐观并发）' },
          result: { description: '结果对象（可选）' },
          error_type: { type: 'string' },
        },
        required: ['task_id', 'to_status', 'by'],
      },
      call: async (args) => await (await ledger()).report(args as never),
    },
    {
      name: 'prism_task_status',
      description: '查询任务台账（列表/单任务/DAG 依赖图/统计）',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '取单任务（与 dag_id 二选一）' },
          dag_id: { type: 'string', description: '取该 DAG 的任务与依赖图' },
          status: { type: 'string', description: '按状态过滤列表' },
          session_id: { type: 'string', description: '按会话过滤列表' },
        },
      },
      call: async (args) => {
        const led = await ledger()
        const taskId = asString(args.task_id)
        if (taskId !== undefined) return led.get(taskId)
        const dagId = asString(args.dag_id)
        if (dagId !== undefined) return led.dag(dagId)
        return {
          tasks: led.list({
            ...(asString(args.status) !== undefined ? { status: asString(args.status) as never } : {}),
            ...(asString(args.session_id) !== undefined ? { session_id: asString(args.session_id) as string } : {}),
          }),
          stats: led.stats(),
        }
      },
    },
  ]
}

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
        serverInfo: { name: 'prism-mcp', version: '0.1.0' },
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
        // PrismError 带上 [code] 前缀——宿主需要按错误码分支（如 work_already_claimed / task_stale_revision）。
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
