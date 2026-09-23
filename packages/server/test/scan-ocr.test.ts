/**
 * OCR 接入（v14 波次 2 · B-4 / SPEC-3.1–3.6）。**scan 侧**（`packages/server/src/kb/scan.ts`）：
 *
 * 1. **图片白名单（S2）**：OCR 就绪时 png/jpg/jpeg/webp 进**条件派生集**（`DOC_ONLY_EXTENSIONS`
 *    常量不动），转换层按扩展名路由到 OCR；OCR 未就绪时图片与从前一模一样（扩展门挡下）。
 * 2. **少文本守卫（S3）**：**只卡 OCR 出来的正文**——有效字符 < 50 → 跳过 + `no_text_detected`
 *    （图片与整本 PDF 同口径；普通 anydoc 转换与纯文本直读不设阈值）。
 * 3. **幂等短路（M3）**：**转换前**按 `idFromRel` 查已有条目、source_hash 相同即 `unchanged`
 *    ——OCR 是秒级/页的重活，不能每次重扫都为未变文件重跑。
 * 4. **未装零变化（SPEC-3.2）**：OCR 未就绪的机器上，图片仍旧「扩展不在扫描集」。
 *
 * R5：项目根/知识库都是临时目录；OCR 一律走**注入的 runner**（真模型不进测试），
 * 唯一一处真机用例（`真机` 段）条件跳过。图片字节直接复用 B-3 的 fixture（只读）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MIN_OCR_VALID_CHARS,
  PrismKnowledgeService,
  countValidChars,
  setOcrHooks,
  type OcrRunner,
} from '@prism/knowledge'
import { afterEach, describe, expect, it } from 'vitest'

import {
  OCR_SCAN_EXTENSIONS,
  SKIP_REASONS,
  makeDryRunKb,
  scanProject,
  type ScanOptions,
} from '../src/kb/scan.js'
import {
  parseOcrFlag,
  resolveOcrWiringConfig,
  resolveOcrWiringConfigForHome,
} from '../src/kb/wiring.js'
import { MemoryKb, imageOnlyPdf, makeTempDir, putFile } from './helpers.js'

const FIXTURES = fileURLToPath(new URL('../../../3rd/ocr/fixtures/', import.meta.url))
const TINY = join(FIXTURES, 'fixture-3-tiny.png')
const ZH = join(FIXTURES, 'fixture-1-zh.png')

/** OCR 正文（图片 / 扫描 PDF 同一种形态：`## 第 N 页` + 文本）。有效字符 62（> 50）。 */
const GOOD_OCR =
  '## 第 1 页\n\nPrism 知识库 OCR 样张：这是一段足够长的识别文本，用于通过有效字符阈值。' +
  '第二行继续补充识别内容，确保有效字符数超过阈值下限。'
/** 有效字符 6（第/页/1 + 小样张）；剥页头后 3 → 无论剥不剥都低于 50。 */
const TINY_OCR = '## 第 1 页\n\n小样张'

/** 建临时项目并写文本文件（自动建父目录）。 */
async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await makeTempDir('prism-scan-ocr-')
  for (const [rel, content] of Object.entries(files)) {
    await putFile(join(root, ...rel.split('/')), content)
  }
  return root
}

/** 把二进制（真图片字节）写进项目。 */
async function putBinary(root: string, rel: string, bytes: Buffer): Promise<string> {
  const abs = join(root, ...rel.split('/'))
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, bytes)
  return abs
}

/** 注入 OCR（返回调用过的入参列表，便于断言「有没有重跑 OCR」）。 */
function useOcr(available: boolean, markdown: string = GOOD_OCR): { calls: string[] } {
  const calls: string[] = []
  const run: OcrRunner = async (input) => {
    calls.push(input)
    return { ok: true, markdown }
  }
  setOcrHooks({ available: () => available, run })
  return { calls }
}

function scan(root: string, kb: MemoryKb, extra: Partial<ScanOptions> = {}): ReturnType<typeof scanProject> {
  return scanProject(kb, { root, owner: 'p', book: 'p', ...extra })
}

afterEach(() => {
  setOcrHooks(null)
})

