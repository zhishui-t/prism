/**
 * v17 M-2：`prism_kb_convert`（MCP）/ `prism kb convert`（CLI）与 `prism_kb_import`（scan 路）
 * 的 **OCR 表格/版面配置响应必须一致**。
 *
 * 回归背景：`convert-file.ts` 原先调 `toMarkdown(bytes, path)` **不传 ocr 选项** → convert 路
 * 恒走 layout+table 增强，`ocr_table`/`ocr_layout`/`PRISM_OCR=off` 在此路失效；而 scan 路
 * （`scan.ts` 透传 `options.ocr`）受控——同产品两条转换路配置响应分裂。
 *
 * 断言口径（reviewer 钉死）：**同一 wiring 结论下，两条路传给 OCR runner 的
 * `--table/--no-table/--layout/--no-layout` flag 逐字一致**。flag 由真机构造器
 * `buildOcrToolArgs` 从 runner 实收选项还原，故断的是真实 argv 而不只是中间对象。
 *
 * R5：home 用临时目录（`resolveOcrWiringConfigForHome` 会读 `<home>/prism.yaml`）；
 * OCR 一律走注入 runner（真模型不进测试）。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  buildOcrToolArgs,
  countValidChars,
  setOcrHooks,
  type OcrRunOptions,
  type OcrRunner,
} from '@prism/knowledge'
import { afterEach, describe, expect, it } from 'vitest'

import { convertFileToMarkdown } from '../src/kb/convert-file.js'
import { scanProject } from '../src/kb/scan.js'
import { resolveOcrWiringConfig, resolveOcrWiringConfigForHome } from '../src/kb/wiring.js'
import { MemoryKb, makeTempDir, putFile } from './helpers.js'

/** OCR 正文（与 scan-ocr.test 同形）：有效字符 62（> 50），过 S3 少文本守卫。 */
const GOOD_OCR =
  '## 第 1 页\n\nPrism 知识库 OCR 样张：这是一段足够长的识别文本，用于通过有效字符阈值。' +
  '第二行继续补充识别内容，确保有效字符数超过阈值下限。'

/** 真机 argv 里的四类 table/layout flag（其余是工具路径与输入路径，不参与本断言）。 */
const FLAG_TOKENS = new Set(['--table', '--no-table', '--layout', '--no-layout'])

/** 由 runner 实收选项还原真实 argv 的 table/layout flag（同一构造器 `buildOcrToolArgs`）。 */
function ocrFlags(input: string, options: OcrRunOptions = {}): string[] {
  return buildOcrToolArgs(input, options).filter((a) => FLAG_TOKENS.has(a))
}

/** 注入 OCR（就绪 + 记录每次调用的 flag）。 */
function useOcrCapture(): { flags: string[][] } {
  const flags: string[][] = []
  const run: OcrRunner = async (input, options) => {
    flags.push(ocrFlags(input, options))
    return { ok: true, markdown: GOOD_OCR }
  }
  setOcrHooks({ available: () => true, run })
  return { flags }
}

/** 建一个含单张 `.png` 的临时项目（png 走 OCR 路由；字节内容与断言无关）。 */
async function makePngProject(prefix: string): Promise<{ root: string; png: string }> {
  const root = await makeTempDir(prefix)
  const png = await putFile(join(root, 'logo.png'), 'PNG')
  return { root, png }
}

/** 走 convert 路，返回它这一路传出的 flag。 */
async function viaConvert(
  png: string,
  ocr?: { table: boolean; layout: boolean },
): Promise<string[] | undefined> {
  const cap = useOcrCapture()
  await convertFileToMarkdown(png, ocr !== undefined ? { ocr } : {})
  return cap.flags.at(-1)
}

/** 走 scan 路（`prism_kb_import` 同款），返回它这一路传出的 flag。 */
async function viaScan(
  root: string,
  ocr?: { table: boolean; layout: boolean },
): Promise<string[] | undefined> {
  const cap = useOcrCapture()
  await scanProject(new MemoryKb(), {
    root,
    owner: 'p',
    book: 'p',
    ...(ocr !== undefined ? { ocr } : {}),
  })
  return cap.flags.at(-1)
}

afterEach(() => {
  setOcrHooks(null)
})

describe('convert 路与 scan 路的 OCR flag 一致性（v17 M-2）', () => {
  it('夹具自检：注入正文真的过 S3 守卫（否则 scan 短路会假绿）', () => {
    expect(countValidChars(GOOD_OCR)).toBeGreaterThan(50)
  })

  it('同一 wiring 结论（两件模型在位、缺省开）→ 两路都传 --table --layout 且逐字一致', async () => {
    const cfg = resolveOcrWiringConfig({ tableModelReady: true, layoutModelReady: true })
    expect(cfg).toEqual({ ocr: { table: true, layout: true }, enabled: true, warnings: [] })

    const a = await makePngProject('prism-conv-ocr-on-a-')
    const b = await makePngProject('prism-conv-ocr-on-b-')
    const convertFlags = await viaConvert(a.png, cfg.ocr)
    const scanFlags = await viaScan(b.root, cfg.ocr)

    expect(convertFlags).toEqual(['--table', '--layout'])
    expect(scanFlags).toEqual(convertFlags) // ← 两路逐字一致（M-2 的核心断言）
  })

  it('wiring enabled=false（home 的 ocr_table=off）→ 两路一致回落 --no-table --no-layout', async () => {
    const home = await makeTempDir('prism-conv-ocr-home-')
    await writeFile(join(home, 'prism.yaml'), 'ocr_table: off\n', 'utf-8')
    const cfg = resolveOcrWiringConfigForHome(home)
    expect(cfg.enabled).toBe(false)
    expect(cfg.ocr).toEqual({ table: false, layout: false })

    const a = await makePngProject('prism-conv-ocr-off-a-')
    const b = await makePngProject('prism-conv-ocr-off-b-')
    const convertFlags = await viaConvert(a.png, cfg.ocr)
    const scanFlags = await viaScan(b.root, cfg.ocr)

    expect(convertFlags).toEqual(['--no-table', '--no-layout']) // ← 都不传开启 flag
    expect(scanFlags).toEqual(convertFlags)
  })

  it('不传 ocr（undefined）→ 两路都按缺省两开（未引入第二套缺省）', async () => {
    const a = await makePngProject('prism-conv-ocr-def-a-')
    const b = await makePngProject('prism-conv-ocr-def-b-')
    const convertFlags = await viaConvert(a.png)
    const scanFlags = await viaScan(b.root)

    expect(convertFlags).toEqual(['--table', '--layout'])
    expect(scanFlags).toEqual(convertFlags)
  })
})
