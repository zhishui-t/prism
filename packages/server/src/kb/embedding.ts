/**
 * 本地向量化服务（变更 2，2026-09-10 用户裁决：Prism 自理 embedding，不依赖宿主）。
 *
 * 形态：BGE-M3（GGUF Q8_0，1024 维）经 llama.cpp 的 llama-server 常驻进程提供
 * `/embedding` HTTP 端点——模型加载一次（约 10s），之后单条 embedding 毫秒级；
 * 比每次 spawn 加载 600MB 模型快几个数量级。
 *
 * 生命周期：**按需启动 + 跨进程复用**——端口被占用即复用现存实例（CLI 每个命令是
 * 新进程，detached 启动保证 server 不随命令退出）；PID 落盘供 `prism embedding stop`。
 *
 * 未安装（setup-embedding 未跑）时降级：所有调用返回 unavailable，检索回落纯 BM25，
 * 不炸、不阻塞落库。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** vendored 布局（scripts/setup-embedding.mjs 安装目标）。 */
const LLAMA_DIR = fileURLToPath(new URL('../../../../3rd/llama.cpp', import.meta.url))
const SERVER_EXE = join(LLAMA_DIR, 'bin', 'llama-server.exe')
const MODEL_PATH = join(LLAMA_DIR, 'models', 'bge-m3-Q8_0.gguf')
const PID_FILE = join(LLAMA_DIR, 'llama-server.pid')

/** 默认端口（可被 PRISM_EMBEDDING_PORT 覆盖）。 */
export const EMBEDDING_PORT = Number(process.env['PRISM_EMBEDDING_PORT'] ?? 8191)
const BASE = `http://127.0.0.1:${EMBEDDING_PORT}`
/** 启动等待上限（模型加载 ~10s，留余量）。 */
const START_TIMEOUT_MS = 60_000

/** BGE-M3 输出维度（写库校验用）。 */
export const EMBEDDING_DIM = 1024

/** 安装是否就绪（二进制 + 模型都在）。`PRISM_EMBEDDING=off` 时一律视为未就绪（降级纯 BM25）。 */
export function embeddingInstalled(): boolean {
  if (embeddingDisabled()) return false
  return existsSync(SERVER_EXE) && existsSync(MODEL_PATH)
}

/**
 * 全局降级开关：`PRISM_EMBEDDING=off` 强制纯 BM25。
 * 用于确定性测试（向量召回会扩大命中面，破坏精确计数断言）与排障对照。
 */
function embeddingDisabled(): boolean {
  const v = process.env['PRISM_EMBEDDING']
  return v === 'off' || v === '0' || v === 'false'
}

/** 停止常驻 server（PID 文件记录的进程）。返回是否有进程被停。 */
export function stopEmbeddingServer(): boolean {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf-8').trim())
    if (!Number.isFinite(pid)) return false
    process.kill(pid)
    rmSync(PID_FILE, { force: true })
    return true
  } catch {
    rmSync(PID_FILE, { force: true })
    return false
  }
}

/** 端口健康检查（禁代理：127.0.0.1 不能走系统代理）。 */
async function isAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

/** 等待健康（轮询）。 */
async function waitAlive(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isAlive()) return true
    await new Promise((r) => setTimeout(r, 800))
  }
  return false
}

let starting: Promise<boolean> | undefined

/** 确保已就绪并运行；失败（含未安装）返回 false。 */
export function ensureEmbeddingServer(): Promise<boolean> {
  if (starting === undefined) {
    starting = (async () => {
      if (await isAlive()) return true
      if (!embeddingInstalled()) return false
      const child = spawn(
        SERVER_EXE,
        ['-m', MODEL_PATH, '--embedding', '--host', '127.0.0.1', '--port', String(EMBEDDING_PORT), '-c', '4096'],
        { detached: true, stdio: 'ignore', windowsHide: true },
      )
      child.unref()
      try {
        writeFileSync(PID_FILE, String(child.pid), 'utf-8')
      } catch {
        // PID 记录失败不影响运行
      }
      const ok = await waitAlive(START_TIMEOUT_MS)
      if (!ok) starting = undefined // 允许下次重试
      return ok
    })()
  }
  return starting
}

export interface EmbedText {
  ok: boolean
  vector?: Float32Array
  error?: string
}

/**
 * 单条文本 → 向量。**未安装/启动失败返回 ok:false**（调用方降级，不抛）。
 */
export async function embedText(text: string): Promise<EmbedText> {
  if (!embeddingInstalled()) {
    return { ok: false, error: 'embedding 未安装（跑 node scripts/setup-embedding.mjs）' }
  }
  if (!(await ensureEmbeddingServer())) {
    return { ok: false, error: 'embedding server 启动失败' }
  }
  try {
    const res = await fetch(`${BASE}/embedding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: text.slice(0, 8000) }), // 截超长文本（上下文 4096 token）
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = (await res.json()) as unknown
    // 响应兼容两种形态：{"embedding":[...]} 与批量 [{"index":0,"embedding":[[...]]}]
    let vec: number[] | undefined
    if (Array.isArray(data)) {
      const first = data[0] as { embedding: number[] | number[][] } | undefined
      const e = first?.embedding
      vec = Array.isArray(e?.[0]) ? (e as number[][])[0] : (e as number[] | undefined)
    } else if (typeof data === 'object' && data !== null) {
      const e = (data as { embedding: number[] | number[][] }).embedding
      vec = Array.isArray(e?.[0]) ? (e as number[][])[0] : (e as number[] | undefined)
    }
    if (vec === undefined || vec.length !== EMBEDDING_DIM) {
      return { ok: false, error: `embedding 响应异常（dim=${vec?.length ?? '无'}）` }
    }
    return { ok: true, vector: Float32Array.from(vec) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 余弦相似度（向量应已归一化，但 BGE 输出未必严格单位长——显式归一）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** Float32Array → BLOB（SQLite 存储）。 */
export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

/** BLOB → Float32Array。 */
export function blobToVector(blob: Buffer | Uint8Array): Float32Array {
  const copy = new Float32Array(blob.byteLength / 4)
  new Uint8Array(copy.buffer).set(blob)
  return copy
}
