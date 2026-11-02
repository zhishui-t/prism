#!/usr/bin/env node
/**
 * agent-team DAG 生成器（weave 同款紧凑布局）
 * 读取 <项目>/.agent-team/[<run>/]dag.json，生成同目录 dag.html：
 * 纯 SVG 无外部依赖（离线可用）、左→右分层（层=最长依赖路径深度）、贝塞尔边、
 * 点击节点聚焦其完整上下游链（其余变暗，Esc 解除）。
 *
 * **真刷新（v20.2）**：页面内嵌生成时的数据快照（首屏零等待），加载后每 8 秒
 * `fetch` 重读同目录 dag.json——队长改了任务态，打开着的页面自动跟上。此前用
 * `<meta refresh>` 重载页面但数据拼死在 HTML 里，重载一百次还是旧数据（假刷新）。
 * `file://` 协议下浏览器拦截本地 fetch → 自动降级为快照 + 明示提示（重跑脚本更新）。
 * 布局与交互在页面内完成，与 weave 的 dag-panel（compactDagLayout/computeLevels/relatedTaskIds）同构。
 *
 * 用法：node dag.mjs [项目目录] [任务目录名]（项目目录缺省为当前目录；任务目录名 = .agent-team/<run>/，
 * 同项目多支团队并行时各自一个目录，互不覆盖。省略时：有旧版平铺 dag.json（.agent-team/dag.json）
 * 用平铺；否则恰好一个任务目录就用它；多个则列出全部并退出 1）
 *
 * dag.json 格式：
 * {
 *   "title": "任务名",
 *   "nodes": [ { "id": "n1", "label": "探索架构", "role": "dev-1", "status": "done|running|pending|blocked", "deps": ["n0（可选，与 edges 并集）"] } ],
 *   "edges": [ ["n1", "n2"], ["n1", "n3", "可选边标签（暂不渲染）"] ]
 * }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const base = join(root, ".agent-team");
const runArg = process.argv[3]?.trim() ?? "";

/** 找出全部任务目录（含 dag.json/agents.md/context.md 之一的子目录）。 */
const listRuns = () => {
  let entries = [];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).filter((e) =>
    ["dag.json", "agents.md", "context.md"].some((f) => existsSync(join(base, e.name, f))),
  ).map((e) => e.name).sort();
};

let dir = base;
if (runArg !== "") {
  dir = join(base, runArg);
} else {
  const flat = existsSync(join(base, "dag.json"));
  const runs = listRuns();
  if (!flat) {
    if (runs.length === 1) dir = join(base, runs[0]);
    else if (runs.length > 1) {
      console.error(`.agent-team/ 下有 ${runs.length} 个任务目录，请指定第二个参数：`);
      for (const r of runs) console.error(`  ${r}`);
      process.exit(1);
    }
  }
}
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
const counts = {};
for (const n of nodes) { const s = n.status ?? "pending"; counts[s] = (counts[s] ?? 0) + 1; }
const edgeCount = (Array.isArray(dag.edges) ? dag.edges : []).filter((e) => Array.isArray(e) && e.length >= 2 && e[0] && e[1]).length
  + nodes.reduce((a, n) => a + (Array.isArray(n.deps) ? n.deps.filter(Boolean).length : 0), 0);

