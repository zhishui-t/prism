#!/usr/bin/env node
/**
 * check-anchors.mjs — 锚点账本机械核查（design-verify 第 1 步 · 机械层）
 *
 * 用法:
 *   node check-anchors.mjs <anchors.md> [--root <dir>] [--only A1,A3]
 *
 * 账本格式（见 templates/anchors.md）:
 *   ## <id>        起一条锚点（id 单 token；`###` 小节与正文不算锚点）
 *   claim: <断言>  人读断言，不参与核查
 *   文件锚点:  file: <路径>  line: <行号,可选>  quote: <单行逐字子串>
 *   grep 锚点:  grep: <字面子串,非正则>  path: <文件或目录>  count: <期望出现次数; 0=断言已不存在>
 *   路径相对 --root（缺省当前目录）解析；目录递归时跳过 .git 与 node_modules，
 *   并跳过账本自身与 <root>/.design-verify/verdict.md（防自引用凑数造成假 OK）。
 *
 * 裁决:
 *   OK              核对通过
 *   WRONG-LINE      引文在文件里但不在锚定行（锚点漂移）——动作项：刷新行号，不堵门禁
 *   COUNT-MISMATCH  grep 计数与期望不符——动作项：刷新计数；found=0 需人工确认是否已不存在
 *   FABRICATED      引文在文件中找不到——BLOCKER：编造
 *   MISSING-FILE    文件/路径不存在——BLOCKER
 *   FORMAT-ERROR    锚点缺关键字段/格式坏（含非法/重复 id）——BLOCKER：无法核查的锚点不许静默跳过
 *   READ-ERROR      目标读取失败（权限/坏软链等）——BLOCKER：无法核查
 *
 * 退出码: 0 = 无 BLOCKER；1 = 存在 BLOCKER；2 = 用法/账本错误
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const USAGE =
  '用法: node check-anchors.mjs <anchors.md> [--root <dir>] [--only A1,A3]';

// ---- 参数解析（用法错误一律 exit 2，不冒充 BLOCKER） ----
const argv = process.argv.slice(2);
let ledgerFile = null;
let root = process.cwd();
let only = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = () => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) {
      console.error(`参数 ${arg} 缺少取值\n${USAGE}`);
      process.exit(2);
    }
    return v;
  };
  if (arg === '--root') root = resolve(value());
  else if (arg === '--only') {
    const set = new Set(value().split(',').map((s) => s.trim()).filter(Boolean));
    if (set.size === 0) {
      console.error(`--only 需要至少一个锚点 id\n${USAGE}`);
      process.exit(2);
    }
    only = set;
  } else if (arg === '-h' || arg === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (arg.startsWith('--')) {
    console.error(`未知参数: ${arg}\n${USAGE}`);
    process.exit(2);
  } else if (ledgerFile) {
    console.error(`多余的参数: ${arg}\n${USAGE}`);
    process.exit(2);
  } else {
    ledgerFile = arg;
  }
}
if (!ledgerFile) { console.error(USAGE); process.exit(2); }
if (!existsSync(ledgerFile)) { console.error(`账本不存在: ${ledgerFile}`); process.exit(2); }

// ---- 解析账本 ----
const KEYS = new Set(['claim', 'file', 'line', 'quote', 'grep', 'path', 'count']);
const ANCHOR_HEAD = /^##\s+(\S+)\s*$/;
let ledgerText;
try {
  ledgerText = readFileSync(ledgerFile, 'utf8');
} catch (e) {
  console.error(`账本读取失败: ${e.code || e.message}`);
  process.exit(2);
}
const lines = (ledgerText.startsWith('\uFEFF') ? ledgerText.slice(1) : ledgerText).split(/\r?\n/);

const anchors = [];
let cur = null;
for (let idx = 0; idx < lines.length; idx++) {
  const raw = lines[idx];
  const head = ANCHOR_HEAD.exec(raw);
  if (head) {
    cur = { id: head[1], claim: '' };
    anchors.push(cur);
    continue;
  }
  // 二级标题但不是合法锚点头：记为 FORMAT-ERROR，并断开上文，禁止字段覆写前一条锚点
  if (/^##(?!#)/.test(raw)) {
    cur = null;
    anchors.push({ id: `L${idx + 1}`, claim: '', __formatError: `非法锚点头（应形如 "## A1"）：${raw.trim()}` });
    continue;
  }
  // 其他级别标题（### 等）是小节分隔，断开上文但不报错
  if (/^#{1,6}\s/.test(raw)) { cur = null; continue; }
  if (!cur) continue;
  const kv = /^([A-Za-z-]+):\s?(.*)$/.exec(raw);
  if (kv && KEYS.has(kv[1].toLowerCase())) cur[kv[1].toLowerCase()] = kv[2].trim();
}

if (anchors.length === 0) { console.error('账本中未找到任何 `## <id>` 锚点条目'); process.exit(2); }

// 重复 id 会让 --only 与人工抽查失去指向性 → 计 FORMAT-ERROR
const idCount = new Map();
for (const a of anchors) idCount.set(a.id, (idCount.get(a.id) || 0) + 1);
for (const a of anchors) {
  if (!a.__formatError && idCount.get(a.id) > 1) {
    a.__formatError = `锚点 id 重复（${a.id} 出现 ${idCount.get(a.id)} 次）`;
  }
}

const picked = only ? anchors.filter((a) => only.has(a.id)) : anchors;
if (picked.length === 0) {
  console.error(`--only 指定的 id 均不在账本中: ${[...only].join(', ')}`);
  process.exit(2);
}

// ---- 工具函数 ----
const looksBinary = (s) => s.includes('\u0000');
const countIn = (text, needle) => {
  if (!needle) return 0;
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    n++;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
};
const toAbs = (p) => (isAbsolute(p) ? p : join(root, p));
// Windows 文件系统大小写不敏感：比较前归一化，防同路径不同大小写漏跳（自引用凑数）
const key = (p) => resolve(p).replaceAll('\\', '/').toLowerCase();
const skipAbs = new Set([key(ledgerFile), key(join(root, '.design-verify', 'verdict.md'))]);
const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (skipAbs.has(key(p))) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

// ---- 逐条核查 ----
const READ = (p) => {
  const t = readFileSync(p, 'utf8');
  return t.startsWith('\uFEFF') ? t.slice(1) : t;
};

const checkFileAnchor = (a) => {
  try {
    const p = toAbs(a.file);
    if (!existsSync(p)) return [a, 'MISSING-FILE', a.file];
    if (statSync(p).isDirectory()) return [a, 'MISSING-FILE', `${a.file}（目标路径是目录，不是文件）`];
    const text = READ(p);
    if (looksBinary(text)) return [a, 'FORMAT-ERROR', `${a.file} 疑似二进制文件，quote 无法逐字核对`];
    const fileLines = text.split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < fileLines.length; i++) if (fileLines[i].includes(a.quote)) hits.push(i + 1);
    if (a.line !== undefined) {
      const ln = Number(a.line);
      if (!Number.isInteger(ln) || ln < 1) return [a, 'FORMAT-ERROR', `line 取值非法: ${a.line}`];
      if (ln <= fileLines.length && fileLines[ln - 1].includes(a.quote)) return [a, 'OK', `${a.file}:${ln}`];
      if (hits.length > 0) {
        return [a, 'WRONG-LINE', `引文实际在 ${hits.slice(0, 3).join(', ')} 行（锚定 ${a.line}）——刷新锚点`];
      }
      return [a, 'FABRICATED', `引文未见于 ${a.file}（全文 ${fileLines.length} 行）`];
    }
    if (hits.length > 0) return [a, 'OK', `见于第 ${hits[0]} 行`];
    return [a, 'FABRICATED', `引文未见于 ${a.file}`];
  } catch (e) {
    return [a, 'READ-ERROR', `读取失败: ${e.code || e.message}`];
  }
};

const checkGrepAnchor = (a) => {
  if (!a.grep) return [a, 'FORMAT-ERROR', 'grep 锚点需要非空 grep 子串'];
  if (!a.path || a.count === undefined || a.count === '') {
    return [a, 'FORMAT-ERROR', 'grep 锚点需要 path 与 count'];
  }
  const want = Number(a.count);
  if (!Number.isInteger(want) || want < 0) return [a, 'FORMAT-ERROR', `count 取值非法: ${a.count}`];
  try {
    const p = toAbs(a.path);
    if (!existsSync(p)) return [a, 'MISSING-FILE', a.path];
    let found = 0;
    if (statSync(p).isDirectory()) {
      for (const f of walk(p)) {
        const t = READ(f);
        if (!looksBinary(t)) found += countIn(t, a.grep);
      }
    } else {
      const t = READ(p);
      if (!looksBinary(t)) found = countIn(t, a.grep);
    }
    if (found === want) return [a, 'OK', `count=${found}`];
    const note = found === 0 ? '（可能已不存在，需人工确认）' : '';
    return [a, 'COUNT-MISMATCH', `found=${found} expected=${want}${note}`];
  } catch (e) {
    return [a, 'READ-ERROR', `读取失败: ${e.code || e.message}`];
  }
};

const checkAnchor = (a) => {
  if (a.__formatError) return [a, 'FORMAT-ERROR', a.__formatError];
  if (a.grep !== undefined) return checkGrepAnchor(a);
  if (!a.file || !a.quote) return [a, 'FORMAT-ERROR', '文件锚点需要 file 与 quote'];
  return checkFileAnchor(a);
};
const rows = picked.map(checkAnchor);

// ---- 输出 ----
const esc = (s) => String(s).replaceAll('|', '\\|');
const BLOCKERS = new Set(['FABRICATED', 'MISSING-FILE', 'FORMAT-ERROR', 'READ-ERROR']);
const counts = {};
for (const [, v] of rows) counts[v] = (counts[v] || 0) + 1;
const blockers = rows.filter(([, v]) => BLOCKERS.has(v));

console.log('# 锚点核查裁决表');
console.log('');
console.log(`- 账本: \`${ledgerFile}\`（核查 ${rows.length} 条，基准目录 \`${root}\`）`);
console.log(`- 时间: ${new Date().toISOString()}`);
console.log('');
console.log('| # | 断言 | 裁决 | 详情 |');
console.log('| :-- | :-- | :-- | :-- |');
for (const [a, v, d] of rows) console.log(`| ${a.id} | ${esc(a.claim || '')} | ${v} | ${esc(d)} |`);
console.log('');
console.log('## 汇总');
console.log('');
console.log(`- ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' / ')}`);
console.log(
  `- BLOCKER（FABRICATED + MISSING-FILE + FORMAT-ERROR + READ-ERROR）：${blockers.length} 条` +
    (blockers.length ? ' —— 不清零不过第 1 步门禁：' + blockers.map(([a]) => a.id).join(', ') : ''),
);
process.exit(blockers.length ? 1 : 0);
