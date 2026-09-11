/**
 * F-C4：`POST /api/arch/from-team`（团队工作流 → archify workflow IR）与**真实渲染器**门禁。
 *
 * 这里能调到 `validateDiagram` / `renderDiagram`（server 侧封装），所以
 * 「真实调 vendored archify `validate` 必须 ok + 渲染出自包含 HTML」这条验收放在本文件；
 * 纯函数侧的判据（确定性/幂等/slug 化/col 范围）在 `packages/agents/test/workflow-ir.test.ts`。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildTeamWorkflowIr, parseTeamMarkdown } from '@prism/agents'
import { afterEach, describe, expect, it } from 'vitest'

import { CORE_DEV_TEAM_MD } from '../src/roles/index.js'
import { renderDiagram, validateDiagram } from '../src/graph/archify.js'
import { archRoutes } from '../src/http/routes/arch.js'
import type { RouteContext } from '../src/http/router.js'

const dirs: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * 造一个装了 `core-dev` 团队的受管目录布局，返回 { home, teamsDir, rolesDir }。
 *
 * **原样写出厂模板**（不 `fillTeamTemplate`）：`prism init` 就是这么播种的
 * （`cli/src/commands/init.ts:159-162` 直接 `writeFileSync(CORE_DEV_TEAM_MD)`），
 * 因此这里若换成填充变体，测的就不是真实形态——F-C4 首版正是这么漏掉了
 * 「`设计审核` 阶段的 output `design-review.md + .design_ok` 超出节点文字预算」
 * （e2e 20.13 实跑才暴露）。测试必须复刻生产的播种形态。
 */
async function makeHarness(): Promise<{ home: string; teamsDir: string; rolesDir: string }> {
  const root = await tempDir('prism-arch-from-team-')
  const home = join(root, 'home')
  const teamsDir = join(root, 'teams')
  const rolesDir = join(root, 'agents')
  await mkdir(home, { recursive: true })
  await mkdir(join(teamsDir, 'core-dev'), { recursive: true })
  await mkdir(rolesDir, { recursive: true })
  await writeFile(join(teamsDir, 'core-dev', 'AGENTS.md'), CORE_DEV_TEAM_MD, 'utf-8')
  return { home, teamsDir, rolesDir }
}

function fakeCtx(body: unknown): RouteContext {
  return {
    params: {},
    query: new URLSearchParams(),
    body: async () => body,
  } as unknown as RouteContext
}

