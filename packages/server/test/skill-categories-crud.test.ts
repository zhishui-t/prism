/**
 * 分类 CRUD **HTTP 面**（v12 F4 / SPEC-4.4 新建、SPEC-4.5 改名与删除、design-v12 F4「API」）。
 *
 * 三条路由 `POST|PATCH|DELETE /api/skills/categories[/:name]`：
 * - 实现单点是 `SkillCategoryStore`（B-1 落地），本文件只验**路由层**——body 取值、
 *   错误码→状态码映射（400/404/409）、响应形状 = `SkillCategoryData`（与 GET 同形）；
 * - **注册顺序**顺序按契约排在 `/api/skills/:name` 之前，且顺序回归在本文件与
 *   `skill-categorize-surface.test.ts` 两处都有行为断言（不只靠注释）。
 *
 * 与 `skill-categorize-surface.test.ts` 分工：那份管「读面 + categorize 写入」，
 * 本份管「分类本体（categories 清单）的增删改」。
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'

/** 落盘双节形态（本文件多处直接核对文件，验「响应 = 落地」）。 */
interface CategoryData {
  categories: string[]
  mapping: Record<string, string>
}

describe('分类 CRUD HTTP 面（v12 F4 / SPEC-4.4–4.5）', () => {
  let tmp: string
  let home: string
  let harnessRoot: string
  let app: AppHandle
  let base: string

  const send = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  /** `value` 断言为双节数据（失败信息里能看到原响应）。 */
  const dataOf = (body: Record<string, unknown>): CategoryData => body.value as CategoryData

  /** 当前全量双节（始终走 GET，不缓存——每次请求重读磁盘）。 */
  const current = async (): Promise<CategoryData> => {
    const { status, body } = await send('GET', '/api/skills/categories')
    expect(status).toBe(200)
    return dataOf(body)
  }

  /** 落盘原样读（不经 store 归一化，验写入形状）。 */
  const onDisk = async (): Promise<unknown> =>
    JSON.parse(await readFile(join(home, 'skill-categories.json'), 'utf-8')) as unknown

  const errorCode = (body: Record<string, unknown>): string =>
    (body.error as { code: string }).code

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-skillcat-crud-'))
    home = join(tmp, 'home')
    harnessRoot = join(tmp, 'zcode')
    await mkdir(home, { recursive: true })
    app = await startServer({ home, harnessRoot, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  describe('POST /api/skills/categories（新建）', () => {
    it('新建成功 → 200 + 双节（categories 增且保序，mapping 不动），落盘同形', async () => {
      const first = await send('POST', '/api/skills/categories', { name: '质量' })
      expect(first.status).toBe(200)
      // 空分类要存得住：只写 categories，不写 mapping
      expect(first.body).toEqual({ ok: true, value: { categories: ['质量'], mapping: {} } })

      const second = await send('POST', '/api/skills/categories', { name: '构建' })
      expect(second.status).toBe(200)
      // **保序**：追加末尾，不排序、不去重后重排
      expect(dataOf(second.body).categories).toEqual(['质量', '构建'])

      // 响应 = 落地（不是「先返回后写」的乐观值）
      expect(await current()).toEqual({ categories: ['质量', '构建'], mapping: {} })
      expect(await onDisk()).toEqual({ categories: ['质量', '构建'], mapping: {} })
    })

    it('名字 trim 后写入；与既有分类 trim 后重名 → 409 id_conflict', async () => {
      const padded = await send('POST', '/api/skills/categories', { name: '  测试  ' })
      expect(padded.status).toBe(200)
      expect(dataOf(padded.body).categories).toContain('测试')

      const dup = await send('POST', '/api/skills/categories', { name: ' 测试 ' })
      expect(dup.status).toBe(409)
      expect(errorCode(dup.body)).toBe('id_conflict')
    })

    it('空名 / 缺省 / 非字符串 → 400 bad_request（不静默成功）', async () => {
      for (const name of ['', '   ', undefined, null, 42, {}]) {
        const res = await send('POST', '/api/skills/categories', { name })
        expect(res.status, `name=${JSON.stringify(name)}`).toBe(400)
        expect(errorCode(res.body)).toBe('bad_request')
      }
      // 400 不落盘：上面的名字一个都没进 categories
      const data = await current()
      expect(data.categories).not.toContain('')
      expect(data.categories).toEqual(['质量', '构建', '测试'])
    })
  })

  describe('PATCH /api/skills/categories/:name（改名）', () => {
    it('改名成功 → 分类就地替换保序 + 级联 mapping（组内技能全改指新名）', async () => {
      await send('POST', '/api/skills/categories', { name: '旧名' })
      await send('POST', '/api/skills/categorize', { names: ['a-skill', 'b-skill'], category: '旧名' })

      const before = await current()
      expect(before.categories).toEqual(['质量', '构建', '测试', '旧名'])
      expect(before.mapping).toEqual({ 'a-skill': '旧名', 'b-skill': '旧名' })

      const renamed = await send('PATCH', '/api/skills/categories/旧名', { name: '新名' })
      expect(renamed.status).toBe(200)
      expect(renamed.body).toEqual({
        ok: true,
        value: {
          // 原位替换 → 仍在末尾，不因改名被挪到别处或重复登记
          categories: ['质量', '构建', '测试', '新名'],
          mapping: { 'a-skill': '新名', 'b-skill': '新名' },
        },
      })
      expect(await onDisk()).toEqual(dataOf(renamed.body))

      // 新名已是已登记分类：再 categorize 到它不会重复追加
      await send('POST', '/api/skills/categorize', { names: ['c-skill'], category: '新名' })
      expect((await current()).categories).toEqual(['质量', '构建', '测试', '新名'])
    })

    it('目标重名（另一个现存分类）→ 409 id_conflict；改名源不存在 → 404 not_found', async () => {
      const conflict = await send('PATCH', '/api/skills/categories/质量', { name: '构建' })
      expect(conflict.status).toBe(409)
      expect(errorCode(conflict.body)).toBe('id_conflict')
      // 409 不落盘：两个分类都还在
      expect((await current()).categories).toEqual(['质量', '构建', '测试', '新名'])

      const missing = await send('PATCH', '/api/skills/categories/不存在', { name: '随便' })
      expect(missing.status).toBe(404)
      expect(errorCode(missing.body)).toBe('not_found')
    })

    it('新名为空 → 400；旧名 === 新名 → 200 幂等 no-op（不算重名冲突）', async () => {
      for (const name of ['', '   ', undefined, null, 7]) {
        const res = await send('PATCH', '/api/skills/categories/质量', { name })
        expect(res.status, `name=${JSON.stringify(name)}`).toBe(400)
        expect(errorCode(res.body)).toBe('bad_request')
      }

      const same = await send('PATCH', '/api/skills/categories/质量', { name: '质量' })
      expect(same.status).toBe(200)
      expect(same.body).toEqual({ ok: true, value: await current() })
    })

    it('路径段经 URL 解码：中文分类名以编码形态可达（%XX）', async () => {
      const encoded = encodeURIComponent('新名')
      const res = await send('PATCH', `/api/skills/categories/${encoded}`, { name: '改后名' })
      expect(res.status).toBe(200)
      expect(dataOf(res.body).categories).toEqual(['质量', '构建', '测试', '改后名'])
      // 收尾：改回，保持后续用例的名字基线与本用例无关（各自用独立名）
      await send('PATCH', '/api/skills/categories/改后名', { name: '新名' })
    })
  })

  describe('DELETE /api/skills/categories/:name（删除）', () => {
    it('删除成功 → 分类消失 + 组内技能回未分类（mapping 条目清空，技能本身不受损）', async () => {
      await send('POST', '/api/skills/categories', { name: '待删' })
      await send('POST', '/api/skills/categorize', { names: ['prism', 'x-skill'], category: '待删' })
      expect((await current()).mapping).toEqual({ 'a-skill': '新名', 'b-skill': '新名', 'c-skill': '新名', prism: '待删', 'x-skill': '待删' })

      const removed = await send('DELETE', '/api/skills/categories/待删')
      expect(removed.status).toBe(200)
      const after = dataOf(removed.body)
      expect(after.categories).toEqual(['质量', '构建', '测试', '新名'])
      // 组内技能回未分类 = mapping 里**没有**这两个键（不是指向空串/其它分类）
      expect('prism' in after.mapping).toBe(false)
      expect('x-skill' in after.mapping).toBe(false)
      expect(await onDisk()).toEqual(after)

      // 消费面同步：GET /api/skills 的合并 `category` 键消失（不额外回写别的分类）
      const skills = await send('GET', '/api/skills')
      const prism = (skills.body.value as { skills: Array<{ name: string; category?: string }> }).skills.find(
        (s) => s.name === 'prism',
      )
      expect(prism).toBeDefined()
      expect('category' in (prism as object)).toBe(false)
    })

    it('删除不存在的分类 → 404 not_found（不静默成功）', async () => {
      const before = await current()
      const res = await send('DELETE', '/api/skills/categories/查无此分类')
      expect(res.status).toBe(404)
      expect(errorCode(res.body)).toBe('not_found')
      expect(await current()).toEqual(before)
    })

    it('空 / 空白路径名 → 400 bad_request（不经 store 的空名守卫）', async () => {
      // `%20` 解码后是纯空白 → store 的 trim 守卫兜住
      const res = await send('DELETE', '/api/skills/categories/%20')
      expect(res.status).toBe(400)
      expect(errorCode(res.body)).toBe('bad_request')
    })
  })

  /**
   * 注册顺序行为断言（design-v12 F4「API」：三条路由必须排在 `/api/skills/:name` **之前**）。
   *
   * 与 `skill-categorize-surface.test.ts` 的同类断言配套：那份锁 3 段 GET 不被吞，
   * 本份锁 4 段 PATCH/DELETE 与 3 段 POST 不被吞——断言的是**行为**（路由真的跑到了
   * 分类 handler），不是源码里的行号。
   */
  describe('注册顺序（不被 /api/skills/:name 捕获）', () => {
    it('3 段 POST /api/skills/categories 不被 GET 的 :name 顶掉（否则 405）', async () => {
      const res = await send('POST', '/api/skills/categories', { name: '顺序验证' })
      expect(res.status).toBe(200)
      expect(dataOf(res.body).categories).toContain('顺序验证')
      await send('DELETE', '/api/skills/categories/顺序验证')
    })

    it('4 段 PATCH /api/skills/categories/:name 落到改名 handler（不是 405/404）', async () => {
      await send('POST', '/api/skills/categories', { name: '顺序A' })
      const res = await send('PATCH', '/api/skills/categories/顺序A', { name: '顺序B' })
      expect(res.status).toBe(200)
      expect(dataOf(res.body).categories).toContain('顺序B')
      // 错误码也不是 `not_found`「未知 Skill: 顺序A」——那是被 :name 吞掉的表征
      const cleaned = await send('DELETE', '/api/skills/categories/顺序B')
      expect(cleaned.status).toBe(200)
      expect(dataOf(cleaned.body).categories).not.toContain('顺序B')
    })

    it('单技能详情仍然可达；未知名字仍是 404（:name 路由没被顶掉）', async () => {
      const detail = await send('GET', '/api/skills/prism')
      expect(detail.status).toBe(200)
      expect((detail.body.value as { name: string }).name).toBe('prism')

      const ghost = await send('GET', '/api/skills/no-such-skill')
      expect(ghost.status).toBe(404)
      expect(errorCode(ghost.body)).toBe('not_found')
    })

    it('边界：PATCH /api/skills/categories（3 段、无 :name）未注册 → 405（只走 GET 的 :name 不匹配）', async () => {
      const res = await send('PATCH', '/api/skills/categories')
      expect(res.status).toBe(405)
    })
  })
})
