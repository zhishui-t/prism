import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createTmpReaper } from './global-tmp-reaper.js'

/**
 * tmp-reaper run 标记机制（v18 B-1）的行为锁定：
 *  - 正向对照：嵌本 run 标记的新增条目 → teardown 必清（防 reaper 变 no-op 的 R5 回归）；
 *  - 并行不误删：不同 PRISM_TMP_TAG 的子进程（外部进程的替身）在途目录 → teardown 不碰；
 *  - 复现闭环：v17 archify render 跨进程热删场景（子进程写 ir.json → 主 teardown 运行
 *    → 子进程读回）→ 修复后 0 ENOENT；
 *  - 防退化哨兵：新增>0 且回收==0 → WARN 可见（标记机制失效不静默）。
 *
 * 全部用 `createTmpReaper` 独立实例 + 沙箱 env：基线在本测试窗口内独立快照，
 * 不动全局 `process.env`，也不会把其他并行 worker 的在途目录误当「新增」回收。
 */

/** 测试自建的「外部」条目（非本实例标记，teardown 必须跳过），自行清理。 */
const manual: string[] = []

function mkForeign(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  manual.push(dir)
  return dir
}

afterEach(() => {
  while (manual.length > 0) {
    const dir = manual.pop()
    if (dir !== undefined && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe('global-tmp-reaper run 标记（v18 B-1）', () => {
  it('正向对照：嵌本 run 标记的新增条目 teardown 全清；基线外无标记条目跳过', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    const reaper = createTmpReaper(env)

    // baseline 之前的既有条目 → 无论如何不碰
    const preExisting = mkForeign('prism-reap-pre-')

    await reaper.setup()
    const tag = env.PRISM_TMP_TAG
    expect(tag).toMatch(/^r\d+-\d+$/)

    const mine = mkdtempSync(join(tmpdir(), `prism-reap-mine-${tag}-`))
    const foreign = mkForeign(`prism-reap-foreign-otherrun-`) // 建在 setup 之后 → 属「新增」但无本 run 标记

    await reaper.teardown()

    expect(existsSync(mine)).toBe(false) // 自己的确实清（SPEC-3）
    expect(existsSync(foreign)).toBe(true) // 无标记的新增保留（跨进程在途保护）
    expect(existsSync(preExisting)).toBe(true) // 基线条目绝不碰
  })

  it('并行不误删 + 复现闭环：不同 tag 子进程写 ir.json 存续期间主 teardown 运行 → 0 ENOENT、零残留', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    const reaper = createTmpReaper(env)
    await reaper.setup()
    const tag = env.PRISM_TMP_TAG

    // 协调目录：非本实例标记 → teardown 跳过，parent 测试结束自行清理
    const coord = mkForeign('prism-reap-coord-')
    const readyFile = join(coord, 'ready')
    const goFile = join(coord, 'go')

    // 子进程 = v17 事故里的「并行 archify render」替身：不同 PRISM_TMP_TAG、
    // 建 prism-archify-render-* 目录、写 ir.json、等放行、读回、自清
    const childScript = [
      "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');",
      'const dir=fs.mkdtempSync(path.join(os.tmpdir(),process.env.RP_PREFIX));',
      "fs.writeFileSync(path.join(dir,'ir.json'),'RENDER_IN_FLIGHT');",
      'fs.writeFileSync(process.env.RP_READY,dir);',
      'const deadline=Date.now()+15000;',
      'while(!fs.existsSync(process.env.RP_GO)){',
      '  if(Date.now()>deadline)process.exit(3);',
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);',
      '}',
      // 修复前：主进程 teardown 已把该目录当「本轮新增」删掉 → 这里 ENOENT（v17 事故）
      "if(fs.readFileSync(path.join(dir,'ir.json'),'utf8')!=='RENDER_IN_FLIGHT')process.exit(4);",
      'fs.rmSync(dir,{recursive:true,force:true});',
      "console.log('CHILD_DONE');",
    ].join('\n')
    const child = spawn(process.execPath, ['-e', childScript], {
      env: {
        ...process.env,
        PRISM_TMP_TAG: `r999999-${Date.now()}`, // 与主 run 不同的标记
        RP_PREFIX: 'prism-archify-render-child-',
        RP_READY: readyFile,
        RP_GO: goFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childStdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      childStdout += String(chunk)
    })

    try {
      // 等子进程建好目录并进入存续期
      const deadline = Date.now() + 10_000
      while (!existsSync(readyFile)) {
        if (Date.now() > deadline) throw new Error('子进程未在时限内就绪')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const childDir = readFileSync(readyFile, 'utf-8')
      expect(existsSync(childDir)).toBe(true)
      manual.push(childDir) // 兜底：子进程异常退出时也不留残留

      // 本进程同时建一个嵌标记目录（也验证 teardown 在子进程在场时照常自清）
      const mine = mkdtempSync(join(tmpdir(), `prism-reap-mine2-${tag}-`))
      manual.push(mine) // 兜底：断言失败路径上不留残留（teardown 已删则 afterEach 跳过）

      await reaper.teardown()

      expect(existsSync(mine)).toBe(false) // 本 run 标记的照常清
      expect(existsSync(childDir)).toBe(true) // 并行子进程的目录分毫不动（SPEC-4）

      writeFileSync(goFile, 'go')
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve(code ?? -1))
      })
      expect(exitCode).toBe(0) // 子进程读回 ir.json 成功 → 0 ENOENT（SPEC-5）
      expect(childStdout).toContain('CHILD_DONE')
      expect(existsSync(childDir)).toBe(false) // 子进程退出自清 → 零残留
    } finally {
      if (child.exitCode === null && !child.killed) child.kill()
    }
  })

  it('防退化哨兵：有新增但零回收（无标记环境）→ WARN 可见、跳过条目 DEBUG 可见', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    const reaper = createTmpReaper(env)
    await reaper.setup()
    delete env.PRISM_TMP_TAG // 模拟标记丢失（如 setup 未注入 / env 被清）：teardown 拿不到标记

    const orphan = mkForeign('prism-reap-orphan-') // 新增、但无任何标记

    const writes: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      await reaper.teardown()
    } finally {
      process.stderr.write = originalWrite
    }

    expect(existsSync(orphan)).toBe(true) // 无标记 → 不删（保护在途进程）
    expect(writes.join('')).toContain('哨兵') // 防退化哨兵 WARN（SPEC-2）
    expect(writes.join('')).toContain('DEBUG') // 跳过条目可见
  })
})
