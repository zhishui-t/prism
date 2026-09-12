/**
 * `scripts/archive.mjs` 的类型声明。
 *
 * 为什么要单独写：`packages/server/test/archive-extract.test.ts` 需要**直接 import 真实实现**
 * （而不是像 `embedding-models.test.ts` 那样只读脚本文本），否则测不到解压/摊平逻辑本身；
 * 而 `scripts/` 既不进发行包、也没有构建步骤，没有自动产出的 `.d.ts`。
 * TS 的 NodeNext 解析按 `.mjs` → `.d.mts` 配对，放在同目录即可被 import 到。
 */

/** 解压归档并把二进制所在目录**摊平**到 destDir 根（含软链与 POSIX 可执行位处理）。 */
export function extractArchive(
  archivePath: string,
  destDir: string,
  binaryName: string,
  log?: (message: string) => void,
): Promise<void>

/** zip 解压：Windows 用 Python `zipfile`，POSIX 用 `unzip`。 */
export function extractZip(zipPath: string, destDir: string): Promise<void>

/** 递归查找二进制（>4 层视为结构异常，返回 null）。 */
export function findBinary(dir: string, binaryName: string, depth?: number): Promise<string | null>

/** 把二进制所在目录的文件（含软链）整体搬到 destDir 根。 */
export function flattenInto(staging: string, destDir: string, binaryName: string): Promise<void>
