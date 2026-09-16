/**
 * 架构图产物**落盘路由**（v9 F1 / design-v9 §2）——生成面三入口
 * （MCP `prism_arch_generate` / HTTP `POST /api/arch/render` / CLI `arch from-*`）共用。
 *
 * 三口径（顺序即优先级）：
 * 1. **`out` 完全接管**：给了显式路径就跳过项目解析（也**不校验** project），产物与 sidecar 随 out 落；
 * 2. **项目派生**（architecture/sequence/dataflow，且调用方给了 `project`）→
 *    `<projectRoot>/.prism/arch/<type>/`。projectRoot 一律经 `ProjectRegistry` 解析：
 *    - 未注册 → `not_found`（**绝不接受任意路径**，沿用 `registry.get` 语义）；
 *    - 已注册但 root 不存在/非目录 → `project_root_missing`（渲染前 stat 校验，
 *      **绝不 mkdir 递归复活**已删/已挪的 root——`mkdir -p` 会把用户的删除操作静默撤销）；
 * 3. **非项目图**（workflow/lifecycle，或未给 project 的裸 render）→ `<PRISM_HOME>/archify/<type>/`（现状）。
 *
 * `.prism` 已在 kb 扫描忽略表（`kb/scan.ts` DEFAULT_IGNORE_DIRS），知识库侧无需再处理；
 * 代码图谱侧由 `buildGraphArgs` 的 `--exclude .prism` 挡住（graphify 的 `_SKIP_DIRS` 不含它）。
 *
 * ⚠ 与裁决 **D2**（「merge 产物不落项目根」）的关系：D2 只管 `graph/merge.ts` 的 **merge 护栏**；
 * arch 产物依 `graphify-out/` 先例**刻意**入项目根下的 `.prism/`，**不受 D2 约束**——
 * 后人不要拿 D2 当「arch 不该落项目」的反例。
 */

import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { PrismError } from '@prism/core'

import { ARCHIFY_DIAGRAM_TYPES, type ArchifyDiagramType } from './archify.js'
import { ProjectRegistry } from './registry.js'

/** 由**项目代码图谱**派生的图类型（各自有生成器，必须已注册且已建图）。 */
export const PROJECT_DIAGRAM_TYPES = ['architecture', 'sequence', 'dataflow'] as const
export type ProjectDiagramType = (typeof PROJECT_DIAGRAM_TYPES)[number]

export function isProjectDiagramType(type: string): type is ProjectDiagramType {
  return (PROJECT_DIAGRAM_TYPES as readonly string[]).includes(type)
}

/** 项目源产物目录：`<projectRoot>/.prism/arch/<type>/`。 */
export function projectArchDir(projectRoot: string, type: ArchifyDiagramType): string {
  return join(projectRoot, '.prism', 'arch', type)
}

/** 全局源产物目录：`<PRISM_HOME>/archify/<type>/`。 */
export function globalArchDir(home: string, type: ArchifyDiagramType): string {
  return join(home, 'archify', type)
}

/**
 * 产物名消毒（与 `arch.ts` 既有口径一致）：空白回落 fallback，其余越界字符换 `_`。
 * 名字会直接参与拼路径，故不允许 `/`、`..` 等穿越形状。
 */
export function sanitizeArtifactName(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return fallback
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/**
 * 已注册项目根的**存在性校验**（渲染前）。
 *
 * 只 stat、不创建：`mkdir -p <root>/.prism/arch/...` 会在 root 已被删/被挪时
 * **原地复活**一个空目录树，把用户的删除操作静默撤销（v9.1 B-1）。
 */
export async function assertProjectRoot(root: string, project: string): Promise<void> {
  let info
  try {
    info = await stat(root)
  } catch {
    throw new PrismError(
      'project_root_missing',
      `项目根不存在: ${root}（项目 ${project} 已注册但目录已被删除或移动；Prism 不重建该目录）`,
      { project, root },
    )
  }
  if (!info.isDirectory()) {
    throw new PrismError('project_root_missing', `项目根不是目录: ${root}（项目 ${project}）`, {
      project,
      root,
    })
  }
}

export interface ArchPlacementInput {
  /** 图类型（五类之一） */
  type: string
  /** PRISM_HOME */
  home: string
  /** 产物名（不含 `.html`）；调用方可用 `sanitizeArtifactName` 预处理 */
  name: string
  /** 项目名（project 派生类型时由调用方显式给出） */
  project?: string | undefined
  /** 显式产物路径：给了就完全接管（跳过项目解析） */
  out?: string | undefined
}

export interface ArchPlacement {
  /** HTML 产物绝对路径 */
  htmlPath: string
  /** 产物目录（调用方 mkdir 用；项目源下其祖先已被 stat 校验过，创建是安全的） */
  dir: string
  /** 命中的项目（项目源时） */
  project?: string
  /** 命中的项目根（项目源时） */
  root?: string
}

/**
 * 解析产物落点。抛错语义：
 * - `bad_request`：未知图类型（与 `arch.ts:assertType` 同集合）；
 * - `not_found`：project 未注册；
 * - `project_root_missing`：project 已注册但 root 不存在/非目录。
 */
export async function resolveArchPlacement(input: ArchPlacementInput): Promise<ArchPlacement> {
  if (!ARCHIFY_DIAGRAM_TYPES.includes(input.type as ArchifyDiagramType)) {
    throw new PrismError('bad_request', `非法图类型: ${input.type}`, {
      allowed: ARCHIFY_DIAGRAM_TYPES,
    })
  }
  const type = input.type as ArchifyDiagramType

  const out = input.out?.trim() ?? ''
  if (out !== '') {
    const htmlPath = resolve(out)
    return { htmlPath, dir: dirname(htmlPath) }
  }

  const project = input.project?.trim() ?? ''
  if (isProjectDiagramType(type) && project !== '') {
    // 唯一真相源：未注册拒绝 / root 校验都在这里，调用方不得自行拼 root
    const registry = new ProjectRegistry(input.home)
    const info = await registry.get(project)
    await assertProjectRoot(info.root, project)
    const dir = projectArchDir(info.root, type)
    return { htmlPath: join(dir, `${input.name}.html`), dir, project: info.project, root: info.root }
  }

  const dir = globalArchDir(input.home, type)
  return { htmlPath: join(dir, `${input.name}.html`), dir }
}