describe('图片条件派生集（S2 / SPEC-3.3）', () => {
  it('OCR 就绪 → 图片进候选，一图一条目：type=doc、title=文件名、module 按目录', async () => {
    const tiny = await readFile(TINY)
    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    await putBinary(root, 'img/logo.png', tiny)
    useOcr(true)
    // 夹具自检：注入的正文必须真的过阈值，否则本用例是空转（会被守卫挡下反而假绿）
    expect(countValidChars(GOOD_OCR)).toBeGreaterThan(50)

    const kb = new MemoryKb()
    const report = await scan(root, kb)

    expect(report.discovered).toBe(2) // README.md + img/logo.png
    expect(report.created).toBe(2)
    expect(report.skipped).toBe(0)
    expect(report.files.map((f) => f.rel).sort()).toEqual(['README.md', 'img/logo.png'])

    // SPEC-3.6：一图一条目（现有模型零改动）——正文来自 OCR，元数据仍按既有口径推断
    const entry = await kb.get('IDX-img-logo')
    expect(entry).not.toBeNull()
    expect(entry?.type).toBe('doc')
    expect(entry?.title).toBe('logo') // OCR 正文只有 `## 第 N 页`（不是 `# ` 一级标题）→ 回落文件名
    expect(entry?.module).toBe('img')
    expect(entry?.content).toContain('Prism 知识库')
    // 入库链照旧：图片条目一样进检索面
    expect((await kb.search({ q: '识别文本' })).map((r) => r.id)).toContain('IDX-img-logo')
  })

  it('OCR 未就绪 → 图片与从前一致（扩展不在扫描集，不入候选、不转换）', async () => {
    const tiny = await readFile(TINY)
    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    await putBinary(root, 'img/logo.png', tiny)
    const ocr = useOcr(false)

    const kb = new MemoryKb()
    const report = await scan(root, kb)

    expect(report.discovered).toBe(1)
    expect(report.files.map((f) => f.rel)).toEqual(['README.md'])
    expect(report.by_skip_reason[SKIP_REASONS.extNotIncluded]).toBe(1)
    expect(ocr.calls).toEqual([]) // 未就绪 → 连请求都不该发
    expect(await kb.get('IDX-img-logo')).toBeNull()
  })

  it('派生集只含四类图片扩展，且不污染 DOC_ONLY 常量', async () => {
    expect([...OCR_SCAN_EXTENSIONS].sort()).toEqual(['.jpeg', '.jpg', '.png', '.webp'])
    const { DOC_ONLY_EXTENSIONS } = await import('../src/kb/scan.js')
    for (const ext of OCR_SCAN_EXTENSIONS) expect(DOC_ONLY_EXTENSIONS).not.toContain(ext)
  })

  it('include_ext 纳入的图片：就绪时与派生白名单同路（走 OCR，不当文本解码）；未就绪时维持现状', async () => {
    const tiny = await readFile(TINY)
    const root = await makeProject({ 'logo.png': '' })
    await putBinary(root, 'logo.png', tiny)

    // ① 就绪 + 显式 include_ext：结果与「只靠派生集」逐字节一致（同一份报告）
    const on = useOcr(true)
    const kbOn = new MemoryKb()
    const withInclude = await scan(root, kbOn, { includeExt: ['png'] })
    const bare = await scan(root, new MemoryKb())
    expect(JSON.stringify({ ...withInclude, root: '' })).toBe(JSON.stringify({ ...bare, root: '' }))
    expect(on.calls.length).toBe(2) // 两次扫描各一次
    expect(bare.discovered).toBe(1)

    setOcrHooks(null)
    // ② 未就绪 + 显式 include_ext：落回**纯文本直读**那条老路（二进制解码失败），
    //    不是 ext_not_included——include_ext 的作用没有被 OCR 改动
    useOcr(false)
    const off = await scan(root, new MemoryKb(), { includeExt: ['png'] })
    expect(off.discovered).toBe(1)
    expect(off.by_skip_reason[SKIP_REASONS.decodeFailed]).toBe(1)
    expect(off.by_skip_reason[SKIP_REASONS.extNotIncluded]).toBeUndefined()
  })
})

