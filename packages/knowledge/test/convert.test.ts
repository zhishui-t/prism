import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CONVERTIBLE_EXTENSIONS,
  EMBEDDED_IMAGE_MEDIA_TYPES,
  MIN_OCR_VALID_CHARS,
  OCR_IMAGE_EXTENSIONS,
  OCR_LAYOUT_MODEL_FILE,
  OCR_TABLE_MODEL_FILE,
  TEXT_EXTENSIONS,
  buildOcrToolArgs,
  countValidChars,
  extensionOf,
  isSupported,
  ocrAvailable,
  ocrLayoutModelReady,
  ocrModelCount,
  ocrModelsReady,
  ocrTableModelReady,
  parseOcrOff,
  runOcrTool,
  setOcrHooks,
  stripOcrArtifacts,
  toMarkdown,
} from '../src/convert.js'
// 图片型 PDF fixture 与 server 侧 scan 测试共用一份（见 helpers.ts 的说明）
import { imageOnlyPdf } from '../../server/test/helpers.js'

/** 构造最小合法 docx（zip：Content_Types + rels + document.xml）。 */
function minimalDocx(text: string): Uint8Array {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>${text}</w:t></w:r></w:p>
</w:body></w:document>`
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  return zipStore([
    ['[Content_Types].xml', ct],
    ['_rels/.rels', rels],
    ['word/document.xml', doc],
  ])
}

/** 最小 ZIP（store 方式，无压缩）——足够 anydoc 读取。 */
function zipStore(entries: Array<[string, string]>): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf-8')
    const nameBuf = Buffer.from(name, 'utf-8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(0, 10) // store
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return new Uint8Array(Buffer.concat([...chunks, centralBuf, end]))
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('格式分流（A2）', () => {
  it('extensionOf 取小写扩展名', () => {
    expect(extensionOf('a/b/README.MD')).toBe('.md')
    expect(extensionOf('docs/设计.docx')).toBe('.docx')
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
  })

  it('isSupported 覆盖文本与可转换格式，拒绝无关扩展名', () => {
    for (const ext of [...TEXT_EXTENSIONS, ...CONVERTIBLE_EXTENSIONS]) {
      expect(isSupported(`x${ext}`)).toBe(true)
    }
    expect(isSupported('x.png')).toBe(false)
    expect(isSupported('x.exe')).toBe(false)
  })

  it('文本类直接读原文，不调用 anydoc', async () => {
    const bytes = new TextEncoder().encode('# 标题\n\n正文')
    const result = await toMarkdown(bytes, 'docs/a.md')
    expect(result.status).toBe('text')
    expect(result.markdown).toContain('正文')
    expect(result.elapsed_ms).toBeUndefined()
  })

  it('txt / html 同样直读', async () => {
    expect((await toMarkdown(new TextEncoder().encode('plain'), 'a.txt')).status).toBe('text')
    expect((await toMarkdown(new TextEncoder().encode('<p>x</p>'), 'a.html')).status).toBe('text')
  })

  it('docx 经 anydoc 转 Markdown（真实转换）', async () => {
    const result = await toMarkdown(minimalDocx('Prism 测试文档'), 'docs/测试.docx')
    expect(result.status).toBe('converted')
    expect(result.markdown).toContain('Prism 测试文档')
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0)
  })

  it('csv 转成 Markdown 表格', async () => {
    const csv = new TextEncoder().encode('id,title\nJAVA-01,禁止吞异常\n')
    const result = await toMarkdown(csv, 'rules.csv')
    expect(result.status).toBe('converted')
    expect(result.markdown).toContain('| id | title |')
  })

  it('不支持的扩展名 → unsupported（不抛）', async () => {
    const result = await toMarkdown(new Uint8Array([1, 2, 3]), 'x.png')
    expect(result.status).toBe('unsupported')
    expect(result.reason).toContain('.png')
  })

  it('损坏的 docx → failed 或 needs_ocr（不抛，调用方可跳过）', async () => {
    const result = await toMarkdown(new Uint8Array([0, 1, 2, 3]), 'broken.docx')
    expect(['failed', 'needs_ocr']).toContain(result.status)
    expect(result.markdown).toBe('')
  })
})

// ---------------------------------------------------------------------------
// OCR（v14 B-4 / SPEC-3.1–3.4）
// ---------------------------------------------------------------------------

/** 无 BOM 的 utf-8 字节。 */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** 注入 OCR 钩子（真机探测会让结果随本机装没装模型漂移——测试必须钉死）。 */
function useOcr(available: boolean, run: (input: string) => Promise<{ ok: true; markdown: string } | { ok: false; reason: string }>): string[] {
  const calls: string[] = []
  setOcrHooks({
    available: () => available,
    run: async (input) => {
      calls.push(input)
      return run(input)
    },
  })
  return calls
}

afterEach(() => {
  setOcrHooks(null)
})

describe('OCR 就绪探测（模型三件 + 依赖可导入）', () => {
  it('ocrModelsReady：平铺目录下至少三个 .onnx 才算就绪', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-ocr-models-'))
    try {
      expect(ocrModelsReady(join(dir, 'nope'))).toBe(false) // 目录不存在
      expect(ocrModelsReady(dir)).toBe(false) // 空目录
      await writeFile(join(dir, 'a.onnx'), 'x')
      await writeFile(join(dir, 'b.onnx'), 'x')
      await writeFile(join(dir, 'c.onnx.part'), 'x') // 断点续传中途：不算一件
      await writeFile(join(dir, 'notes.txt'), 'x') // 非 onnx 不算
      expect(ocrModelsReady(dir)).toBe(false)
      await writeFile(join(dir, 'd.onnx'), 'x')
      expect(ocrModelsReady(dir)).toBe(true)
      // 件数（doctor 的 ocr 行用它显示「下到一半」）与就绪**同一个筛子**
      expect(ocrModelCount(dir)).toBe(3)
      expect(ocrModelCount(join(dir, 'nope'))).toBe(0) // 目录不存在 → 0 件
      // 角色子目录**不算**——ocr_main.py 的 MODEL_FILES 是平铺布局
      await mkdir(join(dir, 'det'), { recursive: true })
      await writeFile(join(dir, 'det', 'x.onnx'), 'x')
      expect(ocrModelsReady(join(dir, 'det'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ocrAvailable：注入优先于真机探测；还原后回落到真实探测（布尔，不抛）', async () => {
    setOcrHooks({ available: () => false, run: async () => ({ ok: false, reason: 'nope' }) })
    expect(await ocrAvailable()).toBe(false)
    setOcrHooks({ available: () => true, run: async () => ({ ok: true, markdown: 'x' }) })
    expect(await ocrAvailable()).toBe(true)
    setOcrHooks(null)
    expect(typeof (await ocrAvailable())).toBe('boolean')
  })
})

describe('少文本守卫谓词（SPEC-3.4 / S3）', () => {
  it('CJK 计 1 + [A-Za-z0-9] 计 1；空白/标点计 0', () => {
    expect(countValidChars('中文ABC123')).toBe(8)
    expect(countValidChars('  \n\t,.;:!?（）【】——…')).toBe(0)
    expect(countValidChars('')).toBe(0)
    expect(countValidChars('Prism 知识库')).toBe(8) // 5 + 3
    // OCR 正文是**带我们自己的 `## 第 N 页` 小节头**的 markdown——小节头也计入
    // （fixture-3 的识别文本 `小样张 PRISM` = 8，加上 `## 第 1 页` 的 3 个汉字）
    expect(countValidChars('## 第 1 页\n\n小样张 PRISM')).toBe(11)
  })

  it('阈值是单值 50（不分语种），且导出给 server 侧复用', () => {
    expect(MIN_OCR_VALID_CHARS).toBe(50)
    expect(countValidChars('x'.repeat(49))).toBeLessThan(MIN_OCR_VALID_CHARS)
    expect(countValidChars('x'.repeat(50))).toBeGreaterThanOrEqual(MIN_OCR_VALID_CHARS)
  })
})