describe('F-C4：真实 archify 门禁（团队工作流 IR）', () => {
  it('出厂 core-dev 团队（原样播种）生成的 IR → archify validate ok:true，且能渲染出自包含 HTML', async () => {
    const { teamsDir } = await makeHarness()
    const team = parseTeamMarkdown(await readFile(join(teamsDir, 'core-dev', 'AGENTS.md'), 'utf-8'))
    const ir = buildTeamWorkflowIr(team)

    const validation = await validateDiagram('workflow', ir)
    expect(
      validation.ok,
      `IR 未过 archify 校验: ${validation.problems.map((p) => p.message).join('; ')}`,
    ).toBe(true)
    expect(validation.problems).toHaveLength(0)

    const dir = await tempDir('prism-arch-from-team-html-')
    const out = join(dir, 'workflow.html')
    await renderDiagram('workflow', ir, out)
    expect(existsSync(out)).toBe(true)
    const html = await readFile(out, 'utf-8')
    expect(html.length).toBeGreaterThan(100_000)
    // 自包含：不应有外部 http(s) 资源引用
    expect(/src=["']https?:\/\//i.test(html)).toBe(false)
  }, 120_000)

  /**
   * 回归（F-C4 首版真实缺陷）：阶段 `output` 是**团队定义的自由文本**，可以远超节点能画的宽度。
   * archify 对「缩到 6px 仍放不下」的 sublabel 直接判非法（`workflow-compiler.mjs:2265-2273`），
   * 而**加宽节点不是出路**（实测会引发自动布线错位）。故 IR 侧必须收敛文本。
   */
  it('超长阶段名/产出物：IR 收敛到可画宽度，archify validate 仍 ok', async () => {
    const team = parseTeamMarkdown(
      CORE_DEV_TEAM_MD.replace('| 3 | 设计审核 |', '| 3 | 设计审核设计审核设计审核设计审核 |').replace(
        'design-review.md + .design_ok',
        'a-very-long-deliverable-name-that-would-never-fit-inside-a-node.md + another-equally-long-artifact.done',
      ),
    )
    const ir = buildTeamWorkflowIr(team)
    const validation = await validateDiagram('workflow', ir)
    expect(
      validation.ok,
      `IR 未过 archify 校验: ${validation.problems.map((p) => p.message).join('; ')}`,
    ).toBe(true)

    // 截断必须「可见」：超限的文本以省略号收尾，而不是被静默丢弃
    const longNode = ir.nodes.find((n) => (n.sublabel ?? '').includes('a-very-long'))
    expect(longNode?.sublabel?.endsWith('…')).toBe(true)
  }, 120_000)
})

describe('F-C4：POST /api/arch/from-team', () => {
  it('由 team_id 生成产物：HTML + IR 源 + sidecar 元数据齐备，preview 可指', async () => {
    const { home, teamsDir, rolesDir } = await makeHarness()
    const routes = archRoutes({ home, teamsDir, rolesDir })

    const envelope = (await routes.fromTeam(fakeCtx({ team_id: 'core-dev' }))) as {
      ok: boolean
      value: { type: string; team_id: string; name: string; preview: string; ir: string; meta: { ir_hash: string; title?: string } }
    }
    expect(envelope.ok).toBe(true)
    expect(envelope.value.type).toBe('workflow')
    expect(envelope.value.team_id).toBe('core-dev')
    expect(envelope.value.preview).toBe('/api/arch/preview/workflow/core-dev.html')

    const htmlPath = join(home, 'archify', 'workflow', 'core-dev.html')
    expect(existsSync(htmlPath)).toBe(true)
    expect(existsSync(join(home, 'archify', 'workflow', 'core-dev.ir.json'))).toBe(true)
    expect(existsSync(join(home, 'archify', 'workflow', 'core-dev.meta.json'))).toBe(true)
    expect(envelope.value.meta.title).toBe('核心研发团队 工作流')
  }, 120_000)

  it('IR 是纯函数派生物：重复生成字节一致（ir_hash 不变）', async () => {
    const { home, teamsDir, rolesDir } = await makeHarness()
    const routes = archRoutes({ home, teamsDir, rolesDir })

    const first = (await routes.fromTeam(fakeCtx({ team_id: 'core-dev' }))) as { value: { ir: string; meta: { ir_hash: string } } }
    const irText1 = await readFile(first.value.ir, 'utf-8')
    const second = (await routes.fromTeam(fakeCtx({ team_id: 'core-dev' }))) as { value: { ir: string; meta: { ir_hash: string } } }
    const irText2 = await readFile(second.value.ir, 'utf-8')

    expect(irText2).toBe(irText1)
    expect(second.value.meta.ir_hash).toBe(first.value.meta.ir_hash)
  }, 120_000)

  it('团队不存在 → not_found（不产出空图）', async () => {
    const { home, teamsDir, rolesDir } = await makeHarness()
    const routes = archRoutes({ home, teamsDir, rolesDir })
    await expect(routes.fromTeam(fakeCtx({ team_id: 'no-such-team' }))).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('缺 team_id → bad_request', async () => {
    const { home, teamsDir, rolesDir } = await makeHarness()
    const routes = archRoutes({ home, teamsDir, rolesDir })
    await expect(routes.fromTeam(fakeCtx({}))).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('产物可在已渲染清单里查到（与既有 /api/arch/diagrams 同源）', async () => {
    const { home, teamsDir, rolesDir } = await makeHarness()
    const routes = archRoutes({ home, teamsDir, rolesDir })
    await routes.fromTeam(fakeCtx({ team_id: 'core-dev', book: '研发规范' }))

    const listing = (await routes.diagrams(fakeCtx({}))) as {
      ok: boolean
      value: Array<{ type: string; name: string; book?: string; has_ir: boolean }>
    }
    const found = listing.value.find((a) => a.name === 'core-dev.html')
    expect(found).toBeDefined()
    expect(found?.type).toBe('workflow')
    expect(found?.book).toBe('研发规范')
    expect(found?.has_ir).toBe(true)
  }, 120_000)
})
