/**
 * F1 知识扫描过滤（design-v8 §4）：
 * - 默认只扫**文档集** `DOC_ONLY_EXTENSIONS`（anydoc 支持集 − {html, htm}）；
 * - **文件名级跳过表**（`CMakeLists.txt` 是 `.txt`、`Makefile` 无扩展名——扩展门拦不住）；
 * - `include_ext` 显式纳入，且非 anydoc 扩展走**纯文本直读**（不能落 toMarkdown 报 unsupported）；
 * - 未纳入按原因分列 `by_skip_reason`（dry-run 的「纳入 / 处理失败 / 未纳入」对账物）；
 * - **对账恒等式**：`(created + updated + unchanged) + Σby_skip_reason = 审视全量`
 *   （候选内失败同时计入 `skipped`，**不能**拿 `discovered` 去加全量——见 MAJ-2 一节）。
 *
 * 全部用临时目录（R5）：项目根 mkdtemp、知识服务用内存桩，不碰真实宿主目录。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismKnowledgeService, extensionOf } from '@prism/knowledge'
import { describe, expect, it } from 'vitest'

import { createMcpTools } from '../src/mcp/server.js'
import {
  DOC_ONLY_EXTENSIONS,
  GATE_SKIP_REASONS,
  SKIP_REASONS,
  WEB_EXTENSIONS,
  isBuildFileName,
  makeDryRunKb,
  normalizeExtensions,
  scanProject,
  type ScanOptions,
  type ScanReport,
} from '../src/kb/scan.js'
import { MemoryKb, makeTempDir, putFile } from './helpers.js'

/** 建临时项目并写入给定文件（路径 → 内容，自动建父目录）。 */
async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await makeTempDir('prism-scan-filter-')
  for (const [rel, content] of Object.entries(files)) {
    await putFile(join(root, ...rel.split('/')), content)
  }
  return root
}

/** 扫一次临时项目（内存桩知识服务；项目根/家目录都是 mkdtemp，不碰真实宿主目录）。 */
function scan(root: string, extra: Partial<ScanOptions> = {}): Promise<ScanReport> {
  return scanProject(new MemoryKb(), { root, owner: 'p', book: 'p', ...extra })
}

describe('默认扩展集 DOC_ONLY（= anydoc 支持集 − {html, htm}）', () => {
  it('html/htm 退出默认集；文档与旧 Office/ODF 家族保留；源码/图片不在内', () => {
    for (const ext of WEB_EXTENSIONS) expect(DOC_ONLY_EXTENSIONS).not.toContain(ext)
    for (const ext of ['.md', '.markdown', '.txt', '.text', '.csv', '.doc', '.docx', '.odt', '.pdf', '.ppt', '.rtf', '.epub', '.xlsx', '.ods', '.odp']) {
      expect(DOC_ONLY_EXTENSIONS, `${ext} 应在默认集内`).toContain(ext)
    }
    for (const ext of ['.c', '.cpp', '.h', '.ts', '.json', '.png', '.log']) {
      expect(DOC_ONLY_EXTENSIONS, `${ext} 不应在默认集内`).not.toContain(ext)
    }
  })

  it('include_ext 入参归一化：trim + 小写 + 去前导点 + 去重保序', () => {
    expect(normalizeExtensions([' H ', '.C', 'CPP', '', '   ', 'h'])).toEqual(['.h', '.c', '.cpp'])
    expect(normalizeExtensions([])).toEqual([])
  })
})

describe('文件名级跳过表（扩展门挡不住的那类）', () => {
  it('CMakeLists.txt 的扩展名就是 .txt（在默认集里），只能靠文件名表挡下', () => {
    expect(extensionOf('CMakeLists.txt')).toBe('.txt')
    expect(DOC_ONLY_EXTENSIONS).toContain('.txt')
    expect(isBuildFileName('CMakeLists.txt')).toBe(true)
  })

  it('构建脚本 / 构建配置命中；普通文档不误伤', () => {
    for (const name of [
      'Makefile',
      'GNUmakefile',
      'Dockerfile',
      'rules.mk',
      'rules.cmake',
      'webpack.config.js',
      'vite.config.ts',
      'rollup.config.mjs',
      'esbuild.config.js',
      'tsconfig.json',
      'tsconfig.node.json',
      '.eslintrc.json',
      '.prettierrc',
      'package.json',
      'turbo.json',
    ]) {
      expect(isBuildFileName(name), `${name} 应被跳过表命中`).toBe(true)
    }
    for (const name of ['README.md', 'design.txt', 'notes.markdown', 'rules.c', 'CMakeLists.md']) {
      expect(isBuildFileName(name), `${name} 不该被跳过表命中`).toBe(false)
    }
  })

  it('MIN-6 大小写不敏感：CMakeLists.TXT / MAKEFILE 也命中（表本身全小写）', () => {
    // 大小写不敏感的文件系统（Windows/macOS）上 `CMakeLists.TXT` 的扩展名归一后是 `.txt`
    // （在默认集里），只有把小写化做在匹配之前才挡得住这类变体。
    for (const name of [
      'CMakeLists.TXT',
      'MAKEFILE',
      'MAKEFILE.MK',
      'VITE.CONFIG.TS',
      'TSConfig.JSON',
      '.ESLINTRC.JSON',
      'DOCKERFILE',
    ]) {
      expect(isBuildFileName(name), `${name} 应被跳过表命中（大小写不敏感）`).toBe(true)
    }
    for (const name of ['README.MD', 'CMAKELISTS.MD', 'NOTES.MARKDOWN']) {
      expect(isBuildFileName(name), `${name} 不该被跳过表命中`).toBe(false)
    }
  })
})

