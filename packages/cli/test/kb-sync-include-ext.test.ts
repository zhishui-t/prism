/**
 * `prism kb sync --include-ext`（F1，design-v8 §4）：只验 **CLI 面**——
 * flag 是否真注册进 argv（不注册会被当成位置参数）、是否透传到扫描器、报告是否分列。
 * 过滤语义本身由 `packages/server/test/scan-filter.test.ts` 覆盖。
 *
 * 临时 home + 临时项目根（R5：绝不写真实宿主目录）；`--dry-run` 不落库。
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createKnowledgeService } from '@prism/knowledge'
import { describe, expect, it } from 'vitest'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

/** 建临时项目：README.md + CMakeLists.txt + index.html + src/api.h。 */
async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prism-kb-sync-proj-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# 项目\n\n说明。', 'utf-8')
  await writeFile(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)', 'utf-8')
  await writeFile(join(root, 'index.html'), '<h1>h5 默认不扫</h1>', 'utf-8')
  await writeFile(join(root, 'src/api.h'), '#define MAX 8\nint add(int a, int b);\n', 'utf-8')
  return root
}

describe('prism kb sync：默认文档集 + --include-ext', () => {
  it('默认跳过构建文件与 html 并分列；--include-ext h 把 h 文件纳入（纯文本直读）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'prism-kb-sync-home-'))
    const root = await makeProject()
    const kb = createKnowledgeService({ home })
    const lines: string[] = []
    const ctx: CommandContext = defaultContext({
      home,
      kbFactory: async () => kb,
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(`ERR ${l}`),
    })

    // ① 默认：README.md 入候选；CMakeLists.txt（.txt 但命中跳过表）与 index.html 被跳过并分列
    expect(await runCommand(ctx, ['kb', 'sync', root, '--owner', 'p', '--dry-run'])).toBe(0)
    const plain = lines.join('\n')
    expect(plain).toContain('构建文件/配置 1')
    expect(plain).toContain('扩展不在扫描集 2') // index.html + src/api.h（未显式纳入）
    expect(plain).not.toContain('ERR')

    // ② --include-ext h：argv 真注册（否则 'h' 会变成位置参数，报错/漏扫）+ 透传到扫描器
    lines.length = 0
    const code = await runCommand(ctx, ['kb', 'sync', root, '--owner', 'p', '--include-ext', 'h', '--json', '--dry-run'])
    expect(code).toBe(0)
    const envelope = JSON.parse(lines[0] ?? '{}') as {
      value?: { files?: Array<{ rel: string }>; by_skip_reason?: Record<string, number> }
    }
    const rels = envelope.value?.files?.map((f) => f.rel) ?? []
    expect(rels).toContain('README.md')
    expect(rels).toContain('src/api.h') // 显式纳入生效
    expect(rels).not.toContain('CMakeLists.txt')
    expect(rels).not.toContain('index.html')
    expect(envelope.value?.by_skip_reason).toMatchObject({ build_file: 1, ext_not_included: 1 })
    kb.close()
  })
})

/**
 * **MAJ-2 回归**（v8 代码检视）：旧输出把「未纳入」写成全量 `by_skip_reason`（含候选内失败），
 * 而「发现 N 个可处理文件」用 `discovered`（也含它们）→ 同一批文件被算两遍，
 * 4 文件项目实测打出「发现 2 + 未纳入 3」。
 *
 * 修后口径（人读三行自洽）：
 *   纳入（新建+更新+未变）+ 处理失败（候选内）+ 未纳入（门挡两类）= 审视全量。
 */
describe('prism kb sync：MAJ-2 人读输出对账（纳入 + 处理失败 + 未纳入 = 总数）', () => {
  it('候选内失败单列「处理失败」，不再混进「未纳入」', async () => {
    const home = await mkdtemp(join(tmpdir(), 'prism-kb-recon-home-'))
    const root = await mkdtemp(join(tmpdir(), 'prism-kb-recon-proj-'))
    await writeFile(join(root, 'README.md'), '# 项目', 'utf-8')
    await writeFile(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)', 'utf-8')
    await writeFile(join(root, 'index.html'), '<h1>默认不扫</h1>', 'utf-8')
    // 候选内失败：--include-ext c 把它捞进候选，utf-8 fatal 解码抛错 → decode_failed
    await writeFile(join(root, 'blob.c'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))

    const kb = createKnowledgeService({ home })
    const lines: string[] = []
    const ctx: CommandContext = defaultContext({
      home,
      kbFactory: async () => kb,
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(`ERR ${l}`),
    })
    try {
      expect(
        await runCommand(ctx, ['kb', 'sync', root, '--owner', 'p', '--include-ext', 'c', '--dry-run']),
      ).toBe(0)

      const find = (prefix: string): string =>
        lines.find((l) => l.trimStart().startsWith(prefix)) ?? ''
      const summary = find('发现 ')
      const failures = find('处理失败 ')
      const excluded = find('未纳入 ')
      const dump = `\n--- 实得人读输出 ---\n${lines.join('\n')}` // 断言失败时直接看到原始输出
      expect(summary, `缺少「发现」行${dump}`).not.toBe('')
      expect(failures, `缺少「处理失败」行（候选内失败必须单列）${dump}`).not.toBe('')
      expect(excluded, `缺少「未纳入」行${dump}`).not.toBe('')

      const num = (text: string, re: RegExp): number => Number(re.exec(text)?.[1] ?? NaN)
      const discovered = num(summary, /发现 (\d+) 个候选文件/)
      const created = num(summary, /新建 (\d+)/)
      const updated = num(summary, /更新 (\d+)/)
      const unchanged = num(summary, /未变 (\d+)/)
      const failed = num(summary, /处理失败 (\d+)/)
      const failureTotal = num(failures, /处理失败 (\d+) 个:/)
      const excludedTotal = num(excluded, /未纳入 (\d+) 个:/)

      expect(created).toBe(1) // README.md
      expect(updated).toBe(0)
      expect(unchanged).toBe(0)
      expect(failed).toBe(1) // blob.c：候选内失败
      expect(failureTotal).toBe(1)
      expect(failures).toContain('文本解码失败 1')
      expect(excludedTotal).toBe(2) // 门挡两类：CMakeLists.txt + index.html
      expect(excluded).toContain('构建文件/配置 1')
      expect(excluded).toContain('扩展不在扫描集 1')

      // 三行口径自洽：纳入 + 处理失败 + 未纳入 = 审视全量（项目里 4 个文件）
      expect(created + updated + unchanged + failureTotal + excludedTotal).toBe(4)
      // 发现行语义：discovered = 纳入 + 候选内失败（门挡的不在其中）
      expect(discovered).toBe(created + updated + unchanged + failed)
      expect(lines.join('\n')).not.toContain('ERR')
    } finally {
      kb.close()
    }
  })
})
