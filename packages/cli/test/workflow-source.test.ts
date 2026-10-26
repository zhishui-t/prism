/**
 * `prism workflow` 命令测试（workflow-asset.md v1：只读三命令 + `--source` 覆盖）。
 * 红线 R5/R6：临时目录 + prism.yaml 显式目录，绝不写真实宿主。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

const ROLE_MD = `---
name: "dev-1"
description: "测试角色"
---
## 核心契约

测试。
`

const GOOD_MD = `---
workflow: good-flow
name: 好单元
level: role
binds:
  - dev-1
---
# 好单元

## 步骤表

| # | 步骤 | 承接 | skill | 输入 | 输出 | 完成判定 | 回流 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 干活 | dev-1 | — | in | out | done | — |
`

const BAD_MD = `---
workflow: bad-flow
name: 坏单元
level: role
binds:
  - no-such-role
---
# 坏单元（无步骤表 + binds 引用不存在角色）
`

describe('prism workflow（list / show / validate + --source）', () => {
  let tmp: string
  let home: string
  let ctx: CommandContext
  const out: string[] = []
  const err: string[] = []

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-cli-workflow-'))
    home = join(tmp, 'home')
    const rolesDir = join(home, 'roles')
    const workflowsDir = join(tmp, 'workflows')
    await mkdir(rolesDir, { recursive: true })
    await writeFile(join(rolesDir, 'dev-1.md'), ROLE_MD, 'utf-8')
    await mkdir(workflowsDir, { recursive: true })
    await writeFile(join(workflowsDir, 'good-flow.md'), GOOD_MD, 'utf-8')
    await writeFile(join(workflowsDir, 'bad-flow.md'), BAD_MD, 'utf-8')
    await writeFile(join(workflowsDir, 'README.md'), '# 说明文档（应被跳过）\n', 'utf-8')
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${rolesDir.replaceAll('\\', '/')}\nworkflows_dir: ${workflowsDir.replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    out.length = 0
    err.length = 0
    ctx = { ...defaultContext({ stdout: (l) => out.push(l), stderr: (l) => err.push(l) }), home }
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('list：README 跳过、binds/steps 摘要、issues 计数；--json 整体可解析', async () => {
    const code = await runCommand(ctx, ['workflow', 'list'])
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('good-flow')
    expect(out.join('\n')).toContain('bad-flow')
    expect(out.join('\n')).not.toContain('README')
    expect(out.join('\n')).toContain('共 2 个单元')

    out.length = 0
    const jsonCode = await runCommand({ ...ctx, json: true }, ['workflow', 'list'])
    expect(jsonCode).toBe(0)
    const parsed = JSON.parse(out.join('\n')) as { ok: boolean; value: Array<{ workflow: string }> }
    expect(parsed.ok).toBe(true)
    expect(parsed.value.map((w) => w.workflow)).toEqual(['bad-flow', 'good-flow'])
  })

  it('show：步骤表逐行 + 不存在 not_found', async () => {
    const code = await runCommand(ctx, ['workflow', 'show', 'good-flow'])
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('#1 干活 [dev-1]')

    const miss = await runCommand(ctx, ['workflow', 'show', 'no-such'])
    expect(miss).toBe(1)
    expect(err.join('\n')).toContain('not_found')
  })

  it('validate：好单元通过、坏单元失败（exit 1）；缺省 = 全库', async () => {
    const single = await runCommand(ctx, ['workflow', 'validate', 'good-flow'])
    expect(single).toBe(0)
    expect(out.join('\n')).toContain('校验工作流 good-flow: 通过')

    out.length = 0
    const bad = await runCommand(ctx, ['workflow', 'validate', 'bad-flow'])
    expect(bad).toBe(1)
    const text = out.join('\n')
    expect(text).toContain('workflow_binds_role_unknown')
    expect(text).toContain('workflow_steps_empty')

    out.length = 0
    const all = await runCommand(ctx, ['workflow', 'validate'])
    expect(all).toBe(1)
    expect(out.join('\n')).toContain('good-flow: 通过')
    expect(out.join('\n')).toContain('bad-flow: 失败')
  })

  it('--source 覆盖 workflows_dir（读命令同样生效）', async () => {
    const other = join(tmp, 'other-workflows')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'solo-flow.md'), GOOD_MD.replace('good-flow', 'solo-flow'), 'utf-8')
    const code = await runCommand(ctx, ['workflow', 'list', '--source', other])
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('solo-flow')
    expect(out.join('\n')).toContain('共 1 个单元')
  })
})
