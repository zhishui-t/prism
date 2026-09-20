import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'

import { prismHome } from '@prism/core'
import { ensureHarnessPluginsLoaded } from '@prism/agents'

import { sendJson, toEnvelope, type Envelope } from './http/envelope.js'
import { Router } from './http/router.js'
import { healthRoute, type ServerMeta } from './http/routes/health.js'
import { kbRoutes } from './http/routes/kb.js'
import { defaultGraphifyRunner, graphRoutes, type GraphDeps } from './http/routes/graph.js'
import { studioRoute } from './http/routes/studio.js'
import { consoleRoute, resolveWebDistDir } from './http/routes/console.js'
import { peopleRoutes } from './http/routes/people.js'
import { resolveDirsFromHome } from './roles/index.js'
import { archRoutes } from './http/routes/arch.js'
import { trashStoreFor } from './trash.js'
import { BuildJobManager } from './graph/jobs.js'
import { ProjectRegistry, inspectGraphStatus } from './graph/registry.js'
import type { KbFactory, KnowledgeService } from './kb/port.js'
import { ensureEmbeddingServer, ensureRerankServer } from './kb/embedding.js'
import { loadKnowledgeService } from './kb/wiring.js'

export interface AppOptions {
  /** PRISM_HOME 覆盖；默认 prismHome() */
  home?: string
  /** 宿主根目录（/api/teams/:id/activate 判装配状态）；缺省取**配置激活的适配器**默认根，PRISM_HARNESS_ROOT 可覆盖 */
  harnessRoot?: string
  /** 监听端口；默认 7777 */
  port?: number
  /** 监听地址；默认 127.0.0.1（仅本机，不暴露局域网） */
  host?: string
  /** 控制台 dist 目录覆盖；缺省按 PRISM_WEB_DIST → <repo>/apps/web/dist 解析（返工单 F03） */
  webDist?: string
  /** 注入知识服务（测试/自定义）；不传则运行时经 @prism/knowledge 装载 */
  kb?: KnowledgeService
  /** 注入惰性知识服务工厂 */
  kbFactory?: KbFactory
  /** 注入建图执行体（测试注入假 graphify） */
  buildRunner?: GraphDeps['runner']
  graphifyEnv?: NodeJS.ProcessEnv
  graphifyTimeoutMs?: number
  /**
   * **回收站到期自动清除**（v9 F3 / C-8）：`true` 时启动即 `sweep()` 一次，此后每小时
   * `purge(resolveTrashRetentionDays())`（定时器 `unref`，`server.close` 时清除）。
   *
   * 默认 **`false`**——测试与一次性调用不得凭空留下定时器（累积会拖住进程退出）。
   * 只有常驻的 `prism serve` 打开它；纯 CLI 部署靠 `prism trash purge` 手动兜底（I-4）。
   */
  trashSweep?: boolean
  /**
   * **启动时异步预热本地模型实例**（v14 检视批队长裁决①）：`true` 时 listen 后
   * fire-and-forget 拉起 embedding 与 rerank 两个 llama-server——常驻 serve 的
   * **首查不再付冷启动**（实测 GPU 档冷启 9.7s > rerank timeoutMs 3s，不预热则
   * 「冷启后第一次检索」必静默降级 RRF）。
   *
   * 默认 **`false`**——测试与一次性调用不得凭空 spawn 438MB 的真实推理进程；
   * 只有真正的 serve 入口（前台 `prism serve` 与 `--ensure` 的 background.ts）打开。
   * 预热内部自判安装/开关（`PRISM_EMBEDDING|PRISM_RERANK=off` → 零成本短路）。
   */
  warmupModels?: boolean
}

/** 回收站定时清除周期（每小时；与 `prism serve` 同生共死）。 */
const TRASH_SWEEP_INTERVAL_MS = 3_600_000

export interface AppHandle {
  home: string
  port: number
  host: string
  server: Server
  /** 供测试：拿到真实路由器的知识服务加载器 */
  loadKb: () => Promise<KnowledgeService>
  close: () => Promise<void>
}

