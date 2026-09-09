import { createInterface } from 'node:readline'

import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prismHome, openPersistence, PrismError, WorkQueue, WORK_KINDS, BUILTIN_VALIDATORS, TaskLedger, type WorkKind } from '@prism/core'

import { activateTeam, loadRole, loadRoles, loadTeam, renderZcodeRole, resolveDirsFromHome, zcodePaths } from '../roles/index.js'
import { runGraphify } from '../graph/graphify.js'
import { inspectGraphStatus, ProjectRegistry } from '../graph/registry.js'
import type { DepositInput, GraphQuery, KnowledgeService, SearchQuery } from '../kb/port.js'
import { loadKnowledgeService } from '../kb/wiring.js'

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
  /** ZCode 宿主根目录（role_render 目标提示、team_activate 判装配状态）；默认 PRISM_ZCODE_DIR → ~/.zcode */
  zcodeDir?: string
  kb?: KnowledgeService
  kbFactory?: () => Promise<KnowledgeService>
  graphifyEnv?: NodeJS.ProcessEnv
  graphifyTimeoutMs?: number
  /** 注入工作队列（测试注入内存实例）；不传则按 home 惰性自建 */
  workQueue?: WorkQueue
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

  // 工作队列（拉取式，work-queue.md §4）：宿主经 MCP 认领执行 LLM 工作；Prism 不调 LLM
  // 持久化随 stdio 进程退出释放，无需显式关闭（进程生命周期 = 会话生命周期）
  let workQueue: WorkQueue | undefined = deps.workQueue
  const queue = async (): Promise<WorkQueue> => {
    if (workQueue !== undefined) return workQueue
    const created = new WorkQueue({ persistence: openPersistence({ home: deps.home }) })
    for (const kind of WORK_KINDS) {
      created.registerValidator(kind, BUILTIN_VALIDATORS[kind])
    }
    workQueue = created
    return created
  }

  // 任务台账（被动台账，task-center.md）：宿主登记 DAG / 回报状态；Prism 只记录
  let taskLedger: TaskLedger | undefined
  const ledger = async (): Promise<TaskLedger> => {
    if (taskLedger === undefined) {
      taskLedger = new TaskLedger({ persistence: openPersistence({ home: deps.home }) })
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
    const graph = join(root, '.graphify', 'graph.json')
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

  // ---- 角色 / 团队（design-v3 §3.4 P6：宿主拉配置主链路；数据源与 CLI 同源 resolveDirs，B8）----
  const zcodeDir = deps.zcodeDir ?? process.env['PRISM_ZCODE_DIR'] ?? join(homedir(), '.zcode')
  const dirs = resolveDirsFromHome(deps.home, { zcodeDir, zcodeDirExplicit: true })
  const rolesDir = dirs.rolesDir
  const teamsDir = dirs.teamsDir
  const zcode = zcodePaths(zcodeDir)

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
        },
        required: ['title', 'type', 'layer', 'book', 'content'],
      },
      call: async (args) => {
        const input = args as unknown as DepositInput
        return await (await kb()).deposit(input)
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
        },
      },
      call: async (args) => {
        const query: GraphQuery = {
          id: asString(args.id),
          depth: typeof args.depth === 'number' ? args.depth : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          relations: Array.isArray(args.relations) ? (args.relations as GraphQuery['relations']) : undefined,
        }
        return await (await kb()).graph(query)
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
      description: '图谱陈旧状态（manifest 哈希 + git HEAD）',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
      call: graphStatus,
    },
    {
      name: 'prism_role_list',
      description: '列出 Prism 角色库角色（数据源 <PRISM_HOME>/roles/；供装配器拉取定义）',
      inputSchema: { type: 'object', properties: {} },
      call: roleList,
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
      name: 'prism_work_pending',
      description:
        '列出待办的 LLM 工作（Prism 不调 LLM：宿主拉取后用自己的 agent 执行）。按优先级降序、创建时间升序',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { enum: [...WORK_KINDS] },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          priority_min: { type: 'integer' },
        },
      },
      call: async (args) =>
        await (await queue()).pending({
          ...(typeof args.kind === 'string' ? { kind: args.kind as WorkKind } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(typeof args.priority_min === 'number' ? { priority_min: args.priority_min } : {}),
        }),
    },
    {
      name: 'prism_work_claim',
      description: '认领一条待办（签发 attempt token 防重复；同一任务不会被两个宿主认领）',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          claimed_by: { type: 'string', description: '认领者标识（会话/agent 名）' },
        },
        required: ['id', 'claimed_by'],
      },
      call: async (args) => {
        const id = asString(args.id)
        const by = asString(args.claimed_by)
        if (id === undefined || by === undefined) throw new Error('prism_work_claim 需要 { id, claimed_by }')
        return await (await queue()).claim(id, by)
      },
    },
    {
      name: 'prism_work_complete',
      description:
        '回填工作结果（带 token 校验 + 按 kind 的 schema 校验；校验失败置 failed 并附原因）',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          attempt_token: { type: 'string' },
          result: { description: '结果对象（结构随 kind 而定，见 work-queue.md §5）' },
          by: { type: 'string' },
        },
        required: ['id', 'attempt_token', 'result'],
      },
      call: async (args) => {
        const id = asString(args.id)
        const token = asString(args.attempt_token)
        if (id === undefined || token === undefined) {
          throw new Error('prism_work_complete 需要 { id, attempt_token, result }')
        }
        const by = asString(args.by)
        return await (await queue()).complete({
          id,
          attempt_token: token,
          result: args.result,
          ...(by !== undefined ? { by } : {}),
        })
      },
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

/** stdio 传输：逐行读 JSON-RPC，逐行写响应（启动 MCP：`node dist/mcp/server.js`）。 */
export function runMcpStdio(options: { home?: string; zcodeDir?: string } = {}): void {
  const home = options.home ?? prismHome()
  const tools = createMcpTools({ home, zcodeDir: options.zcodeDir })
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