/** 页面内渲染器 + 轮询（数据快照作首屏，fetch 成功后重渲染）。 */
const CLIENT = String.raw`
(function () {
  var STATUS = {
    done:    { color: "#52c41a", label: "完成" },
    running: { color: "#1677ff", label: "进行中" },
    pending: { color: "#8c8c8c", label: "待开始" },
    blocked: { color: "#f5222d", label: "受阻/打回" }
  };
  var NODE_W = 150, NODE_H = 36, COL_GAP = 26, ROW_GAP = 10, HANDLE = 14;
  function st(s) { return STATUS[s] || STATUS.pending; }
  function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }

  // 有效边：edges ∪ nodes[].deps 去重（weave effectiveDagEdges 同构）
  function effectiveEdges(dag) {
    var nodes = (Array.isArray(dag.nodes) ? dag.nodes : []).filter(function (n) { return n && n.id; });
    var seen = {}, edges = [];
    function add(from, to) {
      if (!from || !to || from === to) return;
      var k = from + "->" + to;
      if (seen[k]) return;
      seen[k] = 1;
      edges.push({ from: from, to: to });
    }
    (Array.isArray(dag.edges) ? dag.edges : []).forEach(function (e) {
      if (Array.isArray(e) && e.length >= 2 && e[0] && e[1]) add(e[0], e[1]);
    });
    nodes.forEach(function (n) {
      (Array.isArray(n.deps) ? n.deps : []).forEach(function (d) { add(d, n.id); });
    });
    return { nodes: nodes, edges: edges };
  }

  // 层级 = 最长依赖路径深度（环安全），列=层级、行=层内 id 稳定排序（weave compactDagLayout 同构）
  function layout(dag) {
    var g = effectiveEdges(dag);
    var upstream = {};
    g.edges.forEach(function (e) { (upstream[e.to] = upstream[e.to] || []).push(e.from); });
    var level = {};
    function visit(id) {
      if (level[id] !== undefined) return level[id];
      level[id] = 0;
      var ups = upstream[id] || [];
      var lv = ups.length === 0 ? 0 : Math.max.apply(null, ups.map(visit)) + 1;
      level[id] = lv;
      return lv;
    }
    g.nodes.forEach(function (n) { visit(n.id); });
    var byLevel = {};
    g.nodes.forEach(function (n) {
      var lv = level[n.id] || 0;
      (byLevel[lv] = byLevel[lv] || []).push(n);
    });
    var stages = Object.keys(byLevel).map(Number).sort(function (a, b) { return a - b; });
    var pos = {}, laid = [];
    stages.forEach(function (col) {
      var group = byLevel[col].slice().sort(function (a, b) { return a.id.localeCompare(b.id, "en", { numeric: true }); });
      group.forEach(function (n, row) {
        var x = col * (NODE_W + COL_GAP), y = row * (NODE_H + ROW_GAP);
        pos[n.id] = { x: x, y: y };
        laid.push({ n: n, x: x, y: y });
      });
    });
    var rows = Math.max.apply(null, [1].concat(stages.map(function (lv) { return byLevel[lv].length; })));
    var w = stages.length ? stages.length * NODE_W + (stages.length - 1) * COL_GAP : 0;
    var h = stages.length ? rows * NODE_H + (rows - 1) * ROW_GAP : 0;
    var paths = [];
    g.edges.forEach(function (e) {
      var s = pos[e.from], t = pos[e.to];
      if (!s || !t) return;
      var x1 = s.x + NODE_W, y1 = s.y + NODE_H / 2, x2 = t.x, y2 = t.y + NODE_H / 2;
      paths.push({ from: e.from, to: e.to, d: "M" + x1 + " " + y1 + "C" + (x1 + HANDLE) + " " + y1 + "," + (x2 - HANDLE) + " " + y2 + "," + x2 + " " + y2 });
    });
    return { laid: laid, paths: paths, w: w, h: h, nodes: g.nodes };
  }

  var focused = null;

  function render(dag, source) {
    var L = layout(dag);
    var counts = {};
    L.nodes.forEach(function (n) { var s = n.status || "pending"; counts[s] = (counts[s] || 0) + 1; });
    var legend = Object.keys(STATUS).map(function (k) {
      return '<span class="chip"><i style="background:' + STATUS[k].color + '"></i>' + STATUS[k].label + ' ' + (counts[k] || 0) + '</span>';
    }).join("");
    var nodeSvg = L.laid.map(function (p) {
      var n = p.n, c = st(n.status).color;
      var label = trunc(n.label || n.id, 20), role = n.role ? trunc(n.role, 18) : "";
      return '<g class="node" data-id="' + esc(n.id) + '" transform="translate(' + p.x + ',' + p.y + ')" tabindex="0">' +
        '<rect width="' + NODE_W + '" height="' + NODE_H + '" rx="6" fill="#ffffff" stroke="#d9d9d9"/>' +
        '<path d="M0.5 6 A5.5 5.5 0 0 1 6 0.5 L3 0.5 L3 ' + (NODE_H - 0.5) + ' L6 ' + (NODE_H - 0.5) + ' A5.5 5.5 0 0 1 0.5 ' + (NODE_H - 6) + ' Z" fill="' + c + '"/>' +
        '<text x="10" y="15" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10" font-weight="700" fill="#262626">' + esc(label) + (role ? ' <tspan fill="#8c8c8c" font-weight="400">(' + esc(role) + ')</tspan>' : '') + '</text>' +
        '<circle cx="13" cy="26" r="2.5" fill="' + c + '"/>' +
        '<text x="20" y="29" font-size="8.5" font-weight="600" fill="' + c + '">' + esc(st(n.status).label) + '</text>' +
        (n.note ? '<text x="' + (NODE_W - 6) + '" y="29" text-anchor="end" font-size="8.5" fill="#8c8c8c">' + esc(trunc(n.note, 14)) + '</text>' : '') +
        '</g>';
    }).join("\n");
    document.getElementById("title").textContent = dag.title || "Agent Team DAG";
    document.getElementById("legend").innerHTML = legend;
    var svg = document.getElementById("dag");
    svg.setAttribute("width", Math.max(L.w, 100));
    svg.setAttribute("height", Math.max(L.h, 60));
    svg.innerHTML = L.paths.map(function (p) { return '<path data-from="' + esc(p.from) + '" data-to="' + esc(p.to) + '" d="' + p.d + '"/>'; }).join("\n") + "\n" + nodeSvg;
    bindFocus();
    applyFocus();
    document.getElementById("meta").textContent =
      "更新于 " + new Date().toLocaleTimeString() + " · " + source + " · 每 8 秒重读 dag.json";
  }

  // 聚焦：点节点亮上下游链（weave relatedTaskIds 同构——两侧独立 seen）
  function relatedMap() {
    var edges = [].map.call(document.querySelectorAll("path[data-from]"), function (p) {
      return { from: p.dataset.from, to: p.dataset.to, el: p };
    });
    var nodes = [].map.call(document.querySelectorAll("g.node"), function (g) { return { id: g.dataset.id, el: g }; });
    var upstream = {}, downstream = {};
    edges.forEach(function (e) {
      (downstream[e.from] = downstream[e.from] || []).push(e.to);
      (upstream[e.to] = upstream[e.to] || []).push(e.from);
    });
    return { edges: edges, nodes: nodes };
  }
  function applyFocus() {
    var r = relatedMap();
    var related = null;
    if (focused) {
      related = {};
      (function up(id, seen) { if (seen[id]) return; seen[id] = 1; related[id] = 1; (upstreamOf(r, id)).forEach(function (x) { up(x, seen); }); })(focused, {});
      (function dn(id, seen) { if (seen[id]) return; seen[id] = 1; related[id] = 1; (downstreamOf(r, id)).forEach(function (x) { dn(x, seen); }); })(focused, {});
    }
    r.nodes.forEach(function (n) { n.el.classList.toggle("dimmed", !!related && !related[n.id]); });
    r.edges.forEach(function (e) {
      var active = !!related && !!related[e.from] && !!related[e.to];
      e.el.classList.toggle("active", active);
      e.el.classList.toggle("dimmed", !!related && !active);
    });
  }
  function upstreamOf(r, id) { var o = []; r.edges.forEach(function (e) { if (e.to === id) o.push(e.from); }); return o; }
  function downstreamOf(r, id) { var o = []; r.edges.forEach(function (e) { if (e.from === id) o.push(e.to); }); return o; }
  function bindFocus() {
    [].forEach.call(document.querySelectorAll("g.node"), function (g) {
      g.addEventListener("click", function () { focused = focused === g.dataset.id ? null : g.dataset.id; applyFocus(); });
      g.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); focused = focused === g.dataset.id ? null : g.dataset.id; applyFocus(); }
      });
    });
  }
  window.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { focused = null; applyFocus(); } });

  // 真刷新：每 8 秒重读同目录 dag.json（file:// 被拦则明示降级为快照）
  render(window.DATA, "生成时快照");
  var polling = true;
  function poll() {
    if (!polling) return;
    fetch("dag.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (dag) { render(dag, "dag.json 实时"); })
      .catch(function () {
        polling = false;
        document.getElementById("meta").textContent +=
          " · 此环境无法自动重读 dag.json（file:// 限制）——数据为生成时快照，重跑脚本可更新";
      });
  }
  setInterval(poll, 8000);
})();
`;

const now = new Date().toISOString().replace("T", " ").slice(0, 19);
const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${dag.title ?? "Agent Team DAG"}</title>
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
<h1 id="title"></h1>
<div class="meta" id="meta">生成于 ${now} UTC</div>
<div id="legend"></div>
<div class="viewport">
<svg id="dag" width="100" height="60" style="display:block;overflow:visible"></svg>
</div>
<div class="hint">点击节点：聚焦它的完整上下游链（其余变暗）；Esc 或再点一次：解除。</div>
<script>
window.DATA = ${JSON.stringify(dag).replace(/</g, "\\u003c")};
${CLIENT}
</script>
</body>
</html>
`;

writeFileSync(htmlPath, html, "utf8");
console.log(`DAG 已生成：${htmlPath}`);
console.log(`节点 ${nodes.length}（完成 ${counts.done ?? 0} / 进行中 ${counts.running ?? 0} / 待开始 ${counts.pending ?? 0} / 受阻 ${counts.blocked ?? 0}），边（含 deps 并入）约 ${edgeCount}`);
