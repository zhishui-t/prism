import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startServer } from '../src/app.js'
import { BuildJobManager } from '../src/graph/jobs.js'
import { ProjectRegistry, inspectGraphStatus } from '../src/graph/registry.js'
import { isInside } from '../src/http/routes/studio.js'
import { makeTempDir, putFile } from './helpers.js'
import type { AppHandle } from '../src/app.js'

describe('BuildJobManager（异步建图 + build_in_progress）', () => {
  it('提交即返回 job_id，完成后 done', async () => {
    const manager = new BuildJobManager()
    const job = manager.submit('p', 'K:/p', 'K:/p', async (_p, _r, log) => {
      log('step1')
    })
    expect(job.status).toBe('running')
    const done = await manager.waitFor(job.job_id)
    expect(done.status).toBe('done')
    expect(done.log.join('\n')).toContain('step1')
  })

  it('执行体失败 → failed + error', async () => {
    const manager = new BuildJobManager()
    const job = manager.submit('p', 'K:/p', 'K:/p', async () => {
      throw new Error('graphify 爆了')
    })
    const failed = await manager.waitFor(job.job_id)
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('graphify 爆了')
  })

  it('同项目并发提交 → build_in_progress', async () => {
    const manager = new BuildJobManager()
    manager.submit('p', 'K:/p', 'K:/p', async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(() => manager.submit('p', 'K:/p', 'K:/p', async () => {})).toThrowError(
      expect.objectContaining({ code: 'build_in_progress' }),
    )
    // 其他项目不受影响
    const other = manager.submit('q', 'K:/q', 'K:/q', async () => {})
    expect(other.project).toBe('q')
  })

  it('未知 job → not_found', () => {
    const manager = new BuildJobManager()
    expect(() => manager.get('nope')).toThrowError(expect.objectContaining({ code: 'not_found' }))
  })
})

describe('ProjectRegistry（项目注册表，projects.json 持久化）', () => {
  let home: string

  beforeEach(async () => {
    home = await makeTempDir('prism-registry-')
  })

  it('register → list → get；未注册 → not_found', async () => {
    const registry = new ProjectRegistry(home)
    await expect(registry.get('ghost')).rejects.toMatchObject({ code: 'not_found' })
    await registry.register('proj', 'K:/work/proj')
    const list = await registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ project: 'proj', root: 'K:/work/proj' })
    expect(list[0].stale).toBe(true) // 无 graph.json → 陈旧
    expect((await registry.get('proj')).root).toBe('K:/work/proj')
  })

  it('重新实例化后仍可读（持久化）', async () => {
    const first = new ProjectRegistry(home)
    await first.register('proj', 'K:/p')
    await first.markBuilt('proj', '2026-09-09T00:00:00.000Z')
    const second = new ProjectRegistry(home)
    const info = await second.get('proj')
    expect(info.built_at).toBe('2026-09-09T00:00:00.000Z')
  })

  it('跨进程可见性：旧实例已 list 过，另一实例注册后旧实例立即可见（无缓存闩，返工单 B3）', async () => {
    const server = new ProjectRegistry(home)
    expect(await server.list()).toEqual([]) // serve 启动早期读了一次空注册表
    const cli = new ProjectRegistry(home) // CLI 进程（新实例）
    await cli.register('core', 'K:/repo/packages/core', '2026-09-09T01:00:00.000Z')
    const seen = await server.list() // serve 侧不重启即可见
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ project: 'core', root: 'K:/repo/packages/core' })
  })

  it('失效降级：产物缺失 → stale:true 保留条目；产物补建 → stale:false', async () => {
    const registry = new ProjectRegistry(home)
    const root = await makeTempDir('prism-reg-stale-')
    await registry.register('gone', root)
    expect((await registry.get('gone')).stale).toBe(true) // 无 graphify-out/graph.json
    const list = await registry.list()
    expect(list[0].stale).toBe(true) // 保留条目并标注，不隐藏

    await putFile(`${root}/graphify-out/graph.json`, '{}')
    expect((await registry.get('gone')).stale).toBe(false)
  })

  it('并发注册互不丢失（原子写 + 串行）', async () => {
    const registry = new ProjectRegistry(home)
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => registry.register(`p${i}`, `K:/p/${i}`)),
    )
    const names = (await registry.list()).map((p) => p.project)
    expect(names).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
  })

  it('注册表文件损坏 → 读取降级为空，get 报 not_found，不崩', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(`${home}/graph`, { recursive: true })
    await writeFile(`${home}/graph/projects.json`, '{半截 JSON', 'utf-8')
    const registry = new ProjectRegistry(home)
    expect(await registry.list()).toEqual([])
    await expect(registry.get('x')).rejects.toMatchObject({ code: 'not_found' })
    // 且下次注册能正常覆盖写回
    await registry.register('after', 'K:/after')
    expect((await registry.get('after')).root).toBe('K:/after')
  })
})

