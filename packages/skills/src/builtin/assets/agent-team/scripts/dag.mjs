#!/usr/bin/env node
/**
 * agent-team DAG 生成器（weave 同款紧凑布局）
 * 读取 <项目>/.agent-team/dag.json，生成同目录 dag.html：
 * 纯 SVG 无外部依赖（离线可用）、左→右分层（层=最长依赖路径深度）、贝塞尔边、
 * 点击节点聚焦其完整上下游链（其余变暗，Esc 解除）、8 秒自动刷新。
 * 布局数学与 weave 的 src/plugins/weave/ui/dag-panel.tsx（compactDagLayout/computeLevels/relatedTaskIds）同构。
 *
 * 用法：node dag.mjs [项目目录]（缺省为当前目录）
 *
 * dag.json 格式：
 * {
 *   "title": "任务名",
 *   "nodes": [ { "id": "n1", "label": "探索架构", "role": "dev-1", "status": "done|running|pending|blocked", "deps": ["n0（可选，与 edges 并集）"] } ],
 *   "edges": [ ["n1", "n2"], ["n1", "n3", "可选边标签（暂不渲染）"] ]
 * }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const dir = join(root, ".agent-team");
const jsonPath = join(dir, "dag.json");
const htmlPath = join(dir, "dag.html");

if (!existsSync(jsonPath)) {
  mkdirSync(dir, { recursive: true });
  const template = {
    title: "任务 DAG（模板，请队长填写）",
    nodes: [
      { id: "clarify", label: "需求澄清", role: "队长", status: "done" },
      { id: "explore", label: "前期探索", role: "开发+调研", status: "running" },
      { id: "design", label: "设计+审核", role: "队长+审核", status: "pending" },
      { id: "develop", label: "开发+自测", role: "开发×N流", status: "pending" },
      { id: "test", label: "功能+E2E测试", role: "测试", status: "pending" },
      { id: "qa", label: "总审+修复", role: "审核", status: "pending" },
      { id: "deliver", label: "交付验收", role: "队长", status: "pending" },
    ],
    edges: [["clarify", "explore"], ["explore", "design"], ["design", "develop"], ["develop", "test"], ["test", "qa"], ["qa", "deliver"]],
  };
  writeFileSync(jsonPath, JSON.stringify(template, null, 2), "utf8");
  console.log(`已初始化模板 ${jsonPath}，队长填写后请重新运行本脚本。`);
}

const dag = JSON.parse(readFileSync(jsonPath, "utf8"));
const nodes = Array.isArray(dag.nodes) ? dag.nodes.filter((n) => n && n.id) : [];
const edgePairs = (Array.isArray(dag.edges) ? dag.edges : [])
  .filter((e) => Array.isArray(e) && e.length >= 2 && e[0] && e[1])
  .map((e) => ({ from: e[0], to: e[1] }));

/* ---------- 状态配色（对齐 weave STATUS_COLORS） ---------- */
const STATUS = {
  done:    { color: "#52c41a", label: "完成" },
  running: { color: "#1677ff", label: "进行中" },
  pending: { color: "#8c8c8c", label: "待开始" },
  blocked: { color: "#f5222d", label: "受阻/打回" },
};
const st = (s) => STATUS[s] ?? STATUS.pending;

/* ---------- 有效边：edges 优先，nodes[].deps 并入去重（weave effectiveDagEdges 语义） ---------- */
const seen = new Set();
const edges = [];
for (const e of edgePairs) {
  const k = `${e.from}->${e.to}`;
  if (e.from === e.to || seen.has(k)) continue;
  seen.add(k);
  edges.push(e);
}
for (const n of nodes) {
  for (const d of Array.isArray(n.deps) ? n.deps : []) {
    const k = `${d}->${n.id}`;
    if (!d || d === n.id || seen.has(k)) continue;
    seen.add(k);
    edges.push({ from: d, to: n.id });
  }
}

