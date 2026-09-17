/**
 * CLI 版本号（**唯一来源**）。
 *
 * 单独成模块是为了打破循环依赖：`argv.ts` 依赖 `commands/init.ts`，而 init 的
 * CLI 全局注册步骤（`commands/init-cli.ts`）需要比对「当前版本」——
 * 若版本读取留在 argv.ts，就会形成 argv → init → argv 的环。
 *
 * 版本号本体仍是 `packages/cli/package.json`（本文件不复制版本号，只读取它）。
 */

let cachedVersion: string | null = null

/** CLI 版本（读自身 package.json；读不到回落 `0.0.0`）。 */
export async function cliVersion(): Promise<string> {
  if (cachedVersion !== null) {
    return cachedVersion
  }
  try {
    const { readFile } = await import('node:fs/promises')
    const pkgPath = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string }
    cachedVersion = pkg.version ?? '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}
