#!/usr/bin/env node
/**
 * 发行包冒烟（`pnpm run test:package`）：打包 → 解压 → 在**解压环境**验证关键能力。
 *
 * 为什么必须单独有这一步：开发态测试用的路径是 `packages/<pkg>/dist/`，打包物化后
 * 变成 `node_modules/@prism/<pkg>/dist/`（**多一层**）。任何写死相对层级的路径解析、
 * 或依赖「开发态才存在」的文件，都会在这里暴露——而 `pnpm test` / `test:e2e`
 * 全程跑在仓库内，**永远发现不了**（2026-09-11 实际踩中：tarball 内 anydoc 不可用、
 * graphify 静默回落 PATH 上的无关版本）。
 *
 * v11（2026-09-14）随「平台自包含包」改版：运行时随包后，本脚本的重点从
 * 「三方件装不装得上」转为「**不跑任何安装脚本**也直接可用」——所以 anydoc 转换
 * 与 embedding 就绪都在**未调用 setup-* 脚本**的前提下断言。
 *
 * 覆盖：
 *   1. 打包成功 + 产物齐全（按平台名发现 tgz）+ SHA256SUMS 对得上 + 体积合理
 *   2. 解压 → `--version` 可跑 + 清单平台一致
 *   3. `doctor`：vendored graphify 解析正确（不回落 PATH）、anydoc 指向解压树内
 *   4. `kb convert`（anydoc 真实转换，**免安装**）
 *   5. `graph build`（vendored graphify 真实建图）
 *   6. embedding **免安装**起服务（隔离端口，断言档位维度与后端）
 *   7. 结构断言：3rd 在根、运行时齐备、llama.cpp 源码未随包、无 .git 残留
 *
 * 选项：--skip-build（复用现有 dist）、--keep（保留临时目录便于排查）
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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

/** 与 scripts/package.mjs 的 platformToken() 同口径（这里只用于**核对**包名）。 */
function platformToken() {
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch]
  return `${os}_${arch}`
}