describe('剥 OCR 管道段落标记（波次 3 / A.1）', () => {
  it('剥掉页头行与空白页占位符，正文原样保留', () => {
    const md = '## 第 1 页\n\n（未检出文本）\n\n## 第 2 页\n\n真正的正文 PRISM'
    const kept = stripOcrArtifacts(md)
    // 非空行只剩正文本身（页头/占位符都消失）
    expect(kept.split('\n').filter((l) => l.trim() !== '')).toEqual(['真正的正文 PRISM'])
    expect(kept).not.toContain('## 第')
    expect(kept).not.toContain('（未检出文本）')
    // 守卫计数 = 纯正文的计数（页头/占位符一个都不算）
    expect(countValidChars(kept)).toBe(countValidChars('真正的正文 PRISM'))
  })

  it('只认整行形态：非精确匹配的标题/正文行一律保留', () => {
    const cases = [
      '## 第 1 页 后续', // 行尾有别的字 → 不是本管道形态
      '### 第 1 页', // 三级标题
      '## 第 页', // 没有页码
      '## 第 1 章', // 不是「页」
      '正文里的 ## 第 1 页', // 不在行首
      '## 第 1 页附注', // 无空格
    ]
    for (const line of cases) {
      expect(stripOcrArtifacts(line), line).toBe(line)
    }
  })

  it('回归：多页全空白 PDF 不再堆过阈值（不剥就会假通过）', () => {
    // 20 页全空白：每页 = 页头 `## 第 N 页` + 占位符 `（未检出文本）`
    const blank = Array.from({ length: 20 }, (_, i) => `## 第 ${i + 1} 页\n\n（未检出文本）`).join('\n\n')
    // 前提：不剥的话，光噪声就压过 50（守卫会因「页数多」而假通过）
    expect(countValidChars(blank)).toBeGreaterThanOrEqual(MIN_OCR_VALID_CHARS)
    // 剥掉后：一个有效字符都不剩 → 必然 < 50 → 整本记 no_text_detected
    expect(countValidChars(stripOcrArtifacts(blank))).toBe(0)
    expect(countValidChars(stripOcrArtifacts(blank))).toBeLessThan(MIN_OCR_VALID_CHARS)
  })

  it('正常多页文档：剥头后仍过阈值（不误杀真文档）', () => {
    const body = '这一段是识别出来的正文，长度足够撑过阈值下限。'
    const doc = Array.from({ length: 3 }, (_, i) => `## 第 ${i + 1} 页\n\n${body}`).join('\n\n')
    expect(countValidChars(stripOcrArtifacts(doc))).toBeGreaterThanOrEqual(MIN_OCR_VALID_CHARS)
  })
})

