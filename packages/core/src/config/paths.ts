import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prism 本地状态根目录。所有持久化数据默认落在 ~/.prism 之下，
 * 全部可通过环境变量 PRISM_HOME 覆盖（便于测试隔离与多实例部署）。
 */
export const DEFAULT_PRISM_HOME = join(homedir(), '.prism')

/** 解析 Prism 主目录（环境变量优先）。 */
export function prismHome(): string {
  return process.env.PRISM_HOME ?? DEFAULT_PRISM_HOME
}

export interface PrismPaths {
  home: string
  stateDir: string
  auditDir: string
  knowledgeDir: string
  /**
   * **旧版 Prism 的团队源目录**（`<home>/teams`），**不是**受管团队位置。
   * 受管位置由激活适配器/prism.yaml 决定（默认 `<harnessRoot>/teams`）。
   * 本键只为 `team install` 的**一次性迁移回落**而保留：团队若仍住此处则搬到受管位置。
   * `prism init` **不建**该目录（新装用户无需它，预建只会与受管位置同名异位）。
   */
  teamsDir: string
  skillsDir: string
  graphDir: string
  /**
   * **harness 适配器插件目录**：第三方把打包好的适配器放这里，运行期自动注册
   * （无需改 Prism 代码/重新编译）。每个插件一个子目录，见 harness-plugins.ts。
   */
  harnessesDir: string
}

/** 解析全部子目录路径（均位于 home 之下，可整体迁移）。 */
export function prismPaths(home: string = prismHome()): PrismPaths {
  return {
    home,
    stateDir: join(home, 'state'),
    auditDir: join(home, 'audit'),
    knowledgeDir: join(home, 'knowledge'),
    teamsDir: join(home, 'teams'),
    skillsDir: join(home, 'skills'),
    graphDir: join(home, 'graph'),
    harnessesDir: join(home, 'harnesses'),
  }
}

/**
 * 定位**发行根目录**（含 `3rd/` 的那一层），供解析 vendored 三方件路径。
 *
 * 为什么不能写死相对层级：同一份代码有两种布局——
 * - 开发态：`packages/<pkg>/src|dist/…`（到根 4 层）
 * - 打包后：`node_modules/@prism/<pkg>/dist/…`（到根 **5** 层，多一层 `node_modules/@prism`）
 * 写死 `../../../../3rd` 会让发行版解析到 `node_modules/3rd`（实测：doctor 报
 * anydoc 缺失、graphify 回落 PATH、embedding 不可用）。
 *
 * 故**从模块位置向上查找**第一个含 `3rd/` 或 `packages/` 的目录（发行根特征）。
 * 找不到时回落调用方给的 fallback（保持可用性，不抛）。
 *
 * @param fromMetaUrl 调用方 `import.meta.url`
 * @param maxDepth    向上查找层数上限（默认 8，足够覆盖两种布局）
 */
export function repoRoot(fromMetaUrl: string, maxDepth = 8): string | null {
  let dir = fileURLToPath(new URL('.', fromMetaUrl))
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(dir, '3rd')) || existsSync(join(dir, 'packages'))) return dir
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}
