/**
 * v12 F3（W-4）**团队详情弹窗的宽度口径**：第三处同 token 断言（SPEC-2.4）。
 *
 * `styles-role-modal.test.ts` 已锁「角色详情」那一侧；本文件补的是同一件事的**第三处**：
 * 团队详情（W-4）与技能详情（W-5）必须落**同一个** `<Modal size="lg">` 档，
 * 而尺寸只能来自 `:root` 的 `--modal-w` —— 不得各写一个宽度。
 *
 * 与此同时守住三条不能动的既有口径（W-3 已钉死，这里做第三处回归）：
 *  - 基类 `.modal`（K12 确认框）保持 420px；
 *  - `.modal-md`（选取器档）保持 560px —— `styles-picker.test.ts` 是它的主锁；
 *  - `.modal.modal-lg` 的选择器**保持字面独立**（不与他档合并：`styles-role-modal.test.ts`
 *    按字面 `\n.modal.modal-lg {` 定位规则体）。
 *
 * 环境：默认 node（读文件断言，同 `styles-*.test.ts` 的既有做法）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const CSS = read('../src/styles.css')
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 某条规则的规则体（选择器按字面匹配、从**行首**起——否则会取到组选择器的规则体）。 */
function body(selector: string): string {
  const at = BARE.indexOf(`\n${selector} {`)
  expect(at, `styles.css 里找不到规则 ${selector}`).toBeGreaterThan(-1)
  const open = BARE.indexOf('{', at)
  return BARE.slice(open + 1, BARE.indexOf('}', open))
}

describe('SPEC-2.4 三处详情同 token：`--modal-w` 单点定义 + `.modal-lg` 单点消费', () => {
  it('`:root` 里 `--modal-w` 只有一个定义（`min(88vw, 72rem)`，随窗口变大、超宽封顶）', () => {
    // 前置：定义确实在 `:root`（不是就地写在某条组件规则里）
    const root = body(':root')
    expect(root).toContain('--modal-w: min(88vw, 72rem)')
    // 全表只许出现一次定义（多写一处就是「两处口径」的开始）
    expect(BARE.match(/--modal-w\s*:/g) ?? []).toHaveLength(1)
  })

  it('`.modal.modal-lg` 的宽度 = `var(--modal-w)`（团队详情正是走这一档）', () => {
    const lg = body('.modal.modal-lg')
    expect(lg).toContain('width: var(--modal-w)')
    // 不得回退成写死的像素值（那正是本轮要消掉的「第二处宽度口径」）
    expect(lg).not.toMatch(/width:\s*\d+px/)
  })

  it('另两档不受影响：基类 420px 确认框 / `.modal-md` 560px 选取器', () => {
    expect(body('.modal')).toContain('width: min(420px, calc(100vw - var(--s-6)))')
    expect(body('.modal.modal-md')).toContain('width: min(560px, calc(100vw - var(--s-6)))')
    // `.modal-md` 不吃 `--modal-w`（选取器档本轮不变宽）
    expect(body('.modal.modal-md')).not.toContain('--modal-w')
  })

  it('选择器不合并：`.modal.modal-lg` / `.modal.modal-md` 各自起行（字面定位断言的前提）', () => {
    expect(BARE).toContain('\n.modal.modal-lg {')
    expect(BARE).toContain('\n.modal.modal-md {')
    expect(BARE).not.toMatch(/\n\.modal\.modal-(lg|md),\s*\.modal\.modal-/)
  })
})

describe('W-4 接线：团队页的详情用 `<Modal size="lg">`，不会再自写宽度', () => {
  it('TeamsPage 里 `size="lg"` 与 `<Modal` 同时在场（容器换掉才算迁完）', () => {
    const src = read('../src/pages/teams/TeamsPage.tsx')
    expect(src).toContain('<Modal')
    expect(src).toContain('size="lg"')
  })
})
