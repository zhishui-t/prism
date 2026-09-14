#!/usr/bin/env node
/**
 * 发布到 GitHub Release：把**当前平台**的发行包与校验和传上去。
 *
 *   node scripts/release.mjs [--tag v0.1.0-alpha] [--notes <file>]
 *                            [--draft] [--dry-run] [--repo <owner/name>]
 *   pnpm run release
 *
 * 为什么自己写而不用 `gh`：本机（以及很多交付环境）没装 gh CLI；这一步只是
 * 「建 Release + 传两个附件」，用 REST API 直做最省依赖。
 *
 * 认证：环境变量 `GITHUB_TOKEN`（或 `GH_TOKEN`）。GitHub Enterprise 可用
 * `GITHUB_API_URL` 覆盖 API 根（上传口会自动换成对应的 uploads 主机）。
 *
 * 流程：
 *   1. 前置：找到本平台的 tgz + SHA256SUMS，**复算 sha256 并核对**（不传坏包）
 *   2. 前置：确认工作区干净、本地提交已推到远端（未推则拒绝发布——否则 tag 指向不存在的提交）
 *   3. 按 tag 取 Release；不存在则创建（带 --notes 的说明；版本含 `-` 默认标 prerelease）
 *   4. 逐个上传附件；同名附件先删后传（可重跑，幂等）
 *
 * 常用：
 *   node scripts/release.mjs --dry-run                 # 只打印计划，不联网
 *   GITHUB_TOKEN=... node scripts/release.mjs          # 正式发布
 *   GITHUB_TOKEN=... node scripts/release.mjs --draft  # 先出草稿，人工过一眼再发布
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function log(msg) {
  process.stdout.write(`[release] ${msg}\n`)
}

function die(msg) {
  process.stderr.write(`[release] 失败: ${msg}\n`)
  process.exit(1)
}

/**
 * 取 GitHub token：先看环境变量，再回落到 git 的凭据管理器。
 *
 * 回落那条路是为了免去「为了发一次 Release 再去手工造一个 PAT」——既然本机已经能
 * `git push`，就说明 github.com 的授权早已存在，`git credential fill` 能把它交回来。
 * 全程只取用、不打印（日志里只出现来源名）。
 */
function resolveToken() {
  const env = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']
  if (env !== undefined && env !== '') return { token: env, from: '环境变量 GITHUB_TOKEN' }
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 30_000,
      // 非交互：需要弹窗登录时宁可失败，也不要卡在等待输入上。
      env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
    })
    const m = /^password=(.+)$/m.exec(out)
    if (m) return { token: m[1].trim(), from: 'git 凭据管理器' }
  } catch {
    /* 取不到就返回 null，由调用方给出可操作的报错 */
  }
  return null
}

/** 平台标识，与 scripts/package.mjs 的 platformToken() 同口径。 */
function platformToken() {
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch]
  if (os === undefined || arch === undefined) {
    die(`未知平台 ${process.platform}/${process.arch}——请先在 platformToken() 里登记`)
  }
  return `${os}_${arch}`
}

/** 跑 git 拿字符串（失败返回 null，不抛）。 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const out = { tag: null, notes: null, draft: false, dryRun: false, repo: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') out.tag = argv[++i]
    else if (argv[i] === '--notes') out.notes = argv[++i]
    else if (argv[i] === '--draft') out.draft = true
    else if (argv[i] === '--dry-run') out.dryRun = true
    else if (argv[i] === '--repo') out.repo = argv[++i]
  }
  return out
}

/** 从 origin 的 URL 解析 owner/name（兼容 https 与 ssh 两种写法）。 */
function repoFromRemote() {
  const url = git(['remote', 'get-url', 'origin'])
  if (url === null) return null
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  return m === null ? null : `${m[1]}/${m[2]}`
}