describe('PRISM_OCR=off 降级开关（波次 3 / A.2）', () => {
  it('off/0/false 认（大小写与空白容错）；其余不认', () => {
    for (const v of ['off', 'OFF', ' off ', 'Off', '0', 'false', 'False']) {
      expect(parseOcrOff(v), v).toBe(true)
    }
    for (const v of [undefined, '', 'on', '1', 'true', 'yes', 'no']) {
      expect(parseOcrOff(v), String(v)).toBe(false)
    }
  })

  it('env 置 off → ocrAvailable 恒 false（env 门在探测缓存之前）', async () => {
    const saved = process.env['PRISM_OCR']
    setOcrHooks(null)
    process.env['PRISM_OCR'] = 'off'
    try {
      expect(await ocrAvailable()).toBe(false)
      expect(await ocrAvailable()).toBe(false) // 二次调用（缓存路径）同样 false
    } finally {
      if (saved === undefined) delete process.env['PRISM_OCR']
      else process.env['PRISM_OCR'] = saved
      setOcrHooks(null)
    }
  })
})

describe('toMarkdown：OCR 管道与逐字回落（SPEC-3.1/3.2/3.3）', () => {
  it('图片 + OCR 就绪 → converted 且带 ocr 标记（正文来自 OCR）', async () => {
    for (const ext of OCR_IMAGE_EXTENSIONS) {
      const calls = useOcr(true, async () => ({ ok: true, markdown: '## 第 1 页\n\n识别出的正文' }))
      const result = await toMarkdown(utf8('not-really-a-png'), `docs/scan${ext}`)
      expect(result.status, ext).toBe('converted')
      expect(result.ocr, ext).toBe(true)
      expect(result.markdown, ext).toContain('## 第 1 页')
      expect(result.elapsed_ms, ext).toBeGreaterThanOrEqual(0)
      expect(calls, ext).toEqual([`docs/scan${ext}`])
    }
  })

  it('图片 + OCR 未装 → 旧 unsupported 文案逐字（老机器行为零变化）', async () => {
    const calls = useOcr(false, async () => ({ ok: true, markdown: '不该被调用' }))
    const result = await toMarkdown(new Uint8Array([1, 2, 3]), 'x.png')
    expect(result.status).toBe('unsupported')
    expect(result.reason).toBe('不支持的扩展名: .png')
    expect(result.ocr).toBeUndefined()
    expect(result.ocr_failure).toBeUndefined() // **未就绪**不是失败 → 不带原因字段
    expect(calls).toEqual([]) // 未就绪 → 不该发请求
  })

  it('图片 + OCR 调用失败 → 回落同一句旧文案，且失败原因可观测（D-v14-tester-1）', async () => {
    useOcr(true, async () => ({ ok: false, reason: '模型缺失' }))
    const result = await toMarkdown(new Uint8Array([1, 2, 3]), 'x.png')
    expect(result.status).toBe('unsupported')
    expect(result.reason).toBe('不支持的扩展名: .png') // 回落文案仍逐字（SPEC-3.2）
    expect(result.ocr_failure).toBe('模型缺失') // 「装了但 runner 坏」不再与「没装」同貌
  })

  it('扫描 PDF：OCR 就绪 → OCR 正文；未装/失败 → needs_ocr 文案逐字（anydoc 原话）', async () => {
    const pdf = imageOnlyPdf()
    // ① 未装：先确认真机 anydoc 的原话（这就是「逐字不变」的基准）
    useOcr(false, async () => ({ ok: true, markdown: '不该被调用' }))
    const off = await toMarkdown(pdf, 'scan.pdf')
    expect(off.status).toBe('needs_ocr')
    expect(off.reason).toBe('page 1 of 1 needs OCR')
    expect(off.ocr_failure).toBeUndefined() // 未装 → 只是回落，不是失败

    // ② 就绪 + 成功 → converted（带 ocr 标记）
    useOcr(true, async () => ({ ok: true, markdown: '## 第 1 页\n\n扫描件正文' }))
    const on = await toMarkdown(pdf, 'scan.pdf')
    expect(on.status).toBe('converted')
    expect(on.ocr).toBe(true)
    expect(on.markdown).toContain('扫描件正文')

    // ③ 就绪但 runner 失败 → 回落**同一句** anydoc 原话（原因另挂 ocr_failure）
    useOcr(true, async () => ({ ok: false, reason: 'boom' }))
    const failed = await toMarkdown(pdf, 'scan.pdf')
    expect(failed.status).toBe('needs_ocr')
    expect(failed.reason).toBe(off.reason)
    expect(failed.ocr_failure).toBe('boom')
  })

  it('非 OCR 路径不带 ocr 标记（文本直读 / anydoc 转换）', async () => {
    const text = await toMarkdown(utf8('# 标题'), 'a.md')
    expect(text.ocr).toBeUndefined()
    const docx = await toMarkdown(minimalDocx('Prism 测试文档'), 'docs/测试.docx')
    expect(docx.status).toBe('converted')
    expect(docx.ocr).toBeUndefined()
  })

  it('默认 runner 真跑通（--fake：不需要模型，只要 Python）', async (ctx) => {
    const fixture = join(
      fileURLToPath(new URL('../../../3rd/ocr/', import.meta.url)),
      'fixtures',
      'fixture-3-tiny.png',
    )
    const result = await runOcrTool(fixture, { fake: true })
    if (!result.ok) {
      // 无 Python / 无 3rd/ocr 的机器：条件跳过（真机验证留波次 3）
      if (/无法启动|缺失|Python|解释器/.test(result.reason)) return ctx.skip()
      throw new Error(`OCR 薄壳调用失败：${result.reason}`)
    }
    expect(result.markdown).toContain('## 第 1 页')
    expect(result.markdown).toContain('PRISM')
  })
})

