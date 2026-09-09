import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  INBOX_DIR,
  entryDirPath,
  isValidSegment,
  latestFilePath,
  ownerFromPath,
  readContentFile,
  versionFilePath,
  writeEntryFiles,
} from '../src/store.js'

describe('文件存储布局（design §3.3）', () => {
  const dir = 'K:\\tmp\\knowledge'

  it('global 层：无 owner 段', () => {
    expect(entryDirPath(dir, { layer: 'global', book: 'java-standards', module: 'exception' }, 'JAVA-01')).toBe(
      join(dir, 'global', 'java-standards', 'exception', 'JAVA-01'),
    )
  })

  it('project/role 层带 owner 段', () => {
    expect(entryDirPath(dir, { layer: 'project', owner: 'p1', book: 'b', module: 'm' }, 'X')).toBe(
      join(dir, 'project', 'p1', 'b', 'm', 'X'),
    )
    expect(entryDirPath(dir, { layer: 'role', owner: 'architect', book: 'b', module: '' }, 'X')).toBe(
      join(dir, 'role', 'architect', 'b', INBOX_DIR, 'X'),
    )
  })

  it('module 省略 → _inbox/', () => {
    expect(entryDirPath(dir, { layer: 'global', book: 'b', module: '' }, 'X')).toBe(
      join(dir, 'global', 'b', '_inbox', 'X'),
    )
  })

  it('版次文件两位零填充，≥100 自然进位', () => {
    expect(versionFilePath('d', 1)).toBe(join('d', 'v01.md'))
    expect(versionFilePath('d', 42)).toBe(join('d', 'v42.md'))
    expect(versionFilePath('d', 100)).toBe(join('d', 'v100.md'))
    expect(latestFilePath('d', 'JAVA-01')).toBe(join('d', 'JAVA-01.md'))
  })
})

describe('段名校验（§3.5 非法段名抛 bad_request 的判定基础）', () => {
  it('接受常规名（含中文/连字符）', () => {
    expect(isValidSegment('java-standards')).toBe(true)
    expect(isValidSegment('异常处理规范')).toBe(true)
    expect(isValidSegment('KB-abc123')).toBe(true)
  })

  it('拒绝路径分隔符/相对段/空串/尾点/控制字符/Windows 保留名', () => {
    expect(isValidSegment('')).toBe(false)
    expect(isValidSegment('a/b')).toBe(false)
    expect(isValidSegment('a\\b')).toBe(false)
    expect(isValidSegment('.')).toBe(false)
    expect(isValidSegment('..')).toBe(false)
    expect(isValidSegment('name.')).toBe(false)
    expect(isValidSegment('con')).toBe(false)
    expect(isValidSegment('a\nb')).toBe(false)
  })
})

describe('版次文件写入与读取', () => {
  it('写版次文件 + 最新版副本，两文件内容一致', () => {
    const home = mkTmp()
    const markdown = '---\nid: KB-X\nversion: 2\n---\n正文'
    const files = writeEntryFiles(
      home,
      { layer: 'project', owner: 'p1', book: 'b', module: 'm' },
      'KB-X',
      2,
      markdown,
    )
    expect(existsSync(files.versionFile)).toBe(true)
    expect(existsSync(files.latestFile)).toBe(true)
    expect(readFileSync(files.versionFile, 'utf-8')).toBe(markdown)
    expect(readFileSync(files.latestFile, 'utf-8')).toBe(markdown)
    expect(files.versionFile).toContain(join('KB-X', 'v02.md'))
    expect(readContentFile(files.versionFile)).toBe(markdown)
    expect(readContentFile(join(files.dir, 'missing.md'))).toBeNull()
  })
})

describe('ownerFromPath（表无 owner 列，从 path 段反解）', () => {
  it('project/role 反解出 owner，global 为 undefined', () => {
    const root = mkTmp()
    const projectPath = join(root, 'project', 'p1', 'b', 'm', 'X', 'v01.md')
    const rolePath = join(root, 'role', 'architect', 'b', '_inbox', 'X', 'v01.md')
    const globalPath = join(root, 'global', 'b', 'm', 'X', 'v01.md')
    expect(ownerFromPath(root, projectPath)).toBe('p1')
    expect(ownerFromPath(root, rolePath)).toBe('architect')
    expect(ownerFromPath(root, globalPath)).toBeUndefined()
    expect(ownerFromPath(root, join(root, 'elsewhere', 'x'))).toBeUndefined()
  })
})

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'prism-kb-store-'))
}