const DEFAULT_PORT = 7777
async function readVersion(): Promise<string> {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 组装 HTTP 应用（路由表 + 依赖注入），返回未监听的 http.Server。 */
export async function createApp(options: AppOptions = {}): Promise<{
  server: Server
  loadKb: () => Promise<KnowledgeService>
  home: string
}> {
  const home = options.home ?? prismHome()
  const meta: ServerMeta = { version: await readVersion(), startedAt: Date.now(), home }

  // 真实知识服务（`createKnowledgeService`）带 `close()`；契约 `KnowledgeService` 未声明，
  // 故在本地就地扩一个可选方法——不改冻结契约。
  let kbCache: (KnowledgeService & { close?: () => void }) | undefined
  const loadKb = async (): Promise<KnowledgeService> => {
    if (options.kb !== undefined) {
      return options.kb
    }
    if (kbCache === undefined) {
      kbCache = await (options.kbFactory ?? (() => loadKnowledgeService(home)))()
    }
    return kbCache
  }

  const registry = new ProjectRegistry(home)
  const jobs = new BuildJobManager()
  const runner =
    options.buildRunner ??
    defaultGraphifyRunner({ env: options.graphifyEnv, timeoutMs: options.graphifyTimeoutMs })

  const router = new Router()
  router.add('GET', '/api/health', healthRoute(meta))

  // 目录解析一次：未显式指定根 → 用激活适配器的默认根（支持插件 harness）。
  const dirs = resolveDirsFromHome(home, {
    ...(options.harnessRoot !== undefined ? { harnessRoot: options.harnessRoot, rootExplicit: true } : {}),
  })
  const kb = kbRoutes(loadKb, home, dirs.rolesDir, dirs.teamsDir)
  router.add('GET', '/api/kb/search', kb.search)
  router.add('GET', '/api/kb/get/:id', kb.get)
  router.add('GET', '/api/kb/tree', kb.tree)
  router.add('GET', '/api/kb/stats', kb.stats)
  router.add('GET', '/api/kb/catalog', kb.catalog)
  router.add('POST', '/api/kb/deposit', kb.deposit)
  router.add('GET', '/api/kb/graph', kb.graph)
  router.add('GET', '/api/kb/path', kb.path)
  router.add('POST', '/api/kb/export', kb.exportGraph)
  router.add('POST', '/api/kb/entry/:id/remove', kb.remove)
  router.add('POST', '/api/kb/entry/:id/restore', kb.restore)
  router.add('GET', '/api/kb/conflicts', kb.conflicts)
  router.add('POST', '/api/kb/conflicts/:id/resolve', kb.resolveConflict)
  router.add('GET', '/api/kb/scan-history', kb.scanHistory)
  router.add('GET', '/api/kb/context-pack', kb.contextPack)
  router.add('GET', '/api/kb/versions/:id', kb.versions)
  // 书结构（F-A1/F-A2，design-v4 §3.4）：只读写 knowledgeDir（R5/R6：不接目录参数）
  router.add('GET', '/api/kb/book-structure', kb.bookStructure)
  router.add('POST', '/api/kb/book-structure', kb.bookStructureAction)

  const graph = graphRoutes({
    registry,
    jobs,
    runner,
    home,
    graphifyEnv: options.graphifyEnv,
    graphifyTimeoutMs: options.graphifyTimeoutMs,
  })
  router.add('GET', '/api/graph/projects', graph.projects)
  router.add('POST', '/api/graph/build', graph.build)
  router.add('GET', '/api/graph/build/:job_id', graph.jobStatus)
  router.add('POST', '/api/graph/merge', graph.merge)
  router.add('GET', '/api/graph/query', graph.query)
  router.add('GET', '/api/graph/path', graph.path)
  router.add('GET', '/api/graph/explain', graph.explain)
  router.add('GET', '/api/graph/affected', graph.affected)
  router.add('GET', '/api/graph/relations', graph.relations)
  router.add('GET', '/api/graph/god-nodes', graph.godNodes)
  router.add('GET', '/api/graph/summary', graph.summary)
  router.add('POST', '/api/graph/export', graph.exportGraph)
  router.add('GET', '/api/graph/rollup', graph.rollup)
  router.add('GET', '/api/graph/status', graph.status)

  router.add('GET', '/studio/:project/*', studioRoute(registry))
  router.add('GET', '/studio/:project', studioRoute(registry))

  // 架构图谱（Archify 封装，knowledge-base.md §4.4 / D10）
  const arch = archRoutes({ home, teamsDir: dirs.teamsDir, rolesDir: dirs.rolesDir })
  router.add('GET', '/api/arch/types', arch.types)
  router.add('GET', '/api/arch/diagrams', arch.diagrams)
  router.add('POST', '/api/arch/validate', arch.validate)
  router.add('POST', '/api/arch/render', arch.render)
  router.add('POST', '/api/arch/from-team', arch.fromTeam)
  router.add('GET', '/api/arch/ir/:type/:file', arch.ir)
  router.add('GET', '/api/arch/preview/:type/:file', arch.preview)

  // 角色 / 团队 / 技能（design-v3 §3.4 F11：数据源由激活适配器推导）
  // 只读 GET + 唯一的写路由 POST /api/teams（F-C3：只写 body 显式 teams_dir）
  const people = peopleRoutes({
    home,
    harnessRoot: dirs.harnessRoot,
    // F-C3：团队启用带的图谱状态——**只读、快分支**（不全量哈希），缺省绝不建图（R1）
    graphStatus: async (project) => {
      const projects = await registry.list()
      const found = projects.find((p) => p.project === project)
      if (found === undefined) return null
      return await inspectGraphStatus(found.project, found.root, found.built_at, { quick: true })
    },
    // F-C3：只有显式 ?build=1 才走到这里
    requestGraphBuild: async (project) => {
      const target = await registry.get(project)
      const job = jobs.submit(project, target.root, target.root, runner, {})
      return { job_id: job.job_id }
    },
  })
  // 角色/团队：读路由只读；写路由只认请求体里**显式**给出的 roles_dir / teams_dir
  // （绝不复用 dirs 的默认宿主目录）。增删改三入口在 CLI / HTTP / MCP 上对称。
  router.add('GET', '/api/roles', people.roles)
  router.add('POST', '/api/roles', people.createRole)
  router.add('GET', '/api/roles/:name', people.role)
  router.add('PATCH', '/api/roles/:name', people.updateRole)
  router.add('DELETE', '/api/roles/:name', people.deleteRole)
  router.add('GET', '/api/teams', people.teams)
  router.add('POST', '/api/teams', people.createTeam)
  router.add('GET', '/api/teams/:id', people.team)
  router.add('PATCH', '/api/teams/:id', people.updateTeam)
  router.add('DELETE', '/api/teams/:id', people.deleteTeam)
  router.add('GET', '/api/teams/:id/activate', people.teamActivate)
  router.add('GET', '/api/skills', people.skills)
  router.add('GET', '/api/skills/usage', people.skillUsage)
  router.add('GET', '/api/skills/effective', people.skillsEffective)
  // v8 F7（design-v8 §3）：技能分类映射——**必须在 `/api/skills/:name` 之前**注册，
  // 否则被 `:name` 吞掉（路由器首个匹配即命中；people.ts 有同款顺序注释）。
  router.add('GET', '/api/skills/categories', people.skillCategories)
  router.add('POST', '/api/skills/categorize', people.skillCategorize)
  // v12 F4（design-v12 F4「API」/ SPEC-4.4–4.5）：分类 CRUD 三条。**同样必须在
  // `/api/skills/:name` 之前**注册，且与上面的 GET 凑成 `categories` 家族四条
  // （GET/POST/PATCH/DELETE）**聚在一处**，避免后人插空破坏顺序
  // （people.ts 有同款顺序注释）。
  // ⚠ `PATCH`/`DELETE` 是 4 段（`categories/:name`），与 3 段的 `GET /api/skills/:name`
  // 按段数本已不冲突；仍按契约前置——顺序是文档化的约定，不靠「恰好段数不同」兜底。
  router.add('POST', '/api/skills/categories', people.skillCategoryCreate)
  router.add('PATCH', '/api/skills/categories/:name', people.skillCategoryRename)
  router.add('DELETE', '/api/skills/categories/:name', people.skillCategoryDelete)
  // 单技能详情必须注册在 usage/effective/categories/categorize **之后**
  // （路由器首个匹配即命中，:name 会吞掉它们）
  router.add('GET', '/api/skills/:name', people.skill)
  router.add('POST', '/api/skills/install', people.skillInstall)
  router.add('POST', '/api/skills/uninstall', people.skillUninstall)
  // v10 F3：外部技能（人写、无 Prism marker）删除——整目录进回收站。
  // 段数 4 且是 DELETE，与上面 `GET /api/skills/:name`（段数 3）无顺序耦合；
  // 仍排在 `GET /*` 兜底之前（兜底只接 GET，这里显式留位以免后人误挪）。
  router.add('DELETE', '/api/skills/external/:name', people.skillExternalDelete)

  // 回收站（v9 F3 §3）：只读列表；响应 snake_case 冻结（people.ts 显式映射）。
  // 不带 `:param`，与上面的 `/api/skills*` 无顺序耦合；仍须排在 `GET /*` 兜底之前。
  router.add('GET', '/api/trash', people.trash)

  // 控制台静态兜底（GET /*）必须注册在最后：/api、/studio 优先，不劫持（返工单 F03）
  const webDist = options.webDist ?? resolveWebDistDir()
  router.add('GET', '/*', consoleRoute(webDist))

  const server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const handled = await router.handle(req, res, pathname)
      if (!handled && !res.headersSent) {
        const envelope: Envelope<never> = { ok: false, error: { code: 'not_found', message: `未知路由: ${pathname}` } }
        sendJson(res, 404, envelope)
      }
    })().catch((error: unknown) => {
      const envelope = toEnvelope(error)
      sendJson(res, 500, envelope)
    })
  })
  server.on('close', () => {
    // F-T1：知识服务持有的 SQLite 句柄必须随服务释放——否则 Windows 上
    // `<home>/state/*.db(-wal|-shm)` 仍被占用，临时目录删不掉、e2e 残留静默堆积
    // （实测：修前 `D:\tmp\prism-e2e-*` 已积累 97 个）。只关自己创建的那个实例，
    // 注入的 `options.kb`（测试内存桩）归调用方，不越权。
    kbCache?.close?.()
  })

  // 回收站到期自动清除（v9 F3 / C-8）：**仅在显式打开时**存在，故测试与一次性调用
  // 不会凭空多出一个定时器（默认关 = 零副作用）。定时器挂 server 生命周期：
  // `server.close`（`AppHandle.close()` 走它）即清除，`unref` 保证不挡进程退出。
  if (options.trashSweep === true) {
    const trash = trashStoreFor(home)
    await trash.sweep({ trigger: 'CLI' }).catch(() => [])
    const timer = setInterval(() => {
      // 自动清除失败不该打挂服务（审计/日志留给 sweep 自身）；吞掉即可，下一轮再来
      void trash.sweep({ trigger: 'CLI' }).catch(() => [])
    }, TRASH_SWEEP_INTERVAL_MS)
    timer.unref()
    server.on('close', () => clearInterval(timer))
  }

  return { server, loadKb, home }
}

/** 启动 HTTP 服务（CLI `prism serve` 用）。 */
export async function startServer(options: AppOptions = {}): Promise<AppHandle> {
  // 先加载 harness 插件：people 路由按激活适配器解析目录，须在 createApp 前就绪。
  await ensureHarnessPluginsLoaded(options.home).catch(() => undefined)
  const { server, loadKb, home } = await createApp(options)
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  // 模型预热（v14 检视批队长裁决①，见 AppOptions.warmupModels）：不 await——预热失败
  // 不影响服务可用（检索路径自会按需重试并降级），两实例互不阻塞。
  if (options.warmupModels === true) {
    void ensureEmbeddingServer().catch(() => undefined)
    void ensureRerankServer().catch(() => undefined)
  }
  return {
    home,
    port: actualPort,
    host,
    server,
    loadKb,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}