// ---------------------------------------------------------------------------
// v17 B-A1：表格 / 版面增强的 flag 透传与开关（`buildOcrToolArgs` + `toMarkdown` 选项）
// ---------------------------------------------------------------------------

describe('OCR 表格/版面 flag（v17 B-A1）', () => {
  it('buildOcrToolArgs：显式 true/false 才透传 flag，undefined 不带（交 Python 缺省）', () => {
    const tool = buildOcrToolArgs('in.png')[0]
    expect(tool.endsWith('ocr_tool.mjs')).toBe(true)

    // undefined（缺省）→ 不带任何增强 flag
    expect(buildOcrToolArgs('in.png')).toEqual([tool, 'in.png'])
    // 显式关 → --no-table / --no-layout
    expect(buildOcrToolArgs('in.png', { table: false, layout: false })).toEqual([
      tool,
      'in.png',
      '--no-table',
      '--no-layout',
    ])
    // 显式开 → --table / --layout
    expect(buildOcrToolArgs('in.png', { table: true, layout: true })).toEqual([
      tool,
      'in.png',
      '--table',
      '--layout',
    ])
    // 混搭 + fake 一起
    expect(buildOcrToolArgs('in.png', { fake: true, table: false, layout: true })).toEqual([
      tool,
      'in.png',
      '--fake',
      '--no-table',
      '--layout',
    ])
  })

  it('toMarkdown：ocr 选项透传到 runner（缺省都开；显式 false 才关）', async () => {
    const seen: Array<{ input: string; table?: boolean; layout?: boolean } | undefined> = []
    setOcrHooks({
      available: () => true,
      run: async (input, options) => {
        seen.push({ input, ...options })
        return { ok: true, markdown: '## 第 1 页\n\n正文' }
      },
    })

    await toMarkdown(new Uint8Array([1]), 'a.png') // 缺省 → 两者都 true
    await toMarkdown(new Uint8Array([1]), 'b.png', { ocr: { table: false, layout: false } })
    await toMarkdown(new Uint8Array([1]), 'c.png', { ocr: { table: false } }) // layout 缺省 true

    expect(seen).toEqual([
      { input: 'a.png', table: true, layout: true },
      { input: 'b.png', table: false, layout: false },
      { input: 'c.png', table: false, layout: true },
    ])
  })

  it('可选两件模型就绪判据：只看文件在不在（文件名镜像 setup-ocr/ocr_main）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-ocr-extra-'))
    try {
      expect(ocrTableModelReady(join(dir, 'nope'))).toBe(false)
      expect(ocrLayoutModelReady(join(dir, 'nope'))).toBe(false)
      await writeFile(join(dir, OCR_TABLE_MODEL_FILE), 'x')
      expect(ocrTableModelReady(dir)).toBe(true)
      expect(ocrLayoutModelReady(dir)).toBe(false)
      await writeFile(join(dir, OCR_LAYOUT_MODEL_FILE), 'x')
      expect(ocrLayoutModelReady(dir)).toBe(true)
      // 核心三件套的「至少三件」判据**不**把这两件算进去（两件不构成 OCR 就绪）
      expect(ocrModelsReady(dir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// v17 B-A4：内嵌图片（anydoc toDocument → assets → OCR → `> [图片 N]` 引用块）
// ---------------------------------------------------------------------------

const FIXTURES_DIR = fileURLToPath(new URL('../../../3rd/ocr/fixtures/', import.meta.url))

/** 读 fixture 字节；不存在返回 null（生成脚本：python 3rd/ocr/gen_docx_fixtures.py）。 */
function readFixture(name: string): Uint8Array | null {
  const path = join(FIXTURES_DIR, name)
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null
}

/** 临时素材目录（实现侧 mkdtemp 前缀）当前条目。 */
function assetTempEntries(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('prism-ocr-asset-'))
}

describe('内嵌图片 OCR（v17 B-A4）', () => {
  it('mediaType 白名单 = png/jpeg/webp，jpeg 落 .jpg（与 OCR_IMAGE_EXTENSIONS 同口径）', () => {
    expect(EMBEDDED_IMAGE_MEDIA_TYPES).toEqual({
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
    })
    // 白名单外的 mediaType 一律不在表里（bmp/gif/svg/octet-stream…）
    for (const outside of ['image/bmp', 'image/gif', 'image/tiff', 'application/octet-stream']) {
      expect(EMBEDDED_IMAGE_MEDIA_TYPES[outside], outside).toBeUndefined()
    }
  })

  it('docx 含图 + OCR 就绪 → alt 整行替换为 `> [图片 N] …`，fake 文本进正文（A4.1）', async (ctx) => {
    const bytes = readFixture('embed-image.docx')
    if (bytes === null) return ctx.skip()
    const calls = useOcr(true, async () => ({
      ok: true,
      markdown: '## 第 1 页\n\n内嵌截图识别出的文字',
    }))

    const result = await toMarkdown(bytes, 'docs/报告.docx')

    expect(result.status).toBe('converted')
    // 图片的 alt 整行被引用块取代（原 alt 文本行不再单独出现）
    expect(result.markdown).toContain('> [图片 1] 内嵌截图识别出的文字')
    expect(result.markdown.split('\n')).not.toContain('内嵌文字截图说明')
    // 前后正文段落位置不动
    expect(result.markdown).toBe(
      '图片上方的一段正文。\n\n> [图片 1] 内嵌截图识别出的文字\n\n图片下方的一段正文。\n',
    )
    // 走的是临时文件而不是 docx 本体（OCR 工具只认图片/PDF）
    expect(calls.length).toBe(1)
    expect(calls[0].endsWith('.png')).toBe(true)
    expect(calls[0]).not.toBe('docs/报告.docx')
    // 内嵌图 OCR 不冒充「正文来自 OCR」（不打 ocr 位，避免误触 SPEC-3.4 守卫）
    expect(result.ocr).toBeUndefined()
  })

  it('白名单外 mediaType（image/bmp）→ 跳过，不调 OCR，输出逐字保持 anydoc 原样', async (ctx) => {
    const bytes = readFixture('embed-nonwhitelist.docx')
    if (bytes === null) return ctx.skip()
    const calls = useOcr(true, async () => ({ ok: true, markdown: '不该被调用' }))

    const result = await toMarkdown(bytes, 'docs/bmp.docx')

    expect(result.status).toBe('converted')
    expect(calls).toEqual([]) // 非白名单 → 整条 assets 路径不碰 OCR
    expect(result.markdown).toBe('图片上方的一段正文。\n\n内嵌文字截图说明\n\n图片下方的一段正文。\n')
  })

  it('临时素材目录用后无残留（mkdtemp 必删，R5）', async (ctx) => {
    const bytes = readFixture('embed-image.docx')
    if (bytes === null) return ctx.skip()
    useOcr(true, async () => ({ ok: true, markdown: '## 第 1 页\n\n截图文字' }))

    const before = new Set(assetTempEntries())
    await toMarkdown(bytes, 'docs/报告.docx')
    const added = assetTempEntries().filter((name) => !before.has(name))
    expect(added).toEqual([])
  })

  it('OCR 未就绪 → 内嵌图路径整条不走，输出与旧（anydoc 原样）逐字一致', async (ctx) => {
    const bytes = readFixture('embed-image.docx')
    if (bytes === null) return ctx.skip()
    const calls = useOcr(false, async () => ({ ok: true, markdown: '不该被调用' }))

    const result = await toMarkdown(bytes, 'docs/报告.docx')

    expect(result.status).toBe('converted')
    expect(calls).toEqual([])
    expect(result.markdown).toBe('图片上方的一段正文。\n\n内嵌文字截图说明\n\n图片下方的一段正文。\n')
  })

  it('单图 OCR 失败 → 保留原 alt 行（整篇转换不失败）', async (ctx) => {
    const bytes = readFixture('embed-image.docx')
    if (bytes === null) return ctx.skip()
    useOcr(true, async () => ({ ok: false, reason: '模型缺失' }))

    const result = await toMarkdown(bytes, 'docs/报告.docx')

    expect(result.status).toBe('converted')
    expect(result.markdown).toBe('图片上方的一段正文。\n\n内嵌文字截图说明\n\n图片下方的一段正文。\n')
  })

  it('PDF 走不到 assets 路径（anydoc 对 PDF 无 toDocument，运行时守卫）', async () => {
    const pdf = imageOnlyPdf()
    const calls = useOcr(true, async () => ({ ok: true, markdown: '## 第 1 页\n\n扫描件正文' }))

    const result = await toMarkdown(pdf, 'scan.pdf')

    expect(result.status).toBe('converted')
    expect(result.markdown).toBe('## 第 1 页\n\n扫描件正文')
    // 只调了一次、且输入是 PDF 本体——没有临时图片文件被送去 OCR
    expect(calls).toEqual(['scan.pdf'])
    expect(calls.some((input) => input.endsWith('.png'))).toBe(false)
  })
})
