#!/usr/bin/env node
/**
 * OCR 运行环境安装脚本（v14 §3.1 / §3.3，与 setup-anydoc / setup-embedding 同模式）。
 *
 *   node scripts/setup-ocr.mjs [选项]
 *
 * 装两样东西（都**不进发行包**，见下）：
 *   1. **pip 依赖** → 当前 Python 环境（`3rd/ocr/requirements.txt`）
 *   2. **ONNX 模型** → `3rd/ocr/models/`：
 *      - **核心三件套**（det / rec / cls，PP-OCRv5 server，共约 179MB）——OCR 主路；
 *      - **可选两件**（v17 B-A1）：`slanet-plus.onnx`（表格结构，约 7.4MB）+
 *        `pp_doc_layoutv3.onnx`（版面分析，约 124MB）——扫描表格还原与多栏阅读顺序。
 *        两件缺任一件时 OCR 主路照常，只是**回到无 table/layout 的旧输出**（设计 A-0）。
 *
 * 为什么**显式**下载模型而不用 rapidocr 的自动拉取：rapidocr 缺省首次运行会联网把模型
 * 下载进 site-packages，破坏「装完即可离线」的承诺（工具侧 ocr_main.py 也一律显式传
 * `Det/Rec/Cls.model_path`）。所以模型由本脚本显式落到 `3rd/ocr/models/`，且**逐个校验
 * SHA256**——ModelScope 的 resolve 链接走重定向，半截包/被代理截断的包若无校验会一路
 * 带到运行时，表现为难以定位的推理报错。表格/版面两件走 `rapid_table` / `rapid_layout`
 * pip 包（同 rapidocr 家族维护），由 ocr_main.py 显式传模型路径，同样**绝不联网拉取**。
 *
 * 模型版本 = `MODELSCOPE_TAG`（RapidAI/RapidOCR 仓库的发布 tag）+ 表格/版面各自的
 * ModelScope 仓库 master 分支（下游 pip 包的 `default_models.yaml` 即为钉版依据）。
 * 升级要点：
 *   1) 改对应 tag/URL，2) 重算 bytes + SHA256（`node -e` 算即可），
 *   3) 与 `3rd/ocr/README.md` 的说明保持一致。
 *
 * 产物（gitignored，不进仓库）：`3rd/ocr/models/*.onnx`
 *   ⚠ `scripts/package.mjs` 另行**显式排除** `3rd/ocr/models/`（B-5）；pip 依赖不随包——
 *   解压环境要跑 OCR 需联网再跑一次 setup（同 graphify 口径）。
 *
 * 选项：
 *   --check          只检查是否就绪（退出码 0/1；轻量，不加载模型）
 *   --force          重装 pip 依赖 + 重下模型
 *   --skip-pip       跳过 pip 安装
 *   --skip-models    跳过模型下载
 *   --skip-selftest  跳过 fixture 真自检
 *
 * 可重复执行 / 断点续传：已下载且 SHA256 相符的模型自动跳过，重跑即续传。
 */
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { resolvePython } from './python.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OCR_DIR = join(ROOT, '3rd', 'ocr')
const MODELS_DIR = join(OCR_DIR, 'models')
const REQUIREMENTS = join(OCR_DIR, 'requirements.txt')
const OCR_TOOL = join(OCR_DIR, 'ocr_tool.mjs')
const TEST_SMOKE = join(OCR_DIR, 'test_smoke.py')
const FIXTURES_DIR = join(OCR_DIR, 'fixtures')
const EXPECTED_JSON = join(FIXTURES_DIR, 'expected.json')

/** 核心三件套的发布 tag（锁定上游版本；升级见文件头）。 */
const MODELSCOPE_TAG = 'v3.9.2'
const MODEL_BASE = `https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/${MODELSCOPE_TAG}/onnx/PP-OCRv5`

/**
 * 可选两件（v17 B-A1）的上游 URL：表格 / 版面各自的 ModelScope 仓库（master 分支，
 * 与下游 pip 包 `default_models.yaml` 钉的同一份发布物）。
 */
