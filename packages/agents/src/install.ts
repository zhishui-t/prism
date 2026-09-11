/**
 * 角色模板初始化（`prism role init`）。
 *
 * **2026-09-11 收口**：本文件原为「装配」实现（design-v3 §5 冲突策略：把角色/团队渲染后写入宿主目录，
 * 含 marker 冲突策略、`.prism-new` 对比、旧源目录迁移）。但「角色/团队直接住宿主目录」确立之后，
 * 这条路径不再成立——角色就住在宿主 agents 目录**本身**，不存在第二份副本可供「装配」。
 * 随 `prism team install` / `prism role import` / `prism role install` 三个命令一并移除的函数：
 * `installRoles`、`installTeamDefinitions`、`migrateTeams`（及其 marker 冲突策略辅助）。
 *
 * 现仅保留 `role init`：从模板生成一个合法的角色骨架文件到 `roles_dir`。
 * 安全：目标目录由参数传入，**绝不硬编码宿主根**；测试必须用临时目录。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROLE_TEMPLATE_NAME_PLACEHOLDER, ROLE_TEMPLATE_MD } from './templates.js'
import type { InstallResult } from './types.js'

/** 初始化失败（目标不可写/创建失败等）。 */
export class InstallError extends Error {
  readonly code = 'install_failed'
  readonly path?: string

  constructor(message: string, path?: string) {
    super(`install_failed: ${message}${path ? ` (${path})` : ''}`)
    this.name = 'InstallError'
    this.path = path
  }
}

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface InitRoleOptions {
  /** 新角色名（必须 kebab-case；ZCode 产物 = 文件名）。 */
  name: string
  /** 角色受管目录（resolveDirs().rolesDir；新模型下即宿主目录）。 */
  rolesDir: string
  /** 自定义模板（缺省用内置 ROLE_TEMPLATE_MD；`{{name}}` 会被替换）。 */
  template?: string
  /** 已存在时覆盖（缺省跳过，绝不覆盖人写文件）。 */
  force?: boolean
}

/**
 * `role init`：从模板新建角色文件到 roles_dir（角色直接住宿主目录模型）。
 * 已存在 → skipped（除非 force）；name 非 kebab-case → InstallError。
 */
export async function initRole(opts: InitRoleOptions): Promise<InstallResult> {
  const name = opts.name.trim()
  if (!KEBAB_CASE_RE.test(name)) {
    throw new InstallError(`角色名必须是 kebab-case：${opts.name}（用于文件名 ${name}.md）`)
  }
  ensureTargetDir(opts.rolesDir)
  const path = join(opts.rolesDir, `${name}.md`)
  if (existsSync(path) && opts.force !== true) {
    // init 语义：文件已存在即跳过（人写/已初始化都不动；--force 才覆盖）
    return { written: [], skipped: [{ path, reason: '角色文件已存在（--force 覆盖）' }] }
  }
  const content = (opts.template ?? ROLE_TEMPLATE_MD).replaceAll(ROLE_TEMPLATE_NAME_PLACEHOLDER, name)
  writeFile(path, content)
  return { written: [path], skipped: [] }
}

function ensureTargetDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new InstallError(`目标目录创建失败（不可写或被占用）：${err instanceof Error ? err.message : String(err)}`, dir)
  }
  if (!existsSync(dir)) {
    throw new InstallError('目标目录创建失败：路径不可用', dir)
  }
}

function writeFile(path: string, content: string): void {
  try {
    writeFileSync(path, content, 'utf8')
  } catch (err) {
    throw new InstallError(`目标文件不可写：${err instanceof Error ? err.message : String(err)}`, path)
  }
}
