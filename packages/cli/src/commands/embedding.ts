/**
 * `prism embedding <action>` —— 本地向量化环境（变更 2）。
 *
 *   prism embedding status     检查二进制/模型/服务状态
 *   prism embedding install    跑 scripts/setup-embedding.mjs（下载+编译）
 *   prism embedding start      拉起常驻 llama-server
 *   prism embedding stop       停止常驻服务
 *   prism embedding reindex    为已有条目补齐向量（重算，幂等）
 *
 * 设计：Prism 自理 embedding，不依赖宿主 LLM；未安装时全链路纯 BM25 降级。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { openPersistence } from '@prism/core'
import {
  EMBEDDING_DIM,
  EMBEDDING_PORT,
  embedText,
  embeddingInstalled,
  ensureEmbeddingServer,
  stopEmbeddingServer,
} from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'

const ACTIONS = ['status', 'install', 'start', 'stop', 'reindex'] as const
type Action = (typeof ACTIONS)[number]

export async function runEmbedding(ctx: CommandContext, args: string[], _values: ArgValues): Promise<number> {
  const action = (args[0] ?? 'status') as Action
  if (!ACTIONS.includes(action)) {
    ctx.stderr(`未知子命令: ${action}（可用: ${ACTIONS.join(' | ')}）`)
    return 1
  }
  switch (action) {
    case 'status':
      return await status(ctx)
    case 'install':
      return await install(ctx)
    case 'start':
      return await start(ctx)
    case 'stop':
      return await stop(ctx)
    case 'reindex':
      return await reindex(ctx)
  }
}

async function status(ctx: CommandContext): Promise<number> {
  const installed = embeddingInstalled()
  let alive = false
  let probe: string | undefined
  if (installed) {
    try {
      const r = await embedText('健康检查')
      alive = r.ok
      probe = r.ok ? `dim=${r.vector?.length ?? 0}` : r.error
    } catch (error) {
      probe = error instanceof Error ? error.message : String(error)
    }
  }
  const payload = {
    installed,
    alive,
    port: EMBEDDING_PORT,
    dim: EMBEDDING_DIM,
    ...(probe !== undefined ? { probe } : {}),
  }
  if (ctx.json) ctx.stdout(JSON.stringify({ ok: true, value: payload }))
  else {
    ctx.stdout(`安装: ${installed ? '就绪' : '缺失（跑 prism embedding install）'}`)
    ctx.stdout(`服务: ${alive ? `运行中（127.0.0.1:${EMBEDDING_PORT}，${probe ?? ''}）` : '未运行'}`)
    ctx.stdout(`维度: ${EMBEDDING_DIM}（BGE-M3）`)
  }
  return 0
}

async function install(ctx: CommandContext): Promise<number> {
  const script = fileURLToPath(new URL('../../../../scripts/setup-embedding.mjs', import.meta.url))
  if (!existsSync(script)) {
    ctx.stderr(`未找到安装脚本: ${script}（源码仓库请确认 scripts/setup-embedding.mjs 存在）`)
    return 1
  }
  ctx.stdout(`运行 ${script}（首次本地编译 llama.cpp 可能数分钟）…`)
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit' })
    child.on('close', resolve)
    child.on('error', () => resolve(-1))
  })
  return code === 0 ? 0 : 1
}

async function start(ctx: CommandContext): Promise<number> {
  if (!embeddingInstalled()) {
    ctx.stderr('未安装：先跑 prism embedding install')
    return 1
  }
  const ok = await ensureEmbeddingServer()
  if (ctx.json) ctx.stdout(JSON.stringify({ ok, value: { port: EMBEDDING_PORT } }))
  else ctx.stdout(ok ? `embedding 服务就绪（127.0.0.1:${EMBEDDING_PORT}）` : 'embedding 服务启动失败')
  return ok ? 0 : 1
}

async function stop(ctx: CommandContext): Promise<number> {
  const stopped = stopEmbeddingServer()
  if (ctx.json) ctx.stdout(JSON.stringify({ ok: true, value: { stopped } }))
  else ctx.stdout(stopped ? 'embedding 服务已停止' : '没有在运行的 embedding 服务')
  return 0
}

/**
 * 为库中所有「最新版且尚无当前向量」的自有型条目补齐向量。
 * 幂等：已有同版次向量的跳过；正文从版次文件读取（自有型）。
 * 引用型不在此列（其向量在 kb sync 落库时写入）。
 */
async function reindex(ctx: CommandContext): Promise<number> {
  if (!embeddingInstalled()) {
    ctx.stderr('未安装：先跑 prism embedding install')
    return 1
  }
  const persistence = openPersistence({ home: ctx.home })
  try {
    const raw = persistence.knowledge.raw
    const rows = raw
      .prepare(
        `SELECT e.id, e.version, e.title, e.origin,
                (SELECT COUNT(*) FROM kb_vectors v WHERE v.entry_id = e.id AND v.version = e.version) AS has_vec
         FROM knowledge_entries e
         WHERE e.is_latest = 1 AND e.status != 'deprecated'
         ORDER BY e.updated_at DESC`,
      )
      .all() as unknown as Array<{ id: string; version: number; title: string; origin: string; has_vec: number }>
    let done = 0
    let skipped = 0
    let failed = 0
    for (const row of rows) {
      if (row.has_vec > 0) {
        skipped++
        continue
      }
      const body =
        (raw.prepare('SELECT body FROM kb_fts WHERE rowid = (SELECT rowid FROM knowledge_entries WHERE id = ? AND version = ?)').get(row.id, row.version) as
          | { body: string }
          | undefined)?.body ?? ''
      const r = await embedText(`${row.title}\n${body}`)
      if (!r.ok || r.vector === undefined) {
        failed++
        continue
      }
      const blob = Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength)
      await persistence.knowledge.run((tx) => {
        tx.prepare(
          `INSERT INTO kb_vectors (entry_id, version, dim, vec, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(entry_id, version) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, updated_at = excluded.updated_at`,
        ).run(row.id, row.version, r.vector!.length, blob, new Date().toISOString())
      })
      done++
    }
    const payload = { total: rows.length, embedded: done, skipped, failed }
    if (ctx.json) ctx.stdout(JSON.stringify({ ok: true, value: payload }))
    else ctx.stdout(`向量补齐：共 ${rows.length} 条，新算 ${done}，跳过 ${skipped}，失败 ${failed}`)
    return failed === 0 ? 0 : 1
  } finally {
    persistence.close()
  }
}