const TABLE_MODEL_URL = 'https://www.modelscope.cn/models/RapidAI/RapidTable/resolve/master/slanet-plus.onnx'
const LAYOUT_MODEL_URL =
  'https://www.modelscope.cn/models/RapidAI/RapidLayout/resolve/master/onnx/pp_doc_layout/pp_doc_layoutv3.onnx'

/**
 * 模型清单。bytes / sha256 为官方发布值——**不要凭记忆改**，
 * 改动必须重新下载核对（见文件头「升级要点」）。
 *
 * `file` 决定落盘名——五件一律**平铺**在 `<models>/` 下（与 `ocr_main.py` 的
 * `MODEL_FILES` 及 knowledge 侧 `ocrModelsReady()` 的「至少三件 .onnx」口径一致）；
 * `dir` 只用于拼核心三件套的缺省 URL（`<MODEL_BASE>/<dir>/<file>`），表格/版面两件
 * 另给完整 `url`（不同仓库）。`optional: true` 的两件缺失只影响 table/layout 增强，
 * **不阻断 OCR 主路**（`--check` 仍报状态，但 `--check` 退出码与安装流程都不强制）。
 */
const MODELS = [
  {
    role: 'det',
    dir: 'det',
    file: 'ch_PP-OCRv5_det_server.onnx',
    bytes: 88_118_768,
    sha256: '0f8846b1d4bba223a2a2f9d9b44022fbc22cc019051a602b41a7fda9667e4cad',
  },
  {
    role: 'rec',
    dir: 'rec',
    file: 'ch_PP-OCRv5_rec_server.onnx',
    bytes: 84_577_022,
    sha256: 'e09385400eaaaef34ceff54aeb7c4f0f1fe014c27fa8b9905d4709b65746562a',
  },
  {
    role: 'cls',
    dir: 'cls',
    file: 'ch_PP-LCNet_x1_0_textline_ori_cls_server.onnx',
    bytes: 6_776_876,
    sha256: '7d3c02ef6c7da8ae08b4347cc7695b2081aae68c325d64375724ecf39c99e743',
  },
  {
    role: 'table',
    dir: '',
    file: 'slanet-plus.onnx',
    url: TABLE_MODEL_URL,
    bytes: 7_758_305,
    sha256: 'd57a942af6a2f57d6a4a0372573c696a2379bf5857c45e2ac69993f3b334514b',
    optional: true,
  },
  {
    role: 'layout',
    dir: '',
    file: 'pp_doc_layoutv3.onnx',
    url: LAYOUT_MODEL_URL,
    bytes: 130_502_330,
    sha256: '250dbad1dfb9e4983fab75e1bf5085cd56ec3f41d5c7d0f8623ec74856e7aa67',
    optional: true,
  },
]

/** 核心三件套（主路就绪判据）；其余为可选两件。 */
const CORE_MODELS = MODELS.filter((m) => m.optional !== true)

/** pip 镜像回落（默认源失败时试一次；见 main 里的说明）。 */
const PIP_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const FORCE = args.includes('--force')
const SKIP_PIP = args.includes('--skip-pip')
const SKIP_MODELS = args.includes('--skip-models')
const SKIP_SELFTEST = args.includes('--skip-selftest')

function log(msg) {
  process.stdout.write(`[ocr-setup] ${msg}\n`)
}

function fail(msg) {
  process.stderr.write(`[ocr-setup] 失败: ${msg}\n`)
}

/** 取第一行非空文本（把子进程报错压成一行给 summary/日志）。 */
function firstLine(text) {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  return line ?? ''
}

/**
 * 取「最能说明问题」的一行：python 的 `-c` 报错首行只是 `Traceback (most recent call last):`，
 * 真正的结论在 `ModuleNotFoundError: …` 那行，所以优先挑含 Error 的行。
 */
