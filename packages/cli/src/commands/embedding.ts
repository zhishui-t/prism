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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openPersistence, prismPaths } from '@prism/core'
import {
  EMBEDDING_MODELS,
  EMBEDDING_TIERS,
  EMBEDDING_PORT,
  activeModel,
  activeTier,
  embedText,
  embeddingInstalled,
  ensureEmbeddingServer,
  preferredBackend,
  resolveTier,
  stopEmbeddingServer,
} from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'

/** vendored 模型目录（与 server 的布局一致）。 */
function modelDir(): string {
  return fileURLToPath(new URL('../../../../3rd/llama.cpp/models', import.meta.url))
}

const ACTIONS = ['status', 'install', 'start', 'stop', 'reindex', 'models', 'use'] as const
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
      return await install(ctx, _values)
    case 'start':
      return await start(ctx)
    case 'stop':
      return await stop(ctx)
    case 'reindex':
      return await reindex(ctx)
    case 'models':
      return models(ctx)
    case 'use':
      return use(ctx, args[1])
  }
}

/** 列出三档模型与当前生效项。 */
function models(ctx: CommandContext): number {
  const current = activeTier()
  const backend = preferredBackend()
  const rows = EMBEDDING_TIERS.map((tier) => {
    const m = EMBEDDING_MODELS[tier]
    return {
      tier,
      id: m.id,
      label: m.label,
      dim: m.dim,
      file: m.file,
      installed: existsSync(join(modelDir(), m.file)),
      current: tier === current,
    }
  })
  if (ctx.json) ctx.stdout(JSON.stringify({ ok: true, value: { backend, current, models: rows } }))
  else {
    ctx.stdout(`后端: ${backend === 'gpu' ? 'GPU（Vulkan）' : 'CPU'}    当前档位: ${current}（${EMBEDDING_MODELS[current].label}）`)
    for (const r of rows) {
      const mark = r.current ? '▶' : ' '
      const state = r.installed ? '' : '  [未安装]'
      ctx.stdout(`${mark} ${r.tier.padEnd(8)} ${String(r.dim).padStart(4)}维  ${r.label}${state}`)
    }
    ctx.stdout('')
    ctx.stdout('装某档模型: prism embedding install --tier <small|default|large>')
    ctx.stdout('切换档位:   prism embedding use <small|default|large>（写入 prism.yaml）')
    ctx.stdout('临时覆盖:   环境变量 PRISM_EMBEDDING_MODEL=<档位>')
    ctx.stdout('换档后:     prism embedding reindex（旧模型向量自动失效、按新模型重算）')
  }
  return 0
}