describe('studio 路径越界防护', () => {
  it('isInside 拒绝越界与不同根（真实调用前先 path.resolve 折叠 ..）', () => {
    const base = 'K:/proj/graphify-out'
    expect(isInside(base, 'K:/proj/graphify-out/index.html')).toBe(true)
    expect(isInside(base, 'K:/proj/graphify-out')).toBe(true)
    // '../secret.txt' 经 resolve 后逃出 base → 归一化为 'K:/proj/secret.txt' 必须拒绝
    expect(isInside(base, 'K:/proj/secret.txt')).toBe(false)
    expect(isInside(base, 'K:/other/index.html')).toBe(false)
  })

  it('目录默认页：graph.html 优先（Python 版 graphify 产物），兼容 index.html', async () => {
    const home = await makeTempDir('prism-studio-default-')
    const root = await makeTempDir('prism-studio-proj-')
    // 只放 graph.html（Python 版 graphify 产物形态）
    await putFile(join(root, 'graphify-out', 'graph.html'), '<html>graph</html>')
    const registry = new ProjectRegistry(home)
    await registry.register('demo', root)
    const app = await startServer({ home, kb: undefined as never, port: 0 })
    try {
      const base = `http://127.0.0.1:${app.port}`
      const res = await fetch(`${base}/studio/demo/`)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('graph')
      // 显式文件名也可取
      expect((await fetch(`${base}/studio/demo/graph.html`)).status).toBe(200)
      // 不存在的文件 → 404
      expect((await fetch(`${base}/studio/demo/nope.html`)).status).toBe(404)
    } finally {
      await app.close()
    }
  })
})

describe('inspectGraphStatus（陈旧检测）', () => {
  it('无图谱 → stale + note', async () => {
    const dir = await makeTempDir('prism-status-')
    const detail = await inspectGraphStatus('p', dir, null)
    expect(detail.graph_exists).toBe(false)
    expect(detail.stale).toBe(true)
  })

  it('manifest 可识别且文件未变 → 不陈旧', async () => {
    const dir = await makeTempDir('prism-status2-')
    await putFile(`${dir}/src/a.ts`, 'export const a = 1')
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update('export const a = 1').digest('hex')
    await putFile(`${dir}/graphify-out/manifest.json`, JSON.stringify({ files: { 'src/a.ts': hash } }))
    await putFile(`${dir}/graphify-out/graph.json`, '{}')
    const detail = await inspectGraphStatus('p', dir, null)
    expect(detail.stale).toBe(false)
    expect(detail.changed_files).toBe(0)
    expect(detail.total_files).toBe(1)
  })

  it('manifest 实测形态（顶层绝对路径 + mtime）→ 未变不陈旧，改动后陈旧', async () => {
    const dir = await makeTempDir('prism-status3-')
    const src = await putFile(`${dir}/src/index.ts`, 'export const hello = () => 1')
    await putFile(`${dir}/graphify-out/graph.json`, '{}')
    const { stat } = await import('node:fs/promises')
    const mtime = (await stat(src)).mtimeMs
    await putFile(
      `${dir}/graphify-out/manifest.json`,
      JSON.stringify({ [src.replace(/\\/g, '/')]: { mtime, hash: 'db028f0956531794c6cb49a6fb422771' } }),
    )
    const fresh = await inspectGraphStatus('p', dir, null)
    expect(fresh.stale).toBe(false)
    expect(fresh.changed_files).toBe(0)
    expect(fresh.total_files).toBe(1)

    // 改动源文件 → mtime 变化 → 陈旧
    await new Promise((r) => setTimeout(r, 1100))
    await putFile(src, 'export const hello = () => 2')
    const stale = await inspectGraphStatus('p', dir, null)
    expect(stale.stale).toBe(true)
    expect(stale.changed_files).toBe(1)
  })
})

describe('graph 路由（HTTP 层，注入假执行体）', () => {
  let app: AppHandle
  let base: string
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await makeTempDir('prism-graph-route-')
    app = await startServer({ home: await makeTempDir('prism-graph-home-'), port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterEach(async () => {
    await app.close()
  })

  it('build 未注册且无 root → not_found；带 root → job_id → done', async () => {
    let res = await fetch(`${base}/api/graph/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'ghost' }),
    })
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')

    // 注入假执行体重启（真实 runner 需要 graphify；这里直接用注入测试）
    await app.close()
    const jobs: string[] = []
    app = await startServer({
      home: await makeTempDir('prism-graph-home2-'),
      port: 0,
      buildRunner: async (_p, _r, log) => {
        log('fake-build')
        jobs.push('built')
      },
    })
    base = `http://127.0.0.1:${app.port}`
    res = await fetch(`${base}/api/graph/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', root: projectRoot }),
    })
    const submitBody = (await res.json()) as { ok: boolean; value: { job_id: string } }
    expect(submitBody.ok).toBe(true)
    expect(submitBody.value.job_id).not.toBe('')

    for (let i = 0; i < 50; i++) {
      const statusRes = await fetch(`${base}/api/graph/build/${submitBody.value.job_id}`)
      const status = (await statusRes.json()) as { value: { status: string; log: string[] } }
      if (status.value.status !== 'running') {
        expect(status.value.status).toBe('done')
        expect(status.value.log.join('\n')).toContain('fake-build')
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(jobs).toEqual(['built'])

    // projects 列表出现该项目
    const projects = await fetch(`${base}/api/graph/projects`)
    const list = (await projects.json()) as { value: Array<{ project: string }> }
    expect(list.value.map((p) => p.project)).toContain('demo')
  })

  it('GET /api/graph/status 未注册项目 → not_found', async () => {
    const res = await fetch(`${base}/api/graph/status?project=none`)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })
})