function errorLine(text) {
  const lines = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  return lines.find((l) => /(?:Error|error):/.test(l)) ?? lines[lines.length - 1] ?? ''
}

/** 流式算 SHA256（三件合计约 179MB，不整读进内存）。 */
async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** 跑命令并实时透传输出；失败抛错。 */
async function run(cmd, cmdArgs) {
  log(`$ ${cmd} ${cmdArgs.join(' ')}`)
  const code = await new Promise((resolveCode) => {
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' })
    child.on('close', resolveCode)
    child.on('error', (err) => {
      fail(`无法启动 ${cmd}: ${err.message}`)
      resolveCode(-1)
    })
  })
  if (code !== 0) throw new Error(`命令失败（退出码 ${code}）: ${cmd} ${cmdArgs.join(' ')}`)
}

/** 核心 pip 依赖模块（OCR 主路）。 */
const CORE_DEPS = ['rapidocr', 'onnxruntime', 'pypdfium2']
/** 可选 pip 依赖模块（v17 B-A1：表格结构 + 版面分析）。 */
const EXTRA_DEPS = ['rapid_table', 'rapid_layout']

/** 指定模块是否都能 import（`modules` 为空视为就绪）。 */
function importable(python, modules) {
  if (modules.length === 0) return true
  const result = spawnSync(python, ['-c', `import ${modules.join(', ')}`], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
  return result.status === 0
}

/** 核心 pip 依赖是否可导入（三者缺一即视为未就绪）。 */
function depsReady(python) {
  return importable(python, CORE_DEPS)
}

/** 可选 pip 依赖（表格/版面）是否可导入。 */
function optionalDepsReady(python) {
  return importable(python, EXTRA_DEPS)
}

/** 安装 pip 依赖；已就绪则跳过（--force 重装）。默认源失败时回落清华镜像。 */
async function installPip() {
  const python = resolvePython()
  if (!FORCE && depsReady(python) && optionalDepsReady(python)) {
    log(`pip 依赖已就绪，跳过: ${[...CORE_DEPS, ...EXTRA_DEPS].join(' / ')}（--force 可重装）`)
    return
  }
  log(`安装 Python 依赖（解释器 ${python}）…`)
  try {
    await run(python, ['-m', 'pip', 'install', '-q', '-r', REQUIREMENTS])
  } catch (error) {
    log(`默认源安装失败（${error instanceof Error ? error.message : String(error)}）`)
    log(`回落镜像源: ${PIP_MIRROR}`)
    await run(python, ['-m', 'pip', 'install', '-q', '-r', REQUIREMENTS, '-i', PIP_MIRROR])
  }
  if (!depsReady(python)) {
    throw new Error(`pip 安装完成但仍无法导入核心依赖 ${CORE_DEPS.join(' / ')}`)
  }
  if (!optionalDepsReady(python)) {
    // 可选两件装不上不阻断主路（对齐设计 A-0「模型未装静默跳过」），给出告警即可
    log(`⚠ 可选依赖 ${EXTRA_DEPS.join(' / ')} 仍无法导入——表格/版面增强不可用（OCR 主路照常）`)
  }
  log('pip 依赖就绪')
}

/** 下载单个模型：校验通过才改名落位；失败清理 .part。 */
async function downloadModel(model) {
  const dest = join(MODELS_DIR, model.file)
  const url = model.url ?? `${MODEL_BASE}/${model.dir}/${model.file}`
  log(`下载（${model.role}）${url}`)

  const tmp = `${dest}.${randomUUID().slice(0, 8)}.part`
  let received = 0
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || res.body === null) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
    const total = Number(res.headers.get('content-length') ?? model.bytes ?? 0)
    await pipeline(
      res.body,
      async function* track(source) {
        for await (const chunk of source) {
          received += chunk.length
          if (total > 0 && received % (25 * 1024 * 1024) < chunk.length) {
            log(`  ${(received / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`)
          }
          yield chunk
        }
      },
      createWriteStream(tmp),
    )
    if (received !== model.bytes) {
      throw new Error(`大小校验失败: ${received} ≠ ${model.bytes}`)
    }
    const sha = await sha256File(tmp)
    if (sha !== model.sha256) {
      throw new Error(`SHA256 校验失败: ${sha} ≠ ${model.sha256}`)
    }
    await rename(tmp, dest)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  log(`完成（${model.role}）: ${model.file}（${(received / 1048576).toFixed(1)} MB，SHA256 通过）`)
}