/** 剥掉 node 的实验性告警，只留有效输出。 */
function clean(text) {
  return text
    .split('\n')
    .filter((l) => !l.includes('ExperimentalWarning') && !l.includes('trace-warnings'))
    .join('\n')
    .trim()
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'prism-pkg-smoke-'))
  process.stdout.write(`发行冒烟（临时目录 ${work}）\n\n`)

  const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8')).version
  const token = platformToken()
  const stageName = `prism-${version}_${token}`
  const distDir = join(ROOT, 'dist')

  // 先删旧产物：package.mjs 在构建失败时会提前抛出，旧 tarball 会留在 dist/，
  // 若不清理，后续用例就会在**上一次的产物**上跑出误导性的 PASS（实测踩过）。
  if (!SKIP_BUILD && existsSync(distDir)) {
    for (const f of await readdir(distDir)) {
      if (f.startsWith(`prism-${version}_`) && f.endsWith('.tgz')) {
        await rm(join(distDir, f), { force: true })
      }
    }
  }

  try {
    // ===== 1. 打包 =====
    const pkgArgs = SKIP_BUILD ? ['scripts/package.mjs', '--skip-build'] : ['scripts/package.mjs']
    const pkg = await run(process.execPath, pkgArgs, ROOT)
    check('1.1 打包成功', pkg.code === 0, pkg.code !== 0 ? clean(pkg.stderr).slice(-300) : '')
    if (pkg.code !== 0) {
      throw new Error('打包失败——后续用例无法在**本次产物**上验证，中止')
    }

    const tgz = join(distDir, `${stageName}.tgz`)
    check('1.2 产物按平台命名存在', existsSync(tgz), `${stageName}.tgz`)
    if (!existsSync(tgz)) throw new Error('产物缺失，中止')

    const size = (await stat(tgz)).size
    // 体积下限抬到 30MB：包内自带 llama 运行时（~104MB 未压缩）+ 最小向量模型（26MB）。
    // 若掉到 30MB 以下，基本可判定**运行时没进包**（这正是本次改版的主旨）。
    check('1.3 体积合理（30–250MB，含运行时）', size > 30_000_000 && size < 250_000_000, `${(size / 1048576).toFixed(1)} MB`)

    // 1.4 校验和必须与产物一致（Release 附件靠它验完整性）
    const sumsPath = join(distDir, 'SHA256SUMS')
    const sums = existsSync(sumsPath) ? await readFile(sumsPath, 'utf-8') : ''
    const expected = createHash('sha256').update(await readFile(tgz)).digest('hex')
    const line = sums
      .split('\n')
      .find((l) => l.trim().endsWith(`  ${stageName}.tgz`))
    check('1.4 SHA256SUMS 与产物一致', line !== undefined && line.startsWith(expected), line?.slice(0, 24) ?? '(缺该条目)')

    // ===== 2. 解压 =====
    // 必须以**相对名 + cwd** 调 tar：Git Bash 的 GNU tar 会把 `K:/...` 当远程主机
    // （同 scripts/package.mjs 的踩坑注释），故先把 tgz 拷进临时目录再解。
    await cp(tgz, join(work, `${stageName}.tgz`))
    const ex = await run('tar', ['-xzf', `${stageName}.tgz`], work)
    check('2.1 解压成功', ex.code === 0, ex.code !== 0 ? clean(ex.stderr).slice(0, 200) : '')
    const dist = join(work, stageName)
    check('2.2 解压树完整', existsSync(join(dist, 'bin', 'prism.js')) && existsSync(join(dist, 'packages', 'cli', 'dist')))

    // 解压环境的 PRISM_HOME 隔离在临时目录（绝不碰真实宿主/真实 ~/.prism）；
    // embedding 端口也隔离——否则会探到开发机上已在运行的实例，把「档位维度」
    // 断言变成假红（实测：本机 8191 上跑着 1024 维的 default 档）。
    const home = join(work, 'home')
    const embedPort = String(18000 + Math.floor(Math.random() * 2000))
    await mkdir(home, { recursive: true })
    const env = { PRISM_HOME: home, PRISM_EMBEDDING_PORT: embedPort }
    const cli = (argv) => run(process.execPath, [join(dist, 'bin', 'prism.js'), ...argv], dist, env)

    const ver = await cli(['--version'])
    check('2.3 解压后 --version 可跑且版本一致', ver.code === 0 && ver.stdout.includes(version), clean(ver.stdout).slice(-40))

    const manifest = existsSync(join(dist, 'PRISM-MANIFEST.json'))
      ? JSON.parse(await readFile(join(dist, 'PRISM-MANIFEST.json'), 'utf-8'))
      : null
    check(
      '2.4 清单平台与本机一致',
      manifest !== null && manifest.platform === token && manifest.version === version,
      manifest ? `${manifest.platform} · 模型 ${manifest.runtime.models.join(',')}` : '(缺 PRISM-MANIFEST.json)',
    )

    // ===== 3. doctor：三方件路径解析（打包事故的核心断言）=====
    const doctor = await cli(['doctor'])
    const text = clean(doctor.stdout)

    // graphify 必须走 vendored（版本是我们锁的），**不能**是 PATH 上的无关版本
    check(
      '3.1 graphify 解析到 vendored（非 PATH 回落）',
      /graphify.*vendored/s.test(text) || text.includes('0.9.57'),
      (text.split('\n').find((l) => l.includes('graphify')) ?? '(缺该检查项)').trim().slice(0, 90),
    )

    // anydoc 必须**免安装**就可用（本次改版的主旨：不再依赖 setup-anydoc 下载）
    const anydocLine = text.split('\n').find((l) => l.includes('anydoc')) ?? ''
    check('3.2 anydoc 免安装即可用', anydocLine.includes('ok'), anydocLine.trim().slice(0, 90))

    // ===== 4. anydoc 真实转换（不跑 setup-anydoc）=====
    const csv = join(work, 't.csv')
    await writeFile(csv, 'name,age\nAlice,30\n', 'utf-8')
    const conv = await cli(['kb', 'convert', csv])
    check('4.1 kb convert（anydoc 真实转换，免安装）', conv.code === 0 && conv.stdout.includes('| Alice |'), clean(conv.stdout).slice(0, 60))

    // ===== 5. graph build（vendored graphify 真实建图）=====
    const proj = join(work, 'proj')
    await mkdir(join(proj, 'src'), { recursive: true })
    await writeFile(join(proj, 'src', 'x.py'), 'def a():\n    return 1\n', 'utf-8')
    const build = await cli(['graph', 'build', proj, '--name', 'smoke'])
    check(
      '5.1 graph build（vendored graphify）',
      build.code === 0 && existsSync(join(proj, 'graphify-out', 'graph.json')),
      build.code !== 0 ? clean(build.stderr).slice(0, 120) : 'graph.json 已生成',
    )

    // ===== 6. embedding 免安装起服务（包内 llama 运行时）=====
    const est = await cli(['embedding', 'status'])
    const estText = clean(est.stdout)
    check(
      '6.1 embedding 就绪（包内运行时，档位 small / 512 维）',
      estText.includes('就绪') && estText.includes('512'),
      (estText.split('\n').find((l) => l.includes('档位')) ?? estText.split('\n')[0] ?? '').trim().slice(0, 90),
    )
    check(
      '6.2 embedding 后端可用（GPU Vulkan 或 CPU）',
      /GPU|CPU/.test(estText),
      (estText.split('\n').find((l) => l.includes('后端')) ?? '(缺该行)').trim().slice(0, 90),
    )
    // 收掉本用例起的服务，避免给下次运行留残留态
    await cli(['embedding', 'stop'])

    // ===== 7. 结构断言 =====
    // 事故形态是「3rd 被解析到 node_modules 下」——扫一遍解压树，确认 3rd 在根
    check('7.1 解压树 3rd 在根（非 node_modules/3rd）', existsSync(join(dist, '3rd')) && !existsSync(join(dist, 'node_modules', '3rd')))

    // 运行时齐备：这是「访问不了 git 也装得上」的物理前提
    const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    const rt = join(dist, '3rd', 'llama-runtime')
    check('7.2 llama 主二进制随包', existsSync(join(rt, 'bin', binName)), `3rd/llama-runtime/bin/${binName}`)
    check('7.3 anydoc 运行时随包', existsSync(join(dist, '3rd', 'anydoc-runtime', 'anydoc.js')))
    check('7.4 最小向量模型随包', existsSync(join(rt, 'models', 'bge-small-zh-v1.5-q8_0.gguf')))

    // 源码与中间产物**不该**占包体：llama.cpp 源码 173MB、build/ 95MB
    check('7.5 未随包 llama.cpp 源码（省 173MB）', !existsSync(join(dist, '3rd', 'llama.cpp')))
    check('7.6 未随包编译中间产物 build/', !existsSync(join(rt, 'build')))

    // 子模块的 .git 指针文件不该进包（否则目标机看到「残缺仓库」会困惑）
    const stray = await findStrayGit(dist)
    check('7.7 无 .git 残留', stray === null, stray ?? '')
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

/** 在解压树里找 .git（文件或目录）；只扫 3rd（其余目录是构建产物，不该有）。 */
async function findStrayGit(root) {
  const third = join(root, '3rd')
  if (!existsSync(third)) return null
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.name === '.git') return p
      if (entry.isDirectory()) {
        const hit = await walk(p)
        if (hit !== null) return hit
      }
    }
    return null
  }
  return await walk(third)
}

await main()