describe('少文本守卫（S3 / SPEC-3.4）', () => {
  it('OCR 正文有效字符 < 50 → 跳过 + no_text_detected，且不落库', async () => {
    const tiny = await readFile(TINY)
    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    await putBinary(root, 'img/blank.png', tiny)
    useOcr(true, TINY_OCR)

    const kb = new MemoryKb()
    const report = await scan(root, kb)

    expect(report.created).toBe(1) // 只有 README.md
    expect(report.skipped).toBe(1)
    expect(report.by_skip_reason[SKIP_REASONS.noTextDetected]).toBe(1)
    const skipped = report.files.find((f) => f.rel === 'img/blank.png')
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.reason).toContain('有效字符不足')
    expect(await kb.get('IDX-img-blank')).toBeNull()
  })

  it('守卫只卡 OCR 正文：普通 anydoc 转换与文本直读的短文档照常入库', async () => {
    // 两字的 md（有效字符 2 < 50）、极短的 csv 都该照常入库
    const root = await makeProject({ 'a.md': '# 短', 'b.csv': 'id\n1\n' })
    useOcr(true, TINY_OCR)

    const kb = new MemoryKb()
    const report = await scan(root, kb)
    expect(report.created).toBe(2)
    expect(report.by_skip_reason[SKIP_REASONS.noTextDetected]).toBeUndefined()
  })

  it('回归（波次3/A.1）：多页全空白 PDF 靠页头/占位符堆不过阈值 → 整本 no_text_detected', async () => {
    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    await putBinary(root, 'docs/blank.pdf', Buffer.from(imageOnlyPdf()))
    // 20 页全空白：每页 = 页头 `## 第 N 页` + 占位符 `（未检出文本）`
    const blank = Array.from({ length: 20 }, (_, i) => `## 第 ${i + 1} 页\n\n（未检出文本）`).join('\n\n')
    // 前提（非空转）：不剥的话，光噪声就压过 50 —— 守卫会因「页数多」而假通过
    expect(countValidChars(blank)).toBeGreaterThanOrEqual(MIN_OCR_VALID_CHARS)
    useOcr(true, blank)

    const kb = new MemoryKb()
    const report = await scan(root, kb)

    expect(report.created).toBe(1) // 只有 README.md
    expect(report.by_skip_reason[SKIP_REASONS.noTextDetected]).toBe(1)
    const skipped = report.files.find((f) => f.rel === 'docs/blank.pdf')
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.reason).toContain('有效字符不足')
    expect(await kb.get('IDX-docs-blank')).toBeNull()
  })
})

describe('幂等短路：转换前比 source_hash（M3 / SPEC-3.5）', () => {
  it('同 hash 二次 scan 不再转换（OCR 不重跑）；源变了才重转', async () => {
    const tiny = await readFile(TINY)
    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    const png = await putBinary(root, 'img/scan.png', tiny)
    const ocr = useOcr(true)

    const kb = new MemoryKb()
    const first = await scan(root, kb)
    expect(first.created).toBe(2)
    expect(ocr.calls).toEqual([png]) // 新建：转一次

    const second = await scan(root, kb)
    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(2)
    expect(ocr.calls).toEqual([png]) // ← 短路生效：一次都没再转

    // 源内容变了（同路径、不同字节）→ 重转
    await writeFile(png, Buffer.concat([tiny, Buffer.from([0])]))
    const third = await scan(root, kb)
    expect(third.updated).toBe(1)
    expect(third.unchanged).toBe(1)
    expect(ocr.calls).toEqual([png, png])
  })

  it('dry-run：新 OCR 文件仍真跑转换以出报告；**未变**的 OCR 文件不再跑（语义变化已声明）', async () => {
    const tiny = await readFile(TINY)
    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    const png = await putBinary(root, 'img/scan.png', tiny)
    const ocr = useOcr(true)

    // dry-run 必须用**真实服务**：`makeDryRunKb` 以 `Object.create(real)` 包装（只覆写
    // index），内存桩的私有字段经原型链的接收者访问会抛错（桩不是等价替身）
    const home = await makeTempDir('prism-scan-ocr-home-')
    const real = new PrismKnowledgeService({ home })
    try {
      await scanProject(real, { root, owner: 'p', book: 'p' })
      expect(ocr.calls).toEqual([png])

      // 未变的 OCR 文件：dry-run 不再执行转换验证（M3 的短路在 dry-run 下同样生效）
      const dry = await scanProject(makeDryRunKb(real), { root, owner: 'p', book: 'p' })
      expect(dry.created).toBe(0)
      expect(dry.unchanged).toBe(2)
      expect(ocr.calls).toEqual([png]) // ← 一次都没再转
    } finally {
      real.close()
    }
  })
})