/* ---------- 层级 = 最长依赖路径深度（环安全，weave computeLevels 同构） ---------- */
const upstream = new Map(); // to -> [from]
for (const e of edges) {
  const arr = upstream.get(e.to) ?? [];
  arr.push(e.from);
  upstream.set(e.to, arr);
}
const level = new Map();
const visit = (id) => {
  const c = level.get(id);
  if (c !== undefined) return c;
  level.set(id, 0); // 先置 0：含环也能终止
  const ups = upstream.get(id) ?? [];
  const lv = ups.length === 0 ? 0 : Math.max(...ups.map(visit)) + 1;
  level.set(id, lv);
  return lv;
};
for (const n of nodes) visit(n.id);

/* ---------- 紧凑布局：列=层级，行=层内 id 稳定排序（weave compactDagLayout 同构） ---------- */
const NODE_W = 150, NODE_H = 36, COL_GAP = 26, ROW_GAP = 10, HANDLE = 14;
const byLevel = new Map();
for (const n of nodes) {
  const lv = level.get(n.id) ?? 0;
  const g = byLevel.get(lv) ?? [];
  g.push(n);
  byLevel.set(lv, g);
}
const stages = [...byLevel.entries()].sort((a, b) => a[0] - b[0]);
const pos = new Map();
const laid = [];
for (const [col, [, group]] of stages.entries()) {
  const ordered = group.slice().sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  for (const [row, n] of ordered.entries()) {
    const x = col * (NODE_W + COL_GAP);
    const y = row * (NODE_H + ROW_GAP);
    pos.set(n.id, { x, y });
    laid.push({ n, x, y });
  }
}
const rows = Math.max(1, ...stages.map(([, g]) => g.length));
const width = stages.length ? stages.length * NODE_W + (stages.length - 1) * COL_GAP : 0;
const height = stages.length ? rows * NODE_H + (rows - 1) * ROW_GAP : 0;

/* ---------- 边：短柄三次贝塞尔（水平出入节点中线，weave 同款） ---------- */
const paths = [];
for (const e of edges) {
  const s = pos.get(e.from), t = pos.get(e.to);
  if (!s || !t) continue;
  const x1 = s.x + NODE_W, y1 = s.y + NODE_H / 2, x2 = t.x, y2 = t.y + NODE_H / 2;
  paths.push({ from: e.from, to: e.to, d: `M${x1} ${y1}C${x1 + HANDLE} ${y1},${x2 - HANDLE} ${y2},${x2} ${y2}` });
}