/** 带认证的 API 请求；非 2xx 时把 GitHub 的 message 抛出来。 */
async function api(method, url, { token, body, contentType, extraHeaders } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'prism-release',
    ...extraHeaders,
  }
  if (contentType !== undefined) headers['Content-Type'] = contentType
  const res = await fetch(url, { method, headers, body })
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      detail = JSON.parse(text).message ?? detail
    } catch {
      // 保持原文
    }
    throw new Error(`${method} ${url} → ${res.status} ${detail}`)
  }
  return text === '' ? null : JSON.parse(text)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
  const version = pkg.version
  const platform = platformToken()
  const stageName = `prism-${version}_${platform}`
  const tag = args.tag ?? `v${version}`
  const notesPath = args.notes ?? join('doc', 'releases', `v${version}.md`)
  const repo = args.repo ?? repoFromRemote()
  const apiBase = (process.env['GITHUB_API_URL'] ?? 'https://api.github.com').replace(/\/$/, '')

  // ===== 1. 产物与校验和 =====
  const tgz = join(ROOT, 'dist', `${stageName}.tgz`)
  if (!existsSync(tgz)) {
    die(`找不到产物 ${tgz}\n  先跑: pnpm run package`)
  }
  const bytes = readFileSync(tgz)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const sumsPath = join(ROOT, 'dist', 'SHA256SUMS')
  const sums = existsSync(sumsPath) ? readFileSync(sumsPath, 'utf-8') : ''
  const sumsLine = sums.split('\n').find((l) => l.trim().endsWith(`  ${stageName}.tgz`))
  if (sumsLine === undefined) {
    die(`SHA256SUMS 里没有 ${stageName}.tgz 的条目——先重跑 pnpm run package`)
  }
  const declared = sumsLine.trim().split(/\s+/)[0]
  if (declared !== sha256) {
    die(`校验和不一致：SHA256SUMS 写 ${declared}，实测 ${sha256}——包被改动过，重新打包`)
  }
  const sizeMb = (statSync(tgz).size / 1048576).toFixed(1)
  log(`产物 ${stageName}.tgz（${sizeMb} MB）· sha256 ${sha256.slice(0, 16)}…（已复算核对）`)

  // ===== 2. 远端前置：tag 必须指向已推送的提交 =====
  if (repo === null) die('取不到 origin 仓库地址——用 --repo <owner/name> 指定')
  const head = git(['rev-parse', 'HEAD'])
  const dirty = git(['status', '--porcelain'])
  if (dirty !== null && dirty !== '') {
    log(`⚠ 工作区不干净（${dirty.split('\n').length} 项未提交）——Release 不会包含它们，请确认这是有意为之`)
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'master'
  const remoteRef = git(['rev-parse', `origin/${branch}`])
  if (remoteRef !== null && head !== null && remoteRef !== head) {
    die(
      `本地 ${branch}（${head.slice(0, 8)}）与 origin/${branch}（${remoteRef.slice(0, 8)}）不一致。\n` +
        `  发布会在远端建 tag 指向**已推送的提交**，先把提交推上去：git push origin ${branch}`,
    )
  }
  log(`仓库 ${repo} · tag ${tag} · 基于 ${branch}@${(head ?? '').slice(0, 8)}`)

  // ===== 3. 说明文件 =====
  const notesAbs = join(ROOT, notesPath)
  const body = existsSync(notesAbs)
    ? readFileSync(notesAbs, 'utf-8')
    : `Prism ${tag}（${platform}）\n\n> 未找到说明文件 ${notesPath}，此 Release 无详细说明。`
  log(`说明 ${existsSync(notesAbs) ? notesPath : '(缺失，用占位)'}（${body.length} 字）`)

  const assets = [tgz, sumsPath].filter((p) => existsSync(p))
  const prerelease = version.includes('-') // alpha / beta / rc 一律标 prerelease

  if (args.dryRun) {
    log('--dry-run：以下为将要执行的步骤（未联网）')
    log(`  1. GET  ${apiBase}/repos/${repo}/releases/tags/${tag}`)
    log(`     └ 存在则复用；不存在则 POST /releases { tag_name: "${tag}", name: "${tag}", prerelease: ${prerelease}, draft: ${args.draft} }`)
    for (const a of assets) {
      log(`  2. POST https://uploads.github.com/repos/${repo}/releases/{id}/assets?name=${basename(a)}（${(statSync(a).size / 1048576).toFixed(1)} MB）`)
    }
    log('就绪。网络可用且提供 GITHUB_TOKEN 后，去掉 --dry-run 即可发布。')
    return
  }

  // ===== 4. 正式发布 =====
  const auth = resolveToken()
  if (auth === null) {
    die(
      '缺凭据：环境变量 GITHUB_TOKEN / GH_TOKEN 未设，且本机 git 凭据管理器里也没有 github.com 的授权。\n' +
        '  示例: GITHUB_TOKEN=ghp_xxx node scripts/release.mjs',
    )
  }
  const token = auth.token
  log(`凭据来源：${auth.from}`)

  let release = null
  try {
    release = await api('GET', `${apiBase}/repos/${repo}/releases/tags/${tag}`, { token })
    log(`Release ${tag} 已存在（id=${release.id}）——复用并覆盖同名附件`)
  } catch {
    release = await api('POST', `${apiBase}/repos/${repo}/releases`, {
      token,
      contentType: 'application/json',
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        body,
        draft: args.draft,
        prerelease,
      }),
    })
    log(`已创建 Release ${tag}（id=${release.id}${args.draft ? '，草稿' : ''}）`)
  }

  const uploadBase = apiBase.replace('api.github.com', 'uploads.github.com')
  const existing = await api('GET', `${apiBase}/repos/${repo}/releases/${release.id}/assets`, { token })
  for (const file of assets) {
    const name = basename(file)
    const dup = existing.find((a) => a.name === name)
    if (dup !== undefined) {
      await api('DELETE', `${apiBase}/repos/${repo}/releases/assets/${dup.id}`, { token })
      log(`  同名附件已存在，先删除: ${name}`)
    }
    await api('POST', `${uploadBase}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      token,
      contentType: 'application/octet-stream',
      body: readFileSync(file),
    })
    log(`  已上传 ${name}（${(statSync(file).size / 1048576).toFixed(1)} MB）`)
  }

  log(`完成: ${release.html_url}`)
}

await main()