/** 扫描 PDF 的 OCR 正文（多页小节；有效字符 ~82 > 50，夹具自检见用例内断言）。 */
const PDF_OCR =
  '## 第 1 页\n\n扫描件正文：这是图片型 PDF 经 OCR 识别出来的内容，长度足以通过守卫阈值下限。' +
  '第二页同样识别完成，内容也一并写进同一个条目的 Markdown 正文里，供后续切分与检索使用。'

describe('扫描 PDF 管道（SPEC-3.1/3.2）', () => {
  it('图片型 PDF + OCR 就绪 → `## 第 N 页` 正文正常入库（不再报 needs_ocr）', async () => {
    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    await putBinary(root, 'docs/scan.pdf', Buffer.from(imageOnlyPdf()))
    useOcr(true, PDF_OCR)
    expect(countValidChars(PDF_OCR)).toBeGreaterThan(50) // 夹具自检：别让守卫把用例变成空转

    const kb = new MemoryKb()
    const report = await scan(root, kb)

    expect(report.created).toBe(2)
    expect(report.by_skip_reason[SKIP_REASONS.needsOcr]).toBeUndefined()
    const entry = await kb.get('IDX-docs-scan')
    expect(entry?.content).toContain('## 第 1 页')
    expect(entry?.content).toContain('扫描件正文')
    // 入库链照旧：条目可被检索（正文进了索引，不是只挂在报告里）
    expect((await kb.search({ q: '扫描件正文' })).map((r) => r.id)).toContain('IDX-docs-scan')
  })

  it('图片型 PDF + OCR 未就绪 → needs_ocr，逐文件文案是 anydoc 原话（行为零变化）', async () => {
    const root = await makeProject({ 'docs/scan.pdf': '' })
    await putBinary(root, 'docs/scan.pdf', Buffer.from(imageOnlyPdf()))
    const ocr = useOcr(false)

    const report = await scan(root, new MemoryKb())

    expect(report.discovered).toBe(1)
    expect(report.skipped).toBe(1)
    expect(report.by_skip_reason[SKIP_REASONS.needsOcr]).toBe(1)
    expect(report.files[0]?.reason).toBe('page 1 of 1 needs OCR') // anydoc 原话，逐字
    expect(ocr.calls).toEqual([])
  })
})

describe('跳过文案带出 OCR 失败原因（D-v14-tester-1）', () => {
  /** 就绪但 runner 失败：「装了 OCR 但坏了」不能与「没装」同貌。 */
  function useFailingOcr(reason: string): void {
    setOcrHooks({ available: () => true, run: async () => ({ ok: false, reason }) })
  }

  it('图片：回落文案逐字在内 + 失败原因后缀，分类键不变', async () => {
    const tiny = await readFile(TINY)
    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    await putBinary(root, 'img/logo.png', tiny)
    useFailingOcr('模型缺失')

    const report = await scan(root, new MemoryKb())
    const skipped = report.files.find((f) => f.rel === 'img/logo.png')

    expect(skipped?.status).toBe('skipped')
    expect(skipped?.reason).toContain('不支持的扩展名: .png') // SPEC-3.2 的回落文案仍在
    expect(skipped?.reason).toContain('OCR 调用失败：模型缺失') // 原因可观测
    expect(report.by_skip_reason[SKIP_REASONS.convertFailed]).toBe(1) // 键与计数不受影响
  })

  it('扫描 PDF：needs_ocr 原话加后缀；未就绪路径仍逐字无后缀（SPEC-3.2）', async () => {
    const root = await makeProject({})
    await putBinary(root, 'docs/scan.pdf', Buffer.from(imageOnlyPdf()))

    useFailingOcr('boom')
    const failed = await scan(root, new MemoryKb())
    expect(failed.files[0]?.reason).toBe('page 1 of 1 needs OCR（OCR 调用失败：boom）')
    expect(failed.by_skip_reason[SKIP_REASONS.needsOcr]).toBe(1)

    useOcr(false)
    const off = await scan(root, new MemoryKb())
    expect(off.files[0]?.reason).toBe('page 1 of 1 needs OCR') // 未装不是失败 → 逐字不变
  })
})