/* ---------- SVG 节点/图例 ---------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const trunc = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

const nodeSvg = laid.map(({ n, x, y }) => {
  const c = st(n.status).color;
  const label = trunc(n.label ?? n.id, 20);
  const role = n.role ? trunc(n.role, 18) : "";
  return `<g class="node" data-id="${esc(n.id)}" transform="translate(${x},${y})" tabindex="0">
  <rect width="${NODE_W}" height="${NODE_H}" rx="6" fill="#ffffff" stroke="#d9d9d9"/>
  <path d="M0.5 6 A5.5 5.5 0 0 1 6 0.5 L3 0.5 L3 ${NODE_H - 0.5} L6 ${NODE_H - 0.5} A5.5 5.5 0 0 1 0.5 ${NODE_H - 6} Z" fill="${c}"/>
  <text x="10" y="15" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10" font-weight="700" fill="#262626">${esc(label)}${role ? ` <tspan fill="#8c8c8c" font-weight="400">(${esc(role)})</tspan>` : ""}</text>
  <circle cx="13" cy="26" r="2.5" fill="${c}"/>
  <text x="20" y="29" font-size="8.5" font-weight="600" fill="${c}">${esc(st(n.status).label)}</text>
  ${n.note ? `<text x="${NODE_W - 6}" y="29" text-anchor="end" font-size="8.5" fill="#8c8c8c">${esc(trunc(n.note, 14))}</text>` : ""}
</g>`;
}).join("\n");

const counts = {};
for (const n of nodes) { const s = n.status ?? "pending"; counts[s] = (counts[s] ?? 0) + 1; }
const legend = Object.entries(STATUS)
  .map(([k, v]) => `<span class="chip"><i style="background:${v.color}"></i>${v.label} ${counts[k] ?? 0}</span>`)
  .join("");
const now = new Date().toISOString().replace("T", " ").slice(0, 19);

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="8">
<title>${esc(dag.title ?? "Agent Team DAG")}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; background: #fafafa; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 12px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; margin-right: 12px; font-size: 12px; color: #4b5563; }
  .chip i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .viewport { overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
  .node { cursor: pointer; outline: none; }
  .node:focus, .node:hover rect { stroke: #1677ff; }
  .node.dimmed, path.dimmed { opacity: 0.24; }
  path { stroke: #999999; stroke-width: 1; fill: none; }
  path.active { stroke: #1677ff; stroke-width: 1.6; }
  .hint { color: #9ca3af; font-size: 11px; margin-top: 8px; }
</style>
</head>
<body>
<h1>${esc(dag.title ?? "Agent Team DAG")}</h1>
<div class="meta">更新于 ${now} UTC · 每 8 秒自动刷新 · 布局与交互对齐 weave DagPanel</div>
<div>${legend}</div>
<div class="viewport">
<svg width="${Math.max(width, 100)}" height="${Math.max(height, 60)}" style="display:block;overflow:visible">
${paths.map((p) => `<path data-from="${esc(p.from)}" data-to="${esc(p.to)}" d="${p.d}"/>`).join("\n")}
${nodeSvg}
</svg>
</div>
<div class="hint">点击节点：聚焦它的完整上下游链（其余变暗）；Esc 或再点一次：解除。</div>
<script>
(function () {
  var edges = [].map.call(document.querySelectorAll("path[data-from]"), function (p) {
    return { from: p.dataset.from, to: p.dataset.to, el: p };
  });
  var nodes = [].map.call(document.querySelectorAll("g.node"), function (g) {
    return { id: g.dataset.id, el: g };
  });
  var upstream = {}, downstream = {};
  edges.forEach(function (e) {
    (downstream[e.from] = downstream[e.from] || []).push(e.to);
    (upstream[e.to] = upstream[e.to] || []).push(e.from);
  });
  var focused = null;
  function apply() {
    var related = null;
    if (focused) {
      related = {};
      // 上下游各用独立 seen 集（weave relatedTaskIds 同构）：起点会被两侧都标记，
      // 共用 seen 会让后跑的一侧在起点处提前 return、整条链丢失。
      (function up(id, seen) { if (seen[id]) return; seen[id] = 1; related[id] = 1; (upstream[id] || []).forEach(function (x) { up(x, seen); }); })(focused, {});
      (function dn(id, seen) { if (seen[id]) return; seen[id] = 1; related[id] = 1; (downstream[id] || []).forEach(function (x) { dn(x, seen); }); })(focused, {});
    }
    nodes.forEach(function (n) { n.el.classList.toggle("dimmed", !!related && !related[n.id]); });
    edges.forEach(function (e) {
      var active = !!related && !!related[e.from] && !!related[e.to];
      e.el.classList.toggle("active", active);
      e.el.classList.toggle("dimmed", !!related && !active);
    });
  }
  nodes.forEach(function (n) {
    n.el.addEventListener("click", function () { focused = focused === n.id ? null : n.id; apply(); });
    n.el.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); focused = focused === n.id ? null : n.id; apply(); }
    });
  });
  window.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { focused = null; apply(); } });
})();
</script>
</body>
</html>
`;

writeFileSync(htmlPath, html, "utf8");
console.log(`DAG 已生成：${htmlPath}`);
console.log(`节点 ${nodes.length}（完成 ${counts.done ?? 0} / 进行中 ${counts.running ?? 0} / 待开始 ${counts.pending ?? 0} / 受阻 ${counts.blocked ?? 0}），边 ${paths.length}`);
