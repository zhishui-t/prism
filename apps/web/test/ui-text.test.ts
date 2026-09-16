/**
 * `components/ui.tsx` 的**文本纯函数**（F8-1：角色原则块裸 `**`）。
 *
 * 为什么单独一个文件：`firstSentence` 此前只有「经由页面 DOM」的间接覆盖，而 F8-1 的判据是
 * 「截断 + 剥标记」这一对**纯文本变换**——放在这里才能直接钉住边界（成对 / 不成对 / 单星号 /
 * 句号截断后只剩前导标记的真实案例），不必为一条文本规则搭组件级渲染。
 * DOM 侧的消费行为（原则块里没有字面 `**`）由 `roles-hierarchy.test.ts` 锁。
 *
 * 环境：默认 node（不写环境 pragma，同 `skills-logic.test.ts` 的既有做法）——`ui.tsx` 在
 * node 下可导入（`i18n.ts` 的 `window` 访问已由 `typeof window === 'undefined'` 兜住）。
 */

import { describe, expect, it } from 'vitest'

import { firstSentence, stripStrongMarkers } from '../src/components/ui.tsx'

/** 缺陷原始素材（角色 frontend-dev.md 的原则段）：成对粗体，句号结尾。 */
const PAIRED = '**方向未定不动手，抛光不改方向。** 每个视觉决定都以设计系统为唯一真相，不另起一套。'

describe('F8-1 剥强强调标记：`**` 一律不进纯文本块', () => {
  it('成对标记**也剥**（原则块无粗体语义，只留文字）', () => {
    expect(stripStrongMarkers(PAIRED)).toBe(
      '方向未定不动手，抛光不改方向。 每个视觉决定都以设计系统为唯一真相，不另起一套。',
    )
  })

  it('不成对 / 只有前导的标记照样剥（缺陷的实际形状：闭合标记被截掉）', () => {
    expect(stripStrongMarkers('**方向未定不动手，抛光不改方向。')).toBe('方向未定不动手，抛光不改方向。')
    expect(stripStrongMarkers('前半句。**')).toBe('前半句。')
    expect(stripStrongMarkers('**')).toBe('')
  })

  it('连续三个及以上也吃（粗斜体同属标记），且剥完不留星号', () => {
    expect(stripStrongMarkers('***粗斜体***')).toBe('粗斜体')
    expect(stripStrongMarkers('****')).toBe('')
  })

  it('**单个** `*` 不动（同一字符在纯文本里可能是乘号 / 通配 / 脚注符）', () => {
    expect(stripStrongMarkers('a * b 与 2*3')).toBe('a * b 与 2*3')
    expect(stripStrongMarkers('*斜体单星*')).toBe('*斜体单星*')
  })

  it('无标记文本原样返回（恒等变换，不顺手改写正文）', () => {
    const plain = '先定边界再谈实现。第二句不该出现在卡面可见的两行里。'
    expect(stripStrongMarkers(plain)).toBe(plain)
    expect(stripStrongMarkers('')).toBe('')
  })
})

describe('F8-1 截断 × 剥标记：真实案例的顺序', () => {
  it('先剥后截：`firstSentence(strip(原则), 38)` 里没有字面标记', () => {
    const out = firstSentence(stripStrongMarkers(PAIRED), 38)
    expect(out).toBe('方向未定不动手，抛光不改方向。')
    expect(out).not.toContain('*')
  })

  it('只截不剥（旧行为）会留下**前导** `**`——本用例是上面那条的必要性自证', () => {
    // 反证：不剥的话，首个句号截断正是缺陷来源（前导 `**` 留下、闭合 `**` 丢失）
    expect(firstSentence(PAIRED, 38)).toBe('**方向未定不动手，抛光不改方向。')
  })

  it('剥完为空 ⇒ 原则块走缺省（只剩标记 = 没写原则，不显示一堆星号）', () => {
    expect(stripStrongMarkers('**').trim()).toBe('')
  })
})