describe('scanProject 默认过滤与报告分列', () => {
  it('html/htm 与构建文件默认不入候选，各计入 by_skip_reason 对应类', async () => {
    const root = await makeProject({
      'README.md': '# 项目\n\n说明。',
      'notes.txt': '纯文本笔记。',
      'index.html': '<h1>h5 默认不扫</h1>',
      'docs/page.htm': '<p>同上</p>',
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)',
      'Makefile': 'all:\n\techo hi',
      'cmake/rules.cmake': 'set(X 1)',
      'src/main.c': 'int main(void) { return 0; }',
      'logo.png': 'binary-ish',
    })
    const report = await scan(root)
    const rels = report.files.map((f) => f.rel)

    expect(rels).toContain('README.md')
    expect(rels).toContain('notes.txt')
    for (const gone of ['index.html', 'docs/page.htm', 'CMakeLists.txt', 'Makefile', 'cmake/rules.cmake', 'src/main.c', 'logo.png']) {
      expect(rels, `${gone} 不该入候选`).not.toContain(gone)
    }
    expect(report.discovered).toBe(2)
    expect(report.by_skip_reason[SKIP_REASONS.buildFile]).toBe(3) // CMakeLists.txt + Makefile + rules.cmake
    expect(report.by_skip_reason[SKIP_REASONS.extNotIncluded]).toBe(4) // html + htm + c + png
  })

  it('跳过表先于 .gitignore 判定：被表挡下的文件不计入 ignored_files', async () => {
    const root = await makeProject({
      '.gitignore': 'CMakeLists.txt\n',
      'README.md': '# 项目',
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)',
    })
    const report = await scan(root)
    expect(report.ignored_files).toBe(0) // 已在上游被跳过表挡下（未进入 .gitignore 分支）
    expect(report.by_skip_reason[SKIP_REASONS.buildFile]).toBe(1)
    expect(report.discovered).toBe(1)
  })

  it('候选内失败也各计一类（超大文件 → too_large）', async () => {
    const root = await makeProject({ 'a.md': `# A\n\n${'x'.repeat(200)}`, 'b.md': '# B' })
    const report = await scan(root, { maxFileBytes: 32 })
    expect(report.skipped).toBe(1)
    expect(report.created).toBe(1)
    expect(report.by_skip_reason[SKIP_REASONS.tooLarge]).toBe(1)
  })

  it('MIN-6 大小写变体（CMakeLists.TXT / MAKEFILE）在真实扫描里也计入 build_file', async () => {
    const root = await makeProject({
      'README.md': '# 项目',
      'CMakeLists.TXT': 'cmake_minimum_required(VERSION 3.20)',
      'MAKEFILE': 'all:\n\techo hi',
    })
    const report = await scan(root)
    expect(report.discovered).toBe(1)
    expect(report.by_skip_reason[SKIP_REASONS.buildFile]).toBe(2)
    expect(report.files.map((f) => f.rel)).toEqual(['README.md'])
  })

  it('dry-run（makeDryRunKb）：纳入数与 by_skip_reason 可对账，且不落库', async () => {
    const root = await makeProject({
      'README.md': '# 项目',
      'notes.txt': '笔记',
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)',
      'page.html': '<h1>默认不扫</h1>',
      'src/main.c': 'int main(void) { return 0; }',
    })
    // dry-run 必须用**真实服务**：`makeDryRunKb` 以 `Object.create(real)` 包装（只覆写 index），
    // 内存桩的 `#entries` 私有字段经原型链的接收者访问会抛错——桩不是等价替身，别拿它验 dry-run
    const home = await makeTempDir('prism-scan-filter-home-')
    const real = new PrismKnowledgeService({ home })
    try {
      const report = await scanProject(makeDryRunKb(real), { root, owner: 'p', book: 'p' })
      expect(report.discovered).toBe(2)
      expect(report.created).toBe(2)
      expect(report.by_skip_reason).toEqual({
        [SKIP_REASONS.buildFile]: 1,
        [SKIP_REASONS.extNotIncluded]: 2,
      })
      expect(await real.get('IDX-README')).toBeNull() // dry-run 未写
    } finally {
      real.close()
    }
  })
})

