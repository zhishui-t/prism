#!/usr/bin/env node
/**
 * resolve-symbols.mjs — 图优先的符号解析（design-verify 第 1 步 · 前置层）
 *
 * 有代码图谱就用图谱解析「文档引用的符号到底存不存在、在哪」，解析结果可直接写成
 * 锚点账本的文件锚点；图谱不可用/陈旧则退出码 3，调用方降级 grep（见 references/code-graph.md）。
 *
 * 用法:
 *   node resolve-symbols.mjs <符号1,符号2,... | 符号清单文件> --project <项目名>
 *        [--prism <CLI路径>] [--allow-stale] [--json]
 *
 * 环境变量:
 *   PRISM_CLI   同 --prism；可写 "node /abs/path/packages/cli/dist/index.js"
 *
 * 退出码:
 *   0 = 全部命中
 *   1 = 存在 NOT-FOUND（幻觉候选，需人工/锚点层确认）
 *   2 = 用法错误
 *   3 = 图谱不可用或陈旧（调用方应降级 grep）
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const USAGE =
  '用法: node resolve-symbols.mjs <符号1,符号2 | 文件> --project <项目名> [--prism <CLI>] [--allow-stale] [--json]';

const argv = process.argv.slice(2);
let input = null;
let project = null;
let prismCli = process.env.PRISM_CLI || 'prism';
let allowStale = false;
let asJson = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = () => {
    const v = argv[++i];
    if (v === undefined) { console.error(`参数 ${arg} 缺少取值\n${USAGE}`); process.exit(2); }
    return v;
  };
  if (arg === '--project') project = value();
  else if (arg === '--prism') prismCli = value();
  else if (arg === '--allow-stale') allowStale = true;
  else if (arg === '--json') asJson = true;
  else if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
  else if (arg.startsWith('--')) { console.error(`未知参数: ${arg}\n${USAGE}`); process.exit(2); }
  else if (input) { console.error(`多余的参数: ${arg}\n${USAGE}`); process.exit(2); }
  else input = arg;
}
if (!input || !project) { console.error(USAGE); process.exit(2); }

// 符号清单：文件（每行一个，忽略空行与 # 注释）或逗号分隔
let symbols;
if (existsSync(input) && !input.includes(',')) {
  symbols = readFileSync(input, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
} else {
  symbols = input.split(',').map((s) => s.trim()).filter(Boolean);
}
if (symbols.length === 0) { console.error('未提供任何符号'); process.exit(2); }

// ---- 调用 prism CLI ----
const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(prismCli);
const [cmd, ...baseArgs] = prismCli.split(/\s+/);
const runPrism = (args) => {
  const r = spawnSync(cmd, [...baseArgs, ...args], {
    encoding: 'utf8',
    shell: needsShell,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
};
const parseJson = (raw) => {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
};
const degrade = (reason) => {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, degraded: true, reason }, null, 2));
  } else {
    console.log(`DEGRADED: ${reason}`);
    console.log('→ 降级路径：用文件锚点 + grep（check-anchors.mjs），并在 verdict 记录 `graph: unavailable`');
  }
  process.exit(3);
};

// 1) 图谱状态（不存在/未注册/命令不可用 → 降级）
const st = runPrism(['graph', 'status', project, '--json']);
if (st.error || st.status !== 0) {
  degrade(`prism graph status 失败（${st.error?.code || st.stderr.trim() || `exit ${st.status}`}）`);
}
const stJson = parseJson(st.stdout);
const detail = stJson?.value;
if (!detail) degrade('prism graph status 未返回可解析 JSON');
if (!detail.graph_exists) degrade(`项目 ${project} 没有代码图谱（先 prism graph build <目录> --name ${project}）`);
if (detail.stale && !allowStale) {
  degrade(`图谱陈旧（变更 ${detail.changed_files}/${detail.total_files}）——重建或加 --allow-stale 后人工复核`);
}

// 2) 逐符号解析
const rows = symbols.map((sym) => {
  const r = runPrism(['graph', 'explain', sym, '--project', project, '--json']);
  if (r.error || r.status !== 0) {
    return { symbol: sym, verdict: 'ERROR', id: '', source: '', note: (r.error?.code || r.stderr.trim() || `exit ${r.status}`) };
  }
  const v = parseJson(r.stdout)?.value;
  if (!v) return { symbol: sym, verdict: 'ERROR', id: '', source: '', note: 'JSON 解析失败' };
  if (!v.id) return { symbol: sym, verdict: 'NOT-FOUND', id: '', source: '', note: '图谱中无此节点（幻觉候选）' };
  const m = /^(.*)\s+L(\d+)$/.exec(String(v.source || ''));
  const file = m ? m[1] : String(v.source || '');
  const line = m ? m[2] : '';
  const note = v.degree === undefined ? '' : `degree=${v.degree}`;
  return { symbol: sym, verdict: 'FOUND', id: v.id, source: `${file}${line ? `:${line}` : ''}`, note };
});

// 3) 输出
const found = rows.filter((r) => r.verdict === 'FOUND').length;
const notFound = rows.filter((r) => r.verdict === 'NOT-FOUND').length;
const errors = rows.filter((r) => r.verdict === 'ERROR').length;

if (asJson) {
  console.log(JSON.stringify({ ok: notFound === 0 && errors === 0, graph: detail, rows }, null, 2));
} else {
  console.log('# 符号解析（图优先）');
  console.log('');
  console.log(`- 项目: ${project} / 建图时间: ${detail.built_at ?? '未知'} / 陈旧: ${detail.stale ? `是（${detail.changed_files}/${detail.total_files}）` : '否'}`);
  console.log(`- 结果: FOUND ${found} / NOT-FOUND ${notFound} / ERROR ${errors}`);
  console.log('');
  console.log('| 符号 | 裁决 | 位置 / 节点 id | 备注 |');
  console.log('| :-- | :-- | :-- | :-- |');
  for (const r of rows) console.log(`| ${r.symbol} | ${r.verdict} | ${r.source || r.id || ''} | ${r.note} |`);
  const hits = rows.filter((r) => r.verdict === 'FOUND' && r.source);
  if (hits.length > 0) {
    console.log('');
    console.log('## 可直接转写的锚点骨架（quote 需打开文件取该行逐字子串）');
    console.log('');
    for (const r of hits) {
      const [file, line] = r.source.split(':');
      console.log(`## <id>`);
      console.log(`claim: <断言>（符号 ${r.symbol}）`);
      console.log(`file: ${file}`);
      console.log(`line: ${line}`);
      console.log(`quote: <把 ${file} 第 ${line} 行的逐字子串填在这里>`);
      console.log('');
    }
  }
  if (detail.stale) console.log('\n⚠ 图谱陈旧（--allow-stale）：行号可能偏移，转写锚点后必须跑 check-anchors.mjs 逐字确证。');
}
process.exit(notFound > 0 || errors > 0 ? 1 : 0);
