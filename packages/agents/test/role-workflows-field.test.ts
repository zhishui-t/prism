/**
 * 角色工作流挂载字段往返测试（workflow-asset.md §6）：parse（frontmatter / overlay 双回收）→
 * render（overlay 幂等注入）→ patch（双形态分流）。
 */
import { describe, expect, it } from 'vitest'

import { parseRoleMarkdown } from '../src/role/parse.js'
import { OVERLAY_WORKFLOWS_HEADING, renderZcodeRole } from '../src/role/render.js'
import { patchRoleRaw } from '../src/role/write.js'
import { validateRole } from '../src/role/validate.js'

const BASE = `---
name: "dev-1"
description: "测试角色"
---
## 核心契约

先让测试红，再让测试绿。
`

describe('role.workflows 双形态往返', () => {
  it('frontmatter 键形态：parse 回收 → render 不丢', () => {
    const raw = `---
name: "dev-1"
description: "d"
workflows:
  - dev-red-green
---
## 核心契约

c
`
    const role = parseRoleMarkdown(raw)
    expect(role.workflows).toEqual(['dev-red-green'])
    // frontmatter 已有键：render 不必写 frontmatter（扩展不进 ZCode 白名单），但 patch 落 frontmatter（见下）
  })

  it('正文 overlay 形态：parse 回收 → render 注入节 → 幂等', () => {
    const role = parseRoleMarkdown(`${BASE}\n${OVERLAY_WORKFLOWS_HEADING}\n\n- dev-red-green\n- sec-audit\n`)
    expect(role.workflows).toEqual(['dev-red-green', 'sec-audit'])
    const rendered = renderZcodeRole(role)
    expect(rendered).toContain(OVERLAY_WORKFLOWS_HEADING)
    // 幂等：再 parse → render 不重复注入
    expect(renderZcodeRole(parseRoleMarkdown(rendered)).match(new RegExp(OVERLAY_WORKFLOWS_HEADING.replace(/[/\\]/g, '\\$&'), 'g'))).toHaveLength(1)
  })

  it('patch：宿主原生形态（无键）→ 写正文 overlay；Prism 形态（有键）→ 写 frontmatter', () => {
    const patchedOverlay = patchRoleRaw(BASE, { workflows: ['dev-red-green'] })
    expect(patchedOverlay).toContain(OVERLAY_WORKFLOWS_HEADING)
    expect(patchedOverlay).toContain('- dev-red-green')
    expect(parseRoleMarkdown(patchedOverlay).workflows).toEqual(['dev-red-green'])

    const fmForm = `---
name: "dev-1"
description: "d"
workflows:
  - old-flow
---
## 核心契约

c
`
    const patchedFm = patchRoleRaw(fmForm, { workflows: ['new-flow'] })
    expect(patchedFm).toContain('workflows:')
    expect(patchedFm).toContain('- new-flow')
    expect(parseRoleMarkdown(patchedFm).workflows).toEqual(['new-flow'])
  })

  it('patch 空数组 = 清空（overlay 节移除，往返为 undefined）', () => {
    const withOverlay = patchRoleRaw(BASE, { workflows: ['x'] })
    const cleared = patchRoleRaw(withOverlay, { workflows: [] })
    expect(cleared).not.toContain('- x')
    expect(parseRoleMarkdown(cleared).workflows).toBeUndefined()
  })

  it('validateRole：workflow_unknown warning（提供 knownWorkflows 时）；未提供不校验', () => {
    const role = parseRoleMarkdown(patchRoleRaw(BASE, { workflows: ['ghost-flow'] }))
    const checked = validateRole(role, { knownWorkflows: ['dev-red-green'] })
    expect(checked.issues.some((i) => i.code === 'workflow_unknown' && i.message.includes('ghost-flow'))).toBe(true)
    const unchecked = validateRole(role)
    expect(unchecked.issues.some((i) => i.code === 'workflow_unknown')).toBe(false)
  })
})
