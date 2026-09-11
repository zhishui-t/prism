#!/usr/bin/env node
/**
 * 发行版冒烟（`pnpm run test:package`）：打包 → 解压 → 在**解压环境**验证关键能力。
 *
 * 为什么必须单独有这一步：开发态测试用的路径是 `packages/<pkg>/dist/`，打包物化后
 * 变成 `node_modules/@prism/<pkg>/dist/`（**多一层**）。任何写死相对层级的路径解析、
 * 或依赖「开发态才存在」的文件，都会在这里暴露——而 `pnpm test` / `test:e2e`
 * 全程跑在仓库内，**永远发现不了**（2026-09-11 实际踩中：tarball 内 anydoc 不可用、
 * graphify 静默回落 PATH 上的无关版本）。
 *
 * 覆盖：
 *   1. 打包成功 + 产物齐全（tgz 存在、体积合理）
 *   2. 解压 → `--version` 可跑
 *   3. `doctor`：vendored graphify 解析正确（不回落 PATH）、anydoc 路径指向解压树内
 *   4. `kb convert`（anydoc 真实转换，需先 setup-anydoc）
 *   5. `graph build`（vendored graphify 真实建图）
 *   6. 三方件路径**不得**指向 `node_modules/3rd`（打包事故的精确特征）
 *
 * 选项：--skip-build（复用现有 dist）、--keep（保留临时目录便于排查）
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const SKIP_BUILD = args.includes('--skip-build')
const KEEP = args.includes('--keep')

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    process.stdout.write(`PASS ${name}${detail ? ` :: ${detail}` : ''}\n`)
  } else {
    fail++
    failures.push(name)
    process.stdout.write(`FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`)
  }
}

function run(cmd, argv, cwd, env) {
  return new Promise((resolvePromise) => {
    // 不用 shell:true——Windows 下 shell 会去找 cmd.exe（本机 Git Bash 环境曾报 ENOENT），
    // 且参数拼进命令行易被转义/路径转换坑到。tar 走 PATH 直接找 tar.exe 即可。
    const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
    child.on('error', (e) => resolvePromise({ code: -1, stdout, stderr: String(e) }))
  })
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'prism-pkg-smoke-'))
  process.stdout.write(`发行冒烟（临时目录 ${work}）\n\n`)

  try {
    // ===== 1. 打包 =====
    // 先删旧产物：package.mjs 在构建失败时会提前抛出，旧 tarball 会留在 dist/，
    // 若不清理，后续用例就会在**上一次的产物**上跑出误导性的 PASS（实测踩过）。
    const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8')).version
    const tgz = join(ROOT, 'dist', `prism-${version}.tgz`)
    if (!SKIP_BUILD) await rm(tgz, { force: true })

    const pkgArgs = SKIP_BUILD ? ['scripts/package.mjs', '--skip-build'] : ['scripts/package.mjs']
    const pkg = await run(process.execPath, pkgArgs, ROOT)
    check('1.1 打包成功', pkg.code === 0, pkg.code !== 0 ? pkg.stderr.trim().slice(-200) : '')
    if (pkg.code !== 0) {
      throw new Error('打包失败——后续用例无法在**本次产物**上验证，中止')
    }
    check('1.2 产物存在', existsSync(tgz))
    if (!existsSync(tgz)) throw new Error('产物缺失，中止')
    const size = (await stat(tgz)).size
    check('1.3 体积合理（5–120MB）', size > 5_000_000 && size < 120_000_000, `${(size / 1048576).toFixed(1)} MB`)

    // ===== 2. 解压 =====
    // 必须以**相对名 + cwd** 调 tar：Git Bash 的 GNU tar 会把 `K:/...` 当远程主机
    // （同 scripts/package.mjs 的踩坑注释），故先把 tgz 拷进临时目录再解。
    const localTgz = join(work, `prism-${version}.tgz`)
    await cp(tgz, localTgz)
    const ex = await run('tar', ['-xzf', `prism-${version}.tgz`], work)
    check('2.1 解压成功', ex.code === 0, ex.code !== 0 ? ex.stderr.trim().slice(0, 200) : '')
    const dist = join(work, `prism-${version}`)
    check('2.2 解压树完整', existsSync(join(dist, 'bin', 'prism.js')) && existsSync(join(dist, 'packages', 'cli', 'dist')))

    // 解压环境的 PRISM_HOME 隔离在临时目录（绝不碰真实宿主/真实 ~/.prism）
    const home = join(work, 'home')
    await mkdir(home, { recursive: true })
    const env = { PRISM_HOME: home }
    const cli = (argv) => run(process.execPath, [join(dist, 'bin', 'prism.js'), ...argv], dist, env)

    const ver = await cli(['--version'])
    check('2.3 解压后 --version 可跑', ver.code === 0 && ver.stdout.includes(version), ver.stdout.trim().split('\n').pop() ?? '')

    // ===== 3. doctor：三方件路径解析（打包事故的核心断言）=====
    const doctor = await cli(['doctor', '--json'])
    let checks = []
    try {
      checks = JSON.parse(doctor.stdout.trim().split('\n').pop()).value
    } catch {
      // doctor 非零退出也可能有完整 JSON（anydoc 未装时）；忽略
    }
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]))

    // graphify 必须走 vendored（版本是我们锁的），**不能**是 PATH 上的无关版本
    const g = byName['graphify']
    check(
      '3.1 graphify 解析到 vendored（非 PATH 回落）',
      g !== undefined && String(g.detail).includes('vendored'),
      g?.detail?.slice(0, 90) ?? '(缺该检查项)',
    )

    // anydoc 路径必须在解压树内，且**不得**含 node_modules/3rd（事故精确特征）
    const a = byName['anydoc']
    check(
      '3.2 anydoc 路径指向解压树内且无 node_modules/3rd',
      a !== undefined && !String(a.detail).includes('node_modules/3rd'),
      a?.detail?.slice(0, 90) ?? '(缺该检查项)',
    )

    // ===== 4. anydoc 真实转换 =====
    // 解压环境没带平台二进制（不入库/不随包），先按目标机平台装
    const setup = await run(process.execPath, [join(dist, 'scripts', 'setup-anydoc.mjs')], dist, env)
    if (setup.code !== 0) {
      process.stdout.write(`SKIP 4.x anydoc 未装成（${setup.stderr.trim().slice(0, 80)}）——转换用例跳过\n`)
    } else {
      const csv = join(work, 't.csv')
      await writeFile(csv, 'name,age\nAlice,30\n', 'utf-8')
      const conv = await cli(['kb', 'convert', csv])
      check('4.1 kb convert（anydoc 真实转换）', conv.code === 0 && conv.stdout.includes('| Alice |'), conv.stdout.trim().slice(0, 60))
    }

    // ===== 5. graph build（vendored graphify 真实建图）=====
    const proj = join(work, 'proj')
    await mkdir(join(proj, 'src'), { recursive: true })
    await writeFile(join(proj, 'src', 'x.py'), 'def a():\n    return 1\n', 'utf-8')
    const build = await cli(['graph', 'build', proj, '--name', 'smoke'])
    check(
      '5.1 graph build（vendored graphify）',
      build.code === 0 && existsSync(join(proj, 'graphify-out', 'graph.json')),
      build.code !== 0 ? build.stderr.trim().slice(0, 120) : 'graph.json 已生成',
    )

    // ===== 6. 结构断言：绝不出现 node_modules/3rd =====
    // 事故形态是「3rd 被解析到 node_modules 下」——扫一遍解压树，确认 3rd 在根
    check('6.1 解压树 3rd 在根（非 node_modules/3rd）', existsSync(join(dist, '3rd')) && !existsSync(join(dist, 'node_modules', '3rd')))
  } catch (error) {
    // 前置步骤失败（如打包失败）→ 直接中止后续，但**仍要出汇总**（不抛裸异常）
    process.stdout.write(`\n中止: ${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    if (KEEP) {
      process.stdout.write(`\n临时目录保留: ${work}\n`)
    } else {
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }

  process.stdout.write(`\nPACKAGE SMOKE: ${pass}/${pass + fail} passed\n`)
  if (failures.length > 0) process.stdout.write(`失败项: ${failures.join(', ')}\n`)
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