describe('真机（条件跳过：需要 3rd/ocr 模型 + pip 依赖）', () => {
  it('真模型：zh 图过阈值入库、tiny 图被守卫挡下', async (ctx) => {
    const { ocrAvailable } = await import('@prism/knowledge')
    if (!(await ocrAvailable())) return ctx.skip() // 未装模型/pip 依赖的机器跳过

    const zh = await readFile(ZH)
    const tiny = await readFile(TINY)
    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    await putBinary(root, 'img/zh.png', zh)
    await putBinary(root, 'img/tiny.png', tiny)

    const kb = new MemoryKb()
    const report = await scan(root, kb)

    const zhEntry = await kb.get('IDX-img-zh')
    expect(zhEntry?.content).toContain('## 第 1 页')
    expect(zhEntry?.content).toContain('知识库') // fixture-1 的预期子串（expected.json）
    expect(await kb.get('IDX-img-tiny')).toBeNull()
    expect(report.by_skip_reason[SKIP_REASONS.noTextDetected]).toBe(1)
  }, 300_000)
})

// ---------------------------------------------------------------------------
// v17 B-A1：OCR 表格/版面扁平键（`ocr_table` / `ocr_layout`）与 scan 透传
// ---------------------------------------------------------------------------

describe('OCR 增强装配（v17 A-0 / SPEC-A1.2、A2.3）', () => {
  it('parseOcrFlag：缺省开 / 显式 on-off / 非法值告警回落', () => {
    expect(parseOcrFlag(undefined, true)).toBe(true)
    expect(parseOcrFlag('', true)).toBe(true)
    for (const on of ['on', 'ON', 'true', '1', ' on ']) expect(parseOcrFlag(on, true)).toBe(true)
    for (const off of ['off', 'OFF', 'false', '0', ' off ']) expect(parseOcrFlag(off, true)).toBe(false)

    const warnings: string[] = []
    expect(parseOcrFlag('yes', true, 'ocr_table', warnings)).toBe(true) // 非法 → 回落缺省
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('ocr_table')
    expect(warnings[0]).toContain('yes')
  })

  it('resolveOcrWiringConfig：两键都开 + 两件模型在位才启用（否则回旧输出）', () => {
    // 缺省（未配置）→ 开；模型都在位 → enabled
    expect(resolveOcrWiringConfig({ tableModelReady: true, layoutModelReady: true })).toEqual({
      ocr: { table: true, layout: true },
      enabled: true,
      warnings: [],
    })
    // ocr_table=false → 整个增强关（layout 也关，保证逐字回旧输出）
    expect(
      resolveOcrWiringConfig({ table: 'off', tableModelReady: true, layoutModelReady: true }),
    ).toEqual({ ocr: { table: false, layout: false }, enabled: false, warnings: [] })
    // ocr_layout=false → 同样全关（没有 layout 就没有 table 区域）
    expect(
      resolveOcrWiringConfig({ layout: 'off', tableModelReady: true, layoutModelReady: true }).enabled,
    ).toBe(false)
    // 模型缺一 → 关
    expect(resolveOcrWiringConfig({ tableModelReady: true, layoutModelReady: false }).enabled).toBe(false)
    expect(resolveOcrWiringConfig({}).enabled).toBe(false) // 两件都未就绪（缺省 readiness=false）
    // 非法值告警合并
    const warnings: string[] = []
    resolveOcrWiringConfig({ table: 'maybe', layout: 'nope', warnings })
    expect(warnings).toHaveLength(2)
  })

  it('resolveOcrWiringConfigForHome：ocr_table=off 时无论模型在不在都关（读 prism.yaml 单点）', async () => {
    const home = await makeTempDir('prism-ocr-home-')
    await writeFile(join(home, 'prism.yaml'), 'ocr_table: off\n', 'utf-8')
    expect(resolveOcrWiringConfigForHome(home).enabled).toBe(false)
  })

  it('scan：ocr 选项透传到 runner（缺省都开；显式关才关）', async () => {
    const tiny = await readFile(TINY)
    const seen: Array<{ table?: boolean; layout?: boolean } | undefined> = []
    const run: OcrRunner = async (_input, options) => {
      seen.push(options)
      return { ok: true, markdown: GOOD_OCR }
    }
    setOcrHooks({ available: () => true, run })

    const root = await makeProject({ 'README.md': '# 项目\n\n说明。' })
    await putBinary(root, 'img/logo.png', tiny)

    await scan(root, new MemoryKb(), { ocr: { table: false, layout: false } })
    await scan(root, new MemoryKb()) // 缺省（不传 ocr）→ 都开
    // dry-run 也会真跑转换（未变文件才短路）——此处两个 kb 都是空的，各跑一次

    expect(seen).toEqual([
      { table: false, layout: false },
      { table: true, layout: true },
    ])
  })
})
