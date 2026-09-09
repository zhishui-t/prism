import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prismHome, openPersistence, WorkQueue, BUILTIN_VALIDATORS, WORK_KINDS, type PrismPersistence } from '@prism/core'

import { sendJson, toEnvelope, type Envelope } from './http/envelope.js'
import { Router } from './http/router.js'
import { healthRoute, type ServerMeta } from './http/routes/health.js'
import { kbRoutes } from './http/routes/kb.js'
import { defaultGraphifyRunner, graphRoutes, type GraphDeps } from './http/routes/graph.js'
import { studioRoute } from './http/routes/studio.js'
import { consoleRoute, resolveWebDistDir } from './http/routes/console.js'
import { taskRoutes } from './http/routes/tasks.js'
import { peopleRoutes } from './http/routes/people.js'
import { workRoutes } from './http/routes/work.js'
import { archRoutes } from './http/routes/arch.js'
import { BuildJobManager } from './graph/jobs.js'
import { ProjectRegistry } from './graph/registry.js'
import type { KbFactory, KnowledgeService } from './kb/port.js'
import { loadKnowledgeService } from './kb/wiring.js'

export interface AppOptions {
  /** PRISM_HOME 覆盖；默认 prismHome() */
  home?: string
  /** ZCode 宿主根目录（/api/teams/:id/activate 判装配状态）；默认 PRISM_ZCODE_DIR → ~/.zcode */
  zcodeDir?: string
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
  /** 注入工作队列（测试注入内存实例）；不传则按 home 打开持久化自建 */
  workQueue?: WorkQueue
}

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
  /** 关闭内部自建的工作队列持久化（注入实例由注入方负责） */
  closeWork: () => void
}> {
  const home = options.home ?? prismHome()
  const meta: ServerMeta = { version: await readVersion(), startedAt: Date.now(), home }

  let kbCache: KnowledgeService | undefined
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

  // 工作队列（拉取式，work-queue.md）：惰性打开一次，与 HTTP 进程同库（WAL 并发安全）
  let workQueue: WorkQueue | undefined = options.workQueue
  let workPersistence: PrismPersistence | undefined
  const getQueue = async (): Promise<WorkQueue> => {
    if (workQueue !== undefined) return workQueue
    workPersistence = openPersistence({ home })
    const queue = new WorkQueue({ persistence: workPersistence })
    for (const kind of WORK_KINDS) {
      queue.registerValidator(kind, BUILTIN_VALIDATORS[kind])
    }
    workQueue = queue
    return queue
  }

  const router = new Router()
  router.add('GET', '/api/health', healthRoute(meta))

  const kb = kbRoutes(loadKb)
  router.add('GET', '/api/kb/search', kb.search)
  router.add('GET', '/api/kb/get/:id', kb.get)
  router.add('GET', '/api/kb/tree', kb.tree)
  router.add('GET', '/api/kb/stats', kb.stats)
  router.add('GET', '/api/kb/catalog', kb.catalog)
  router.add('POST', '/api/kb/deposit', kb.deposit)
  router.add('GET', '/api/kb/graph', kb.graph)
  router.add('GET', '/api/kb/path', kb.path)
  router.add('POST', '/api/kb/export', kb.exportGraph)

  const graph = graphRoutes({
    registry,
    jobs,
    runner,
    graphifyEnv: options.graphifyEnv,
    graphifyTimeoutMs: options.graphifyTimeoutMs,
  })
  router.add('GET', '/api/graph/projects', graph.projects)
  router.add('POST', '/api/graph/build', graph.build)
  router.add('GET', '/api/graph/build/:job_id', graph.jobStatus)
  router.add('GET', '/api/graph/query', graph.query)
  router.add('GET', '/api/graph/path', graph.path)
  router.add('GET', '/api/graph/explain', graph.explain)
  router.add('GET', '/api/graph/affected', graph.affected)
  router.add('GET', '/api/graph/god-nodes', graph.godNodes)
  router.add('GET', '/api/graph/summary', graph.summary)
  router.add('POST', '/api/graph/export', graph.exportGraph)
  router.add('GET', '/api/graph/status', graph.status)

  router.add('GET', '/studio/:project/*', studioRoute(registry))
  router.add('GET', '/studio/:project', studioRoute(registry))

  // 架构图谱（Archify 封装，knowledge-base.md §4.4 / D10）
  const arch = archRoutes({ home })
  router.add('GET', '/api/arch/types', arch.types)
  router.add('GET', '/api/arch/diagrams', arch.diagrams)
  router.add('POST', '/api/arch/validate', arch.validate)
  router.add('POST', '/api/arch/render', arch.render)
  router.add('GET', '/api/arch/preview/:type/:file', arch.preview)

  const tasks = taskRoutes(home)
  router.add('GET', '/api/tasks', tasks.list)
  router.add('GET', '/api/tasks/stats', tasks.stats)
  router.add('POST', '/api/tasks/register', tasks.register)
  router.add('POST', '/api/tasks/report', tasks.report)
  router.add('GET', '/api/tasks/:id', tasks.get)
  router.add('GET', '/api/dags/:id', tasks.dag)

  // 工作队列（拉取式：宿主经 MCP/HTTP 认领执行 LLM 工作；Prism 不调 LLM）
  const work = workRoutes({ getQueue })
  router.add('GET', '/api/work/pending', work.pending)
  router.add('POST', '/api/work/claim', work.claim)
  router.add('POST', '/api/work/complete', work.complete)
  router.add('POST', '/api/work/fail', work.fail)
  router.add('POST', '/api/work/reclaim', work.reclaim)
  router.add('GET', '/api/work/stats', work.stats)

  // 角色 / 团队 / 技能（design-v3 §3.4 F11；只读 GET，数据源 <home>/roles|teams）
  const zcodeDir = options.zcodeDir ?? process.env['PRISM_ZCODE_DIR'] ?? join(homedir(), '.zcode')
  const people = peopleRoutes({ home, zcodeDir })
  router.add('GET', '/api/roles', people.roles)
  router.add('GET', '/api/roles/:name', people.role)
  router.add('GET', '/api/teams', people.teams)
  router.add('GET', '/api/teams/:id', people.team)
  router.add('GET', '/api/teams/:id/activate', people.teamActivate)
  router.add('GET', '/api/skills', people.skills)

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
    tasks.close()
  })

  return { server, loadKb, home, closeWork: () => workPersistence?.close() }
}

/** 启动 HTTP 服务（CLI `prism serve` 用）。 */
export async function startServer(options: AppOptions = {}): Promise<AppHandle> {
  const { server, loadKb, home, closeWork } = await createApp(options)
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
  return {
    home,
    port: actualPort,
    host,
    server,
    loadKb,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          closeWork?.()
          resolve()
        })
      }),
  }
}
