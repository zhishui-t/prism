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
  skillsDir: string
  graphDir: string
  /**
   * **删除回收站根目录**（`<home>/trash/<kind>/<单元>/`）。删除的角色/团队/技能整单元落这里，
   * 支持 list/restore/purge。所有回收站路径一律经 `TrashStore`（`src/trash/`）拼装，
   * **不得在别处散落 `<home>/trash` 字符串**。
   */
  trashDir: string
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
    skillsDir: join(home, 'skills'),
    graphDir: join(home, 'graph'),
    trashDir: join(home, 'trash'),
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

/**
 * **运行标记**：标识「同一批进程」的隔离键，嵌入 `os.tmpdir()` 里 `prism-*` 临时条目名。
 *
 * 为什么不能只用 pid（v18 教训）：vitest 3 默认 `pool: 'forks'`，测试进程的 pid 是
 * **worker** 的、globalSetup 回收器 teardown 跑在**主**进程、CLI 子进程是第三种——
 * pid 匹配永不命中。改用环境变量传递：主进程注入一次，worker / 孙进程（spawn 默认
 * 继承 env）拿到**同一标记**。
 *
 * 非 vitest 场景（CLI / server 独立运行）没有注入方，回落 `p<本进程 pid>` 保底——
 * 进程隔离自然成立；`p` 前缀避免纯数字 pid 与目录名里 Date.now 之类的数字段撞车。
 */
export function tmpTag(): string {
  return process.env.PRISM_TMP_TAG || `p${process.pid}`
}

/**
 * tmpdir 里 `prism-<用途>-<tag>-` 形态的 mkdtemp 前缀（`-<tag>-` 两端连字符锚定，
 * 供 test/global-tmp-reaper.ts 按运行标记精确回收）。所有往 `os.tmpdir()` 落
 * `prism-*` 条目的创建点（产品 + 测试）一律经此拼前缀，**不得手写前缀字符串**。
 */
export function prismTmpPrefix(use: string): string {
  return `prism-${use}-${tmpTag()}-`
}