/** 确保单个模型就位：已存在且字节数+SHA256 相符则跳过；不符则删除重下。 */
async function ensureModel(model) {
  const dest = join(MODELS_DIR, model.file)
  if (!FORCE && existsSync(dest)) {
    const info = await stat(dest)
    if (info.size === model.bytes && (await sha256File(dest)) === model.sha256) {
      log(`模型已就绪，跳过（${model.role}）: ${model.file}`)
      return
    }
    log(`模型不符（${model.role}，${info.size} ≠ ${model.bytes} 或 SHA256 不同），删除重下: ${model.file}`)
    await rm(dest, { force: true })
  }
  await downloadModel(model)
}

/** 空白归一（识别结果的行内空格/换行不可预期，比对前先抹掉）。 */
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, '')
}

/**
 * fixture 真自检：用真模型识别 fixture-1-zh.png，断言至少命中一个预期子串。
 * 只断「至少一个子串」是**刻意宽松**——OCR 质量会随模型/平台/版本波动，
 * 卡全量精确匹配会变成脆弱测试；但完全识别不出预期内容说明环境坏了，必须报错。
 */
async function selfTest() {
  const fixture = join(FIXTURES_DIR, 'fixture-1-zh.png')
  if (!existsSync(fixture)) throw new Error(`找不到自检样张：${fixture}`)
  if (!existsSync(EXPECTED_JSON)) throw new Error(`找不到预期子串表：${EXPECTED_JSON}`)

  const expected = JSON.parse(readFileSync(EXPECTED_JSON, 'utf-8'))
  const entry = expected.fixtures.find((f) => f.file === 'fixture-1-zh.png')
  if (entry === undefined) throw new Error(`${EXPECTED_JSON} 里没有 fixture-1-zh.png 的条目`)

  log('fixture 真自检（fixture-1-zh.png，真模型识别）…')
  const result = spawnSync(process.execPath, [OCR_TOOL, fixture, '--json'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(
      `OCR 自检运行失败（退出码 ${result.status}）：${errorLine(result.stderr) || firstLine(result.stdout)}`,
    )
  }

  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    throw new Error(`自检 stdout 不是合法 JSON：${firstLine(result.stdout)}`)
  }

  const text = payload?.pages?.[0]?.text ?? ''
  const flat = normalizeWhitespace(text)
  const hit = entry.substrings.find((s) => flat.includes(normalizeWhitespace(s)))
  if (hit === undefined) {
    throw new Error(
      `识别文本未命中任何预期子串（${entry.substrings.join(' / ')}）；实际识别：${flat.slice(0, 120)}`,
    )
  }
  log(`自检通过：命中预期子串「${hit}」`)
  log(`识别文本（第 1 页）：${flat}`)
  return text
}

/**
 * `--check`：轻量报告各项状态。
 *
 * **退出码 0 的判据只含核心项**（核心 pip 依赖 + 核心三件套模型 + `--fake` 自测）：
 * 可选两件（表格/版面）缺失时**报告状态但不置非零**——它们不阻断 OCR 主路，
 * 只是让 table/layout 增强回到旧输出（设计 A-0「模型未装静默跳过」）。
 */
