import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPersistence, prismPaths } from '@prism/core'
// OCR 就绪判据的**实现**在 knowledge（doctor 侧只读它的导出，不另立一套口径）
import {
  OCR_MODEL_COUNT,
  ocrDepsReady,
  ocrExtrasDepsReady,
  ocrLayoutModelReady,
  ocrModelCount,
  ocrModelsDir,
  ocrModelsReady,
  ocrTableModelReady,
  parseOcrOff,
} from '@prism/knowledge'
import {
  EMBEDDING_PORT,
  RERANK_PORT,
  activeModel,
  activeRerankModel,
  cpuBackendHint,
  embedText,
  embeddingInstalled,
  ensureHarnessPluginsLoaded,
  gpuBackendLabel,
  harnessDir,
  listHarnesses,
  preferredBackend,
  probeConverter,
  rerankInstalled,
  rerankServerAlive,
  resolveGraphifyCommand,
  resolveRerankConfigForHome,
  runGraphify,
  vendoredGraphifyVersion,
} from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

const MIN_NODE = [22, 5] as const

/** `prism doctor`：Node 版本 / PRISM_HOME 可写 / knowledge.db 可开 / graphify 存在 / 端口占用。 */
export async function runDoctor(ctx: CommandContext, _args: string[], values: ArgValues): Promise<number> {
  const home = ctx.home ?? prismPaths().home
  const checks: DoctorCheck[] = []

  // 1) Node 版本（engines: >=22.5，node:sqlite 需要）
  const [maj, min] = process.versions.node.split('.').map((n) => Number(n))
  const nodeOk = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])
  checks.push({
    name: 'node_version',
    ok: nodeOk,
    detail: `当前 ${process.versions.node}，要求 >= ${MIN_NODE.join('.')}`,
  })

  // 2) PRISM_HOME 可写
  const paths = prismPaths(home)
  try {
    mkdirSync(paths.home, { recursive: true })
    const probe = mkdtempSync(join(tmpdir(), 'prism-doctor-'))
    const file = join(probe, 'w')
    writeFileSync(file, 'ok')
    const content = readFileSync(file, 'utf-8')
    rmSync(probe, { recursive: true, force: true })
    checks.push({ name: 'prism_home_writable', ok: content === 'ok', detail: home })
  } catch (error) {
    checks.push({ name: 'prism_home_writable', ok: false, detail: `${home}（${msg(error)}）` })
  }

  // 3) knowledge.db 可开
  try {
    const persistence = openPersistence({ home })
    const version = persistence.knowledge.userVersion()
    persistence.close()
    checks.push({ name: 'knowledge_db', ok: true, detail: `${paths.stateDir}/knowledge.db（user_version=${version}）` })
  } catch (error) {
    checks.push({ name: 'knowledge_db', ok: false, detail: msg(error) })
  }

  // 4) graphify 存在（vendored 子工程 / PATH / GRAPHIFY_BIN）
  try {
    const resolved = await resolveGraphifyCommand(ctx.graphifyEnv ?? process.env)
    let detail = `${resolved.command}${resolved.prefixArgs.length > 0 ? ` ${resolved.prefixArgs.join(' ')}` : ''}${resolved.shell ? '（shell 模式）' : ''}`
    try {
      // vendored Python 子工程的 --version 输出 unknown，优先读 pyproject.toml
      const fromPyproject = await vendoredGraphifyVersion()
      if (fromPyproject !== null) {
        detail += ` 版本: ${fromPyproject}（vendored）`
      } else {
        const version = await runGraphify(['--version'], {
          env: ctx.graphifyEnv ?? process.env,
          timeoutMs: 10_000,
        })
        detail += ` 版本: ${version.stdout.trim().split('\n')[0] || '未知'}`
      }
    } catch {
      detail += '（--version 不可用，忽略）'
    }
    checks.push({ name: 'graphify', ok: true, detail })
  } catch (error) {
    checks.push({ name: 'graphify', ok: false, detail: `${msg(error)}（可设 GRAPHIFY_BIN）` })
  }

  // 5) 文档转换（anydoc 三方件）：kb sync 转 docx/pdf 等的前提
  const converterError = await probeConverter()
  checks.push({
    name: 'anydoc',
    ok: converterError === null,
    detail:
      converterError === null
        ? '文档转换可用（docx/pdf/xlsx/pptx/csv → Markdown）'
        : `${converterError}（未安装则 kb sync 只能处理 md/txt）`,
  })

  // 6) 本地向量化（变更 2，可选增强）：未安装不算失败——检索自动回落纯 BM25
  if (!embeddingInstalled()) {
    checks.push({
      name: 'embedding',
      ok: true,
      detail: `未安装（可选；装后检索走 BM25+向量混合）：prism embedding install`,
    })
  } else {
    const probe = await embedText('健康检查')
    const backend = preferredBackend()
    const def = activeModel()
    // 后端文案（含「走 CPU 时怎么办」的建议）由 @prism/server 统一给，CLI 不自己判平台
    const backendLabel = backend === 'gpu' ? `GPU/${gpuBackendLabel()}` : `CPU${cpuBackendHint()}`
    checks.push({
      name: 'embedding',
      ok: probe.ok,
      detail: probe.ok
        ? `就绪（档位 ${def.tier}／${def.label}，${def.dim} 维，${backendLabel}，127.0.0.1:${EMBEDDING_PORT}）`
        : `已安装但服务不可用：${probe.error ?? '未知'}（prism embedding start）`,
    })
  }

  // 6b) 精排 rerank（v14 §1.1/§1.2、SPEC-1.5/1.6）：**与 embedding 分列的独立端点行**
  // 与 embedding 行的手法是「分列两端点」而非「同一行两状态」——两实例端口/PID/模型/
  // 门控全独立（M1）。这里**只探不发**（`rerankServerAlive`）：自检不该为报状态拉起
  // 438MB 的第二个实例，端点未运行是常态（检索按需拉起）。
  {
    const rerankModel = activeRerankModel()
    const cfg = resolveRerankConfigForHome(home)
    const installed = rerankInstalled()
    const alive = installed ? await rerankServerAlive() : false
    const endpoint = `127.0.0.1:${RERANK_PORT}`
    const spec = `档位 ${rerankModel.tier}／${rerankModel.label}，候选 ${cfg.candidates}×${cfg.maxDocChars} 字符，超时 ${cfg.timeoutMs}ms`
    let detail: string
    if (!installed) {
      detail = `未安装（可选；装后检索可走 RRF+精排，默认按档位）：prism embedding install`
    } else if (!cfg.enabled) {
      detail = `已安装但未启用（${spec}，${endpoint}${alive ? '，端点运行中' : ''}）：prism.yaml 写 rerank_enabled: on 可显式开启`
    } else {
      detail = `${alive ? '就绪' : '已启用（端点未运行，检索时按需拉起）'}（${spec}，${endpoint}）`
    }
    checks.push({ name: 'rerank', ok: true, detail })
  }

  // 6c) OCR（v14 B-4 / SPEC-4.2）：与上面两行同哲学的**第三行**——可选增强，恒 ok。
  // 恒 ok 的理由与 rerank 同：OCR 没有守护进程可探，「装了但 runner 坏」只有真跑转换
  // 才知道（探不出来就不该让 doctor 变红，否则等于把本机装没装模型变成环境敏感项）；
  // 缺失/半装的实况写进 detail 供人判。判据即 `ocrAvailable()` 的两个分量：
  // models 目录 onnx 件数 + pip 依赖可导入；env 门（PRISM_OCR=off）优先于探测。
  {
    const modelsDir = ocrModelsDir()
    const off = parseOcrOff(process.env['PRISM_OCR'])
    const count = ocrModelCount(modelsDir)
    const modelsReady = ocrModelsReady(modelsDir)
    // 模型没到位就不去 spawn Python 探依赖：没东西可跑，省一次最长 20s 的子进程
    const depsReady = !off && modelsReady ? await ocrDepsReady() : false
    // v17 §A-0：表格/版面两件是**可选**增强（缺失只让 table/layout 回到旧输出）
    const tableReady = ocrTableModelReady(modelsDir)
    const layoutReady = ocrLayoutModelReady(modelsDir)
    const extrasDeps = !off && tableReady && layoutReady ? await ocrExtrasDepsReady() : false
    // 计数改成「总件数 + 核心必备」——加了可选两件后「N/3」会显示成「5/3」误导
    const spec = `模型目录 ${count} 件，核心必备 ≥${OCR_MODEL_COUNT} 件`
    const extras = `表格 ${tableReady ? '就绪' : '未装'}／版面 ${layoutReady ? '就绪' : '未装'}`
    const extrasOk = tableReady && layoutReady && extrasDeps
    const extrasNote = `增强 ${extras}；pip 可选件 ${extrasDeps ? '可导入' : '不可导入'}`
    let detail: string
    if (off) {
      detail = `已关闭（PRISM_OCR=off；按未装 OCR 走，图片/扫描 PDF 回落旧文案；${spec}；${modelsDir}）`
    } else if (!modelsReady) {
      detail = `未安装（可选；装后图片与扫描 PDF 走 OCR；${spec}；${modelsDir}）：node scripts/setup-ocr.mjs`
    } else if (!depsReady) {
      detail = `模型就绪但 pip 依赖不可导入（OCR 不会启用；${spec}；${modelsDir}）：node scripts/setup-ocr.mjs`
    } else {
      const hint = extrasOk
        ? ''
        : '——可选件缺失只影响表格/多栏还原，可跑 node scripts/setup-ocr.mjs 补齐'
      detail = `就绪（${spec}；${extrasNote}；${modelsDir}）${hint}`
    }
    checks.push({ name: 'ocr', ok: true, detail })
  }

  // 7) harness 适配器插件（<PRISM_HOME>/harnesses/ 自动注册；有失败项才告警）
  {
    const report = await ensureHarnessPluginsLoaded(home).catch(() => null)
    const listings = listHarnesses()
    const loaded = listings.filter((a) => a.origin === 'external').map((a) => a.id)
    const failed = report?.errors ?? []
    checks.push({
      name: 'harness_plugins',
      ok: failed.length === 0,
      detail:
        failed.length > 0
          ? `${failed.length} 个插件加载失败：${failed.map((f) => f.dir).join(', ')}`
          : loaded.length > 0
            ? `已加载 ${loaded.length} 个插件适配器：${loaded.join(', ')}`
            : `无插件（可选；把适配器包放入 ${harnessDir(home)} 即自动注册），内置 ${listings.filter((a) => a.origin === 'builtin').map((a) => a.id).join(', ')}`,
    })
  }

  // 8) 端口占用
  const port = values.port !== undefined ? Number(values.port) : 7777
  const portFree = await probePort(port, values.host)
  checks.push({
    name: `port_${port}`,
    ok: portFree,
    detail: portFree ? `端口 ${port} 空闲` : `端口 ${port} 被占用（换端口：--port）`,
  })

  const allOk = checks.every((c) => c.ok)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: allOk, value: checks }))
  } else {
    for (const check of checks) {
      ctx.stdout(`${check.ok ? '  ok ' : 'FAIL '} ${check.name} — ${check.detail}`)
    }
    ctx.stdout(allOk ? 'doctor: 全部通过' : 'doctor: 存在失败项')
  }
  return allOk ? 0 : 1
}

function probePort(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host ?? '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