describe('include_ext 显式纳入', () => {
  it('纳入 h/c 源码且走纯文本直读（正文可读出，不报 unsupported）', async () => {
    const root = await makeProject({
      'README.md': '# 项目',
      'include/api.h': '#define MAX 8\nint add(int a, int b);\n',
      'src/util.c': 'int add(int a, int b) { return a + b; }\n',
    })
    const kb = new MemoryKb()
    const report = await scanProject(kb, { root, owner: 'p', book: 'p', includeExt: [' h ', 'C'] })
    const rels = report.files.map((f) => f.rel)

    expect(rels).toContain('include/api.h')
    expect(rels).toContain('src/util.c')
    expect(report.skipped, '纯文本直读不该产生 skipped').toBe(0)
    expect(report.by_skip_reason[SKIP_REASONS.decodeFailed]).toBeUndefined()

    const header = await kb.get('IDX-include-api')
    expect(header?.content).toContain('#define MAX 8')
    expect(header?.content).toContain('int add(int a, int b);')
    const source = await kb.get('IDX-src-util')
    expect(source?.content).toContain('return a + b')
  })

  it('include_ext 能把 html 捞回来（默认不扫 ≠ 永久排除）', async () => {
    const root = await makeProject({ 'page.html': '<h1>显式纳入</h1>\n', 'README.md': '# 项目' })
    const kb = new MemoryKb()
    const report = await scanProject(kb, { root, owner: 'p', book: 'p', includeExt: ['html'] })
    expect(report.discovered).toBe(2)
    expect((await kb.get('IDX-page'))?.content).toContain('显式纳入')
  })

  it('纳入的二进制文件解码失败 → 计 decode_failed 且不落库', async () => {
    const root = await makeTempDir('prism-scan-filter-bin-')
    await writeFile(join(root, 'blob.c'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    const kb = new MemoryKb()
    const report = await scanProject(kb, { root, owner: 'p', book: 'p', includeExt: ['c'] })

    expect(report.discovered).toBe(1)
    expect(report.skipped).toBe(1)
    expect(report.by_skip_reason[SKIP_REASONS.decodeFailed]).toBe(1)
    expect(report.files[0]?.reason).toContain('解码')
    expect(await kb.get('IDX-blob')).toBeNull()
  })

  it('MIN-5 无 BOM 的 UTF-16LE：utf-8 fatal 不抛但解出 NUL → 计 decode_failed 且不落库', async () => {
    const root = await makeTempDir('prism-scan-filter-utf16-')
    // UTF-16LE **无 BOM**：每个 ASCII 字符后面跟一个 0x00——全部字节 < 0x80，
    // 对 utf-8 fatal 而言是**合法**序列（不抛错），正文里只剩 NUL 串。
    await writeFile(
      join(root, 'wide.h'),
      Buffer.from('#define MAX 8\nint add(int a, int b);\n', 'utf16le'),
    )
    const kb = new MemoryKb()
    const report = await scanProject(kb, { root, owner: 'p', book: 'p', includeExt: ['h'] })

    expect(report.discovered).toBe(1)
    expect(report.skipped).toBe(1)
    expect(report.by_skip_reason[SKIP_REASONS.decodeFailed]).toBe(1)
    expect(report.files[0]?.reason).toContain('NUL')
    expect(await kb.get('IDX-wide')).toBeNull()
  })
})

describe('MCP prism_kb_import：include_ext 透传与 by_skip_reason 回传', () => {
  it('include_ext 纳入源码；响应带 by_skip_reason 分列', async () => {
    const root = await makeProject({
      'README.md': '# 项目',
      'src/api.h': '#define MAX 8\nint add(int a, int b);\n',
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)',
      'page.html': '<h1>默认不扫</h1>',
    })
    const home = await makeTempDir('prism-mcp-scan-')
    const service = new PrismKnowledgeService({ home })
    const tools = createMcpTools({ home, kb: service })
    try {
      const tool = tools.find((t) => t.name === 'prism_kb_import')
      expect(tool).toBeDefined()
      const result = (await tool!.call({
        path: root,
        owner: 'p',
        dry_run: true,
        include_ext: ['h'],
      })) as { discovered: number; by_skip_reason: Record<string, number> }

      expect(result.discovered).toBe(2) // README.md + src/api.h
      expect(result.by_skip_reason).toEqual({
        [SKIP_REASONS.buildFile]: 1,
        [SKIP_REASONS.extNotIncluded]: 1,
      })
    } finally {
      tools.close()
      service.close()
    }
  })
})

/**
 * **MAJ-2 回归**（v8 代码检视）：候选内失败（`too_large` / `read_failed` / `decode_failed` /
 * `convert_failed` / `index_failed`）**既**计入 `skipped`、**又**计入 `by_skip_reason`。
 * 旧注释声称 `discovered + Σby_skip_reason = 审视全量`——按这个口径会把候选内失败算两遍
 * （实测 4 文件项目打出「发现 2 + 未纳入 3」= 5 ≠ 4）。
 *
 * 正确恒等式：`(created + updated + unchanged) + Σby_skip_reason = 审视全量`，
 * 等价地 `discovered = created + updated + unchanged + Σ候选内失败`（门挡的**不在** discovered 里）。
 */
describe('MAJ-2 对账恒等式（候选内失败不得双计）', () => {
  /** 门挡两类（`GATE_SKIP_REASONS`）：候选**之外**就被挡下（不占 discovered）。 */
  const GATE = GATE_SKIP_REASONS
  const sumValues = (m: Record<string, number>): number =>
    Object.values(m).reduce((a, b) => a + b, 0)
  const gateSum = (m: Record<string, number>): number =>
    GATE.reduce((a, r) => a + (m[r] ?? 0), 0)

  it('GATE_SKIP_REASONS 恰好是门挡两类（契约面：CLI 人读分列与测试共用同一真相源）', () => {
    expect([...GATE]).toEqual([SKIP_REASONS.extNotIncluded, SKIP_REASONS.buildFile])
    // 其余原因都是候选内失败（入 discovered、并入 skipped）
    for (const reason of Object.values(SKIP_REASONS)) {
      expect(GATE.includes(reason), `${reason} 不应被当作门挡`).toBe(
        reason === SKIP_REASONS.extNotIncluded || reason === SKIP_REASONS.buildFile,
      )
    }
  })

  it('纳入 + 全量 by_skip_reason = 审视全量；discovered = 纳入 + 候选内失败', async () => {
    const root = await makeProject({
      'README.md': '# 项目', // 纳入
      'notes.txt': '短笔记', // 纳入
      'big.md': `# 大\n\n${'x'.repeat(200)}`, // 候选内失败：too_large
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)', // 门挡：build_file
      'page.html': '<h1>默认不扫</h1>', // 门挡：ext_not_included
    })
    const report = await scan(root, { maxFileBytes: 64 })

    const included = report.created + report.updated + report.unchanged
    const total = 5 // 项目里就 5 个文件（无 .gitignore / 无内置忽略目录）

    expect(report.created).toBe(2)
    expect(report.by_skip_reason[SKIP_REASONS.tooLarge]).toBe(1) // 候选内失败
    expect(report.skipped).toBe(1)
    expect(gateSum(report.by_skip_reason)).toBe(2) // CMakeLists.txt + page.html
    expect(sumValues(report.by_skip_reason)).toBe(3)

    // ① 正确恒等式：纳入 + **全量** by_skip_reason = 审视全量
    expect(included + sumValues(report.by_skip_reason)).toBe(total)
    // ② discovered 只含**候选内失败**，不含门挡 → 纳入 + 候选内失败
    expect(report.discovered).toBe(included + report.skipped)
    // ③ 旧注释口径必然高估——这条把「别再双计」钉死（5 个文件会被打成 3 + 3）
    expect(report.discovered + sumValues(report.by_skip_reason)).toBeGreaterThan(total)
  })

  it('「全量」不含 .gitignore 剪枝与内置忽略目录（恒等式仍成立）', async () => {
    const root = await makeProject({
      '.gitignore': 'secret.md\n',
      'README.md': '# 项目',
      'secret.md': '# 被 .gitignore 剪枝',
      'node_modules/dep.md': '# 被内置忽略目录挡下（根本没走 walk）',
      'big.md': 'x'.repeat(200), // 候选内失败：too_large
      'Makefile': 'all:\n\techo hi', // 门挡：build_file
    })
    const report = await scan(root, { maxFileBytes: 64 })

    const included = report.created + report.updated + report.unchanged
    expect(report.ignored_files).toBe(1) // secret.md
    // node_modules 走的是**内置忽略目录**（比 .gitignore 更靠前，连 ignored_dirs 都不记）
    expect(report.ignored_dirs).not.toContain('node_modules')
    expect(report.files.map((f) => f.rel)).not.toContain('node_modules/dep.md')
    // 审视全量 = 走过门的 4 个：.gitignore（扩展门）+ README + big.md + Makefile
    // （secret.md 剪枝、node_modules 未 walk——两者都**不在** by_skip_reason 里）
    expect(included + sumValues(report.by_skip_reason)).toBe(4)
    expect(report.by_skip_reason[SKIP_REASONS.tooLarge]).toBe(1)
    expect(gateSum(report.by_skip_reason)).toBe(2) // .gitignore（ext）+ Makefile（build）
  })
})