/** `prism embedding use <tier>`：把档位写入 prism.yaml（持久化）。 */
function use(ctx: CommandContext, tierInput: string | undefined): number {
  const tier = resolveTier(tierInput)
  if (tier === null) {
    ctx.stderr(`用法: prism embedding use <small|default|large>（当前: ${activeTier()}）`)
    return 1
  }
  try {
    const file = join(prismPaths(ctx.home).home, 'prism.yaml')
    let text = ''
    try {
      text = readFileSync(file, 'utf-8')
    } catch {
      // 无则新建
    }
    const lines = text.split('\n')
    const idx = lines.findIndex((l) => l.trim().startsWith('embedding_model:'))
    const entry = `embedding_model: ${tier}`
    if (idx >= 0) lines[idx] = entry
    else lines.push(entry)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf-8')
  } catch (error) {
    ctx.stderr(`写入 prism.yaml 失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const def = EMBEDDING_MODELS[tier]
  if (ctx.json) ctx.stdout(JSON.stringify({ ok: true, value: { tier, model: def.id } }))
  else {
    ctx.stdout(`已切换到档位 ${tier}（${def.label}）`)
    ctx.stdout(`模型文件：${def.file}${existsSync(join(modelDir(), def.file)) ? '（已安装）' : '（未安装，跑 prism embedding install）'}`)
    ctx.stdout(`已有条目的向量需重算：prism embedding reindex`)
  }
  return 0
}

async function status(ctx: CommandContext): Promise<number> {
  const installed = embeddingInstalled()
  const backend = preferredBackend()
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
  const def = activeModel()
  const payload = {
    installed,
    alive,
    backend,
    tier: def.tier,
    model: def.id,
    port: EMBEDDING_PORT,
    dim: def.dim,
    ...(probe !== undefined ? { probe } : {}),
  }
  if (ctx.json) ctx.stdout(JSON.stringify({ ok: true, value: payload }))
  else {
    ctx.stdout(`安装: ${installed ? '就绪' : '缺失（跑 prism embedding install）'}`)
    ctx.stdout(`档位: ${def.tier}（${def.label}，${def.dim} 维）`)
    ctx.stdout(`后端: ${backend === 'gpu' ? 'GPU（Vulkan）' : 'CPU'}${backend === 'cpu' ? '——慢约 170 倍，建议 prism embedding install --gpu' : ''}`)
    ctx.stdout(`服务: ${alive ? `运行中（127.0.0.1:${EMBEDDING_PORT}，${probe ?? ''}）` : '未运行'}`)
    ctx.stdout(`可用档位: ${EMBEDDING_TIERS.join(' / ')}（prism embedding models 查看）`)
  }
  return 0
}

async function install(ctx: CommandContext, values: ArgValues): Promise<number> {
  const script = fileURLToPath(new URL('../../../../scripts/setup-embedding.mjs', import.meta.url))
  if (!existsSync(script)) {
    ctx.stderr(`未找到安装脚本: ${script}（源码仓库请确认 scripts/setup-embedding.mjs 存在）`)
    return 1
  }
  const tier = values.tier !== undefined ? resolveTier(String(values.tier)) : null
  if (values.tier !== undefined && tier === null) {
    ctx.stderr(`未知档位: ${values.tier}（可用: ${EMBEDDING_TIERS.join(' / ')}）`)
    return 1
  }
  const scriptArgs: string[] = []
  if (tier !== null) scriptArgs.push('--tier', tier)
  ctx.stdout(`运行 setup-embedding${tier !== null ? `（档位 ${tier}）` : ''}…`)
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [script, ...scriptArgs], { stdio: 'inherit' })
    child.on('close', resolve)
    child.on('error', () => resolve(-1))
  })
  if (code === 0 && tier !== null) use(ctx, tier)
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
 * 为库中所有「最新版且尚无**当前模型**向量」的条目补齐向量。
 * 幂等：已有当前模型同版次向量的跳过；换档后旧模型向量视为缺失 → 重算并改写 model。
 * 正文从 FTS 副本读取（自有型与引用型都有）。
 */
async function reindex(ctx: CommandContext): Promise<number> {
  if (!embeddingInstalled()) {
    ctx.stderr('未安装：先跑 prism embedding install')
    return 1
  }
  const def = activeModel()
  const persistence = openPersistence({ home: ctx.home })
  try {
    const raw = persistence.knowledge.raw
    const rows = raw
      .prepare(
        `SELECT e.id, e.version, e.title,
                (SELECT COUNT(*) FROM kb_vectors v
                  WHERE v.entry_id = e.id AND v.version = e.version AND v.model = ?) AS has_vec
         FROM knowledge_entries e
         WHERE e.is_latest = 1 AND e.status != 'deprecated'
         ORDER BY e.updated_at DESC`,
      )
      .all(def.id) as unknown as Array<{ id: string; version: number; title: string; has_vec: number }>
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
          `INSERT INTO kb_vectors (entry_id, version, dim, vec, model, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(entry_id, version) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, model = excluded.model, updated_at = excluded.updated_at`,
        ).run(row.id, row.version, r.vector!.length, blob, def.id, new Date().toISOString())
      })
      done++
    }
    const payload = { total: rows.length, embedded: done, skipped, failed, model: def.id, tier: def.tier }
    if (ctx.json) ctx.stdout(JSON.stringify({ ok: true, value: payload }))
    else ctx.stdout(`向量补齐（档位 ${def.tier} / ${def.id}）：共 ${rows.length} 条，新算 ${done}，跳过 ${skipped}，失败 ${failed}`)
    return failed === 0 ? 0 : 1
  } finally {
    persistence.close()
  }
}