async function checkOnly() {
  const python = resolvePython()
  log(`Python 解释器: ${python}`)

  const deps = spawnSync(python, ['-c', `import ${CORE_DEPS.join(', ')}`], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
  const depsOk = deps.status === 0
  log(
    `pip 依赖（核心）: ${depsOk ? '就绪' : '缺失'}（${CORE_DEPS.join(' / ')}）` +
      (depsOk ? '' : `——${errorLine(deps.stderr)}`),
  )

  const extras = spawnSync(python, ['-c', `import ${EXTRA_DEPS.join(', ')}`], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
  const extrasOk = extras.status === 0
  log(
    `pip 依赖（可选：表格/版面）: ${extrasOk ? '就绪' : '缺失'}（${EXTRA_DEPS.join(' / ')}）` +
      (extrasOk ? '' : `——${errorLine(extras.stderr)}`),
  )

  const modelStatus = new Map()
  for (const model of MODELS) {
    const dest = join(MODELS_DIR, model.file)
    let status
    if (!existsSync(dest)) {
      status = `缺失 → ${model.file}`
    } else {
      const info = await stat(dest)
      if (info.size !== model.bytes) {
        status = `大小不符（${info.size} ≠ ${model.bytes}）→ ${model.file}`
      } else if ((await sha256File(dest)) !== model.sha256) {
        status = `SHA256 不符 → ${model.file}`
      } else {
        status = `就绪 → ${model.file}`
      }
    }
    modelStatus.set(model, status)
    log(`模型(${model.role}${model.optional === true ? '，可选' : ''}): ${status}`)
  }
  const coreModelsOk = CORE_MODELS.every((m) => modelStatus.get(m).startsWith('就绪'))
  const extrasModelsOk = MODELS.filter((m) => m.optional === true).every((m) =>
    modelStatus.get(m).startsWith('就绪'),
  )

  let smokeOk = true
  if (existsSync(TEST_SMOKE)) {
    const smoke = spawnSync(python, [TEST_SMOKE], { cwd: ROOT, encoding: 'utf-8' })
    smokeOk = smoke.status === 0
    log(
      `--fake 自测: ${smokeOk ? '通过' : '失败'}` +
        (smokeOk ? '' : `——${errorLine(smoke.stdout) || errorLine(smoke.stderr)}`),
    )
  } else {
    log(`--fake 自测: 跳过（未找到 ${TEST_SMOKE}）`)
  }

  if (!extrasOk || !extrasModelsOk) {
    log(
      '提示: 表格/版面增强未就绪（可选）——扫描 PDF 的表格还原与多栏阅读顺序不可用，' +
        'OCR 主路照常。补齐请重跑 node scripts/setup-ocr.mjs',
    )
  }

  process.exitCode = depsOk && coreModelsOk && smokeOk ? 0 : 1
}

async function main() {
  if (CHECK_ONLY) {
    await checkOnly()
    return
  }

  await mkdir(MODELS_DIR, { recursive: true })

  try {
    if (SKIP_PIP) {
      log('--skip-pip：跳过 pip 依赖安装')
    } else {
      await installPip()
    }

    if (SKIP_MODELS) {
      log('--skip-models：跳过模型下载')
    } else {
      for (const model of MODELS) {
        if (model.optional === true) {
          // 可选两件（表格/版面）下载/校验失败**不阻断**主路——只告警，继续装核心件
          try {
            await ensureModel(model)
          } catch (error) {
            log(
              `⚠ 可选模型（${model.role}）未就绪：${error instanceof Error ? error.message : String(error)}` +
                '——表格/版面增强不可用，OCR 主路照常',
            )
          }
        } else {
          await ensureModel(model)
        }
      }
    }

    if (SKIP_SELFTEST) {
      log('--skip-selftest：跳过 fixture 真自检')
    } else {
      await selfTest()
    }

    log('\nOCR 环境就绪。知识库扫描件（图片 / 扫描 PDF）现在可经 OCR 转 Markdown。')
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    process.stderr.write(
      '[ocr-setup] 重新运行 pnpm run 3rd:setup 或 node scripts/setup-ocr.mjs 即可续传；\n' +
        '[ocr-setup] 已下载且 SHA256 校验通过的文件会自动跳过。\n',
    )
    process.exitCode = 1
  }
}

await main()
