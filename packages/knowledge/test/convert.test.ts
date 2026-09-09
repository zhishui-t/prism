import { describe, expect, it } from 'vitest'

import {
  CONVERTIBLE_EXTENSIONS,
  TEXT_EXTENSIONS,
  extensionOf,
  isSupported,
  toMarkdown,
} from '../src/convert.js'

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
