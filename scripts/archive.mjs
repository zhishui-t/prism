#!/usr/bin/env node
/**
 * 归档解压 + **摊平**（setup-embedding.mjs 与后续安装脚本共用）。
 *
 * 为什么单独成模块、而不是留在安装脚本里：这三段逻辑（解压 / 递归定位二进制 / 摊平）
 * 是「装了却检测不到」这类问题的唯一来源，值得能被单独验证。
 *
 * 摊平的必要性：llama.cpp 的预编译包都带一层以包名命名的顶层目录
 * （Windows zip 与 macOS/Linux tar.gz 皆然），例如
 *   llama-b10883-bin-macos-arm64/llama-server
 * 直接解压到目标目录的话，运行时按 `<dest>/llama-server` 查找就永远找不到。
 *
 * 跨平台要点：
 * - zip：Windows 系统不带 `unzip` → 走 Python `zipfile`（解释器名用 `resolvePython` 解析）；
 *   macOS / Linux 用系统 `unzip`。
 * - tar.gz：三家都可用 `tar -xzf`（Windows 10+ 自带 bsdtar）。
 * - POSIX 解压后补 `chmod 0o755`：zip 与非 POSIX 的 tar 会丢掉可执行位，丢了就 spawn 不了（EACCES）。
 * - **软链必须保留**：macOS 预编译包用 dylib 版本链（`libllama-common.0.dylib →
 *   libllama-common.0.4.0.dylib`），只拷普通文件会让 dyld 找不到 `@rpath` 目标并 abort。
 *   Windows 的 zip 里没有软链，所以这条只在 macOS / Linux 暴露（见 `copyLink`）。
 */
import { chmod, copyFile, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { resolvePython } from './python.mjs'

const IS_WINDOWS = process.platform === 'win32'

/** 运行命令并等待结束，返回退出码（不抛错，交由调用方决定语义）。 */
async function spawnAndWait(command, args, options = {}) {
  return await new Promise((resolveCode) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('close', (code) => resolveCode(code ?? -1))
    child.on('error', () => resolveCode(-1))
  })
}

/**
 * 解压归档到 destDir，并把二进制所在目录的内容**摊平**到 destDir 根。
 *
 * @param archivePath 归档路径（按扩展名分流：`.zip` → zip，其余当 tar.gz）
 * @param destDir     目标目录（会被**先清空**，保证结果可重复）
 * @param binaryName  用于定位的二进制名（Windows 带 `.exe`）
 * @param log         日志回调（可选）
 */
export async function extractArchive(archivePath, destDir, binaryName, log = () => {}) {
  await pruneStaleStaging(destDir)
  const staging = `${destDir}.staging-${randomUUID().slice(0, 8)}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    log(`解压 ${archivePath}`)
    if (archivePath.endsWith('.zip')) {
      await extractZip(archivePath, staging)
    } else {
      const code = await spawnAndWait('tar', ['-xzf', archivePath, '-C', staging])
      if (code !== 0) throw new Error(`tar 解压失败（退出码 ${code}）: ${archivePath}`)
    }
    await flattenInto(staging, destDir, binaryName)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** zip 解压：Windows 用 Python zipfile（系统不带 unzip），POSIX 用 unzip。 */
export async function extractZip(zipPath, destDir) {
  if (!IS_WINDOWS) {
    const code = await spawnAndWait('unzip', ['-q', '-o', zipPath, '-d', destDir])
    if (code !== 0) throw new Error(`unzip 解压失败（退出码 ${code}）: ${zipPath}`)
    return
  }
  const python = resolvePython()
  const code = await spawnAndWait(python, [
    '-c',
    'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
    zipPath,
    destDir,
  ])
  if (code !== 0) throw new Error(`解压失败（需要 zipfile 可用的 Python，当前解释器: ${python}）`)
}

/** 递归找二进制（上游包层次不一，逐层找最稳；超过 4 层视为结构异常）。 */
export async function findBinary(dir, binaryName, depth = 0) {
  if (depth > 4) return null
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name === binaryName) return join(dir, entry.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const hit = await findBinary(join(dir, entry.name), binaryName, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

/**
 * 清理上次「解压途中被杀」残留的 staging 目录。
 *
 * `extractArchive` 的 `finally` 不保证执行：SIGINT/SIGKILL 下进程直接终止，
 * 曾实测留下 `bin.staging-52cb4600/` 与未删的归档（用户 Ctrl-C 解压过程即是此场景）。
 * 残留本身无害，但会越积越多，且让「上一次装到一半」难以与正常状态区分。
 */
async function pruneStaleStaging(destDir) {
  const parent = dirname(destDir)
  const prefix = `${basename(destDir)}.staging-`
  try {
    for (const entry of await readdir(parent)) {
      if (!entry.startsWith(prefix)) continue
      await rm(join(parent, entry), { recursive: true, force: true })
    }
  } catch {
    // 清理失败不影响本次解压
  }
}

/**
 * 复制软链（**macOS dylib 版本链靠它**）。
 *
 * 为什么单独处理：软链既不是 file 也不是 directory，`entry.isFile()` 对它返回 false
 * —— 早先只拷 `isFile()` 会把上游那 16 个 dylib 链接全部丢掉，于是 `llama-server`
 * 启动即 `dyld: Library not loaded: @rpath/libllama-common.0.dylib` + `Abort trap: 6`。
 * 上游包把真实文件名藏在版本号里（`libX.0.4.0.dylib`），二进制只认无版本名，无软链必崩。
 *
 * 优先重建软链（保持上游结构、不重复占空间）；无权限时回落为解引用硬拷——
 * 目标仍在同一目录，摊平后相对链接依然成立，dyld/dlopen 一样能解析。
 */
async function copyLink(src, dest) {
  const target = await readlink(src)
  try {
    await symlink(target, dest)
  } catch {
    // Windows 建软链需开发者模式/管理员权限；拿不到就退化为实体副本
    await copyFile(src, dest)
  }
}

/** 把二进制所在目录的文件整体搬到 destDir 根（同级依赖库 dll/dylib/so 一并带走）。 */
export async function flattenInto(staging, destDir, binaryName) {
  const found = await findBinary(staging, binaryName)
  if (found === null) {
    throw new Error(`解压后未找到 ${binaryName}（在 ${staging} 内递归查找无果）`)
  }
  const from = dirname(found)
  await rm(destDir, { recursive: true, force: true })
  await mkdir(destDir, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const dest = join(destDir, entry.name)
    if (entry.isSymbolicLink()) {
      await copyLink(join(from, entry.name), dest)
      continue
    }
    if (!entry.isFile()) continue
    await copyFile(join(from, entry.name), dest)
  }
  if (!IS_WINDOWS) {
    // zip 与非 POSIX 的 tar 会丢掉可执行位；丢了就 spawn 不了（EACCES）
    try {
      await chmod(join(destDir, binaryName), 0o755)
    } catch {
      // 无 POSIX 权限的文件系统（如某些挂载卷）忽略
    }
  }
}
