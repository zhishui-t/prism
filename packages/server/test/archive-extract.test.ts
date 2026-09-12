/**
 * 归档解压 + 摊平（`scripts/archive.mjs`）回归测试。
 *
 * **缺陷背景（2026-09-12 macOS 首次实测）**：`flattenInto` 早先只拷 `entry.isFile()`，
 * 把上游预编译包里的 **dylib 版本链软链**全部丢掉。llama.cpp 官方 macos 包把真实文件名
 * 藏在版本号里（`libllama-common.0.4.0.dylib`），而二进制只认无版本名
 * （`@rpath/libllama-common.0.dylib`）→ 启动即：
 *
 *     dyld: Library not loaded: @rpath/libllama-common.0.dylib
 *     Abort trap: 6
 *
 * **Windows 的 zip 里没有软链**，所以这条只在 macOS / Linux 暴露——典型的
 * 「Windows 优先假设」漏出来（见 `doc/requirements/cross-platform.md`）。
 *
 * 归档用系统 `tar` 现造（不 vendor 二进制 fixture），解压走**真实代码路径**。
 *
 * ⚠ **在受控沙箱里可能整文件报红**（2026-09-12 实测）：某些执行环境会注入 `rm` 守卫
 * （如 `node-safe-delete-shim.cjs`），按 **turn 累计**删除条数计（>50 即要求确认并抛
 * `SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。本文件与 `extractArchive()` 都频繁 `rm`
 * 临时目录，于是「谁在第 50 条之后删，谁就红」——**与代码无关的假红**，
 * 而且同一套测试单跑本文件时恒过（前台运行不带该守卫时也恒过）。
 * 遇到时先看错误码，不要改断言。
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { extractArchive } from '../../../scripts/archive.mjs'

const IS_WINDOWS = process.platform === 'win32'

/** 本轮造出来的临时路径（afterEach 统一回收；前缀 `prism-` 交 global-tmp-reaper 兜底）。 */
let made: string[] = []

afterEach(() => {
  for (const p of made) {
    // 清理**尽力而为**：本用例断言的是解压结果，不是「临时目录被删掉」。
    // 某些执行环境会劫持 rm（如沙箱的安全删除守卫），那里删不动不该记为测试失败
    // ——否则会得到「5 个用例全红」这种与代码无关的假红。
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // 留给 test/global-tmp-reaper.ts 兜底
    }
  }
  made = []
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/**
 * 造一个「上游预编译包」形态的归档：顶层目录 + 二进制 + 版本化库（+ 无版本名软链）。
 *
 * 建软链在 Windows 需开发者模式/管理员权限，故 fixture 侧也按平台收紧；
 * 对应断言同样 `skipIf(IS_WINDOWS)`。
 */
function makeArchive(options: { binary?: boolean; symlink?: boolean } = {}): string {
  const withBinary = options.binary ?? true
  const withSymlink = options.symlink ?? !IS_WINDOWS
  const root = tmp('prism-archive-src-')
  const pkg = join(root, 'llama-b10883-bin-macos-x64')
  mkdirSync(pkg, { recursive: true })

  if (withBinary) {
    const bin = join(pkg, 'llama-server')
    writeFileSync(bin, '#!/bin/sh\necho ok\n', 'utf-8')
    chmodSync(bin, 0o755)
  }
  writeFileSync(join(pkg, 'libllama-common.0.4.0.dylib'), 'FAKE-DYLIB', 'utf-8')
  if (withSymlink) {
    symlinkSync('libllama-common.0.4.0.dylib', join(pkg, 'libllama-common.0.dylib'))
  }

  const tarPath = join(root, 'pkg.tar.gz')
  execFileSync('tar', ['-czf', tarPath, '-C', root, basename(pkg)])
  return tarPath
}

describe('archive 解压与摊平', () => {
  it('把二进制从上游顶层目录摊平到目标根（否则运行时「装了却检测不到」）', async () => {
    const tarPath = makeArchive()
    const dest = tmp('prism-archive-dest-')

    await extractArchive(tarPath, dest, 'llama-server')

    expect(existsSync(join(dest, 'llama-server'))).toBe(true)
    // 顶层目录不该被保留下来
    expect(existsSync(join(dest, 'llama-b10883-bin-macos-x64'))).toBe(false)
  })

  it.skipIf(IS_WINDOWS)('保留依赖库的版本链软链（丢了 dyld 会 abort）', async () => {
    const tarPath = makeArchive()
    const dest = tmp('prism-archive-dest-')

    await extractArchive(tarPath, dest, 'llama-server')

    const link = join(dest, 'libllama-common.0.dylib')
    expect(lstatSync(link).isSymbolicLink(), '无版本名的软链必须被保留').toBe(true)
    expect(readlinkSync(link)).toBe('libllama-common.0.4.0.dylib')
    // 软链可解析：摊平后相对目标仍落在同一目录
    expect(readFileSync(link, 'utf-8')).toBe('FAKE-DYLIB')
  })

  it.skipIf(IS_WINDOWS)('POSIX 上二进制带可执行位（丢了就 spawn 不了）', async () => {
    const tarPath = makeArchive()
    const dest = tmp('prism-archive-dest-')

    await extractArchive(tarPath, dest, 'llama-server')

    expect(lstatSync(join(dest, 'llama-server')).mode & 0o111).not.toBe(0)
  })

  it('归档里没有目标二进制时抛错，不静默成功', async () => {
    const tarPath = makeArchive({ binary: false })
    const dest = tmp('prism-archive-dest-')

    await expect(extractArchive(tarPath, dest, 'llama-server')).rejects.toThrow(/llama-server/)
  })

  it('清掉上次解压残留的 staging 目录（解压途中被杀会留下）', async () => {
    const tarPath = makeArchive()
    const dest = tmp('prism-archive-dest-')
    const stale = `${dest}.staging-deadbeef`
    mkdirSync(stale, { recursive: true })
    made.push(stale)

    await extractArchive(tarPath, dest, 'llama-server')

    expect(existsSync(stale)).toBe(false)
  })
})
