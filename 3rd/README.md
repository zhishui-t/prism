# 3rd —— 第三方子工程（vendored）

本目录收录 Prism 依赖的外部工具，**以子工程形式引入**（源码进仓库，产物本地构建）。

| 目录 | 上游 | 版本 | 许可证 | 形态 | 调用方式 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `archify/` | [tt-a1i/archify](https://github.com/tt-a1i/archify) | **v2.16.0** | MIT | 自包含 CLI（零运行时依赖） | `node 3rd/archify/bin/archify.mjs <cmd>` |
| `graphify/` | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | **v0.9.56** | Apache-2.0（含 MIT 双许可） | Python 源码（免构建，PYTHONPATH 直跑） | `python -m graphify <cmd>`（PYTHONPATH=3rd/graphify） |

## 为什么 vendored 而不是依赖 npm

- **archify**：上游 `private: true`，**未发布 npm**（npm 上的 `archify` 属另一个无关包）。
- **graphify**：Prism 采用 **Python 实现**（Graphify-Labs 上游，PyPI 包名 `graphifyy`，输出 `graphify-out/`）。npm 的 `@sentropic/graphify` 是该仓库的 Node fork 分支（另一套产物目录与命令面），不采用。两仓库共享 2026-04 的 v1.0.0 旧 tag，勿混淆版本序。

## archify（v2.16.0）

自包含，**无需构建**。已裁剪非运行必需目录（`test/`、`recipes/`、`references/`、`brand-marks/`），保留：

```
3rd/archify/
├── bin/archify.mjs          # CLI 入口
├── renderers/               # 五类图渲染器
├── schemas/                 # JSON-IR schema（校验器）
├── assets/template.html     # 输出模板
├── delta/                   # Before/Delta/After 对比
├── migrations/              # schema 迁移
├── scripts/check-render-output.mjs
├── examples/*.json          # 官方示例（仅 JSON，HTML 产物已剔除）
└── LICENSE / package.json
```

验证：

```bash
node 3rd/archify/bin/archify.mjs --help
node 3rd/archify/bin/archify.mjs demo /tmp/archify-demo
```

## graphify（v0.9.56，Python）

**免构建**：纯 Python 包，经 `PYTHONPATH=3rd/graphify python -m graphify <cmd>` 直跑（Prism 封装已自动注入，不污染 site-packages）。只需安装一次运行依赖：

```bash
pnpm run 3rd:build          # pip 安装 tree-sitter 系列 + networkx/numpy/rapidfuzz
pnpm run 3rd:check          # 可用性自检（archify + graphify + 依赖）
```

已裁剪 `tests/`、`docs/`、`tools/`、`worked/`、`scripts/`（非运行必需）。保留：

```
3rd/graphify/
├── graphify/                # Python 包源码（__main__.py = CLI）
├── pyproject.toml           # version 0.9.56（PyPI graphifyy 同版）
├── uv.lock                  # 依赖锁（复现安装）
├── LICENSE / LICENSE-MIT / NOTICE
└── README.md / ARCHITECTURE.md / CHANGELOG.md
```

**命令面与产物**（与 npm fork 不同）：
- 建图：`graphify <path>`（tree-sitter AST，零 LLM）→ `<path>/graphify-out/graph.json` + `manifest.json`
- 报告/可视化：`graphify cluster-only <path> --no-label`（零 LLM）→ `GRAPH_REPORT.md` + `graph.html`（自包含）
- 查询：`query "<q>" --graph <path>` / `path "A" "B"` / `explain "X"` / `affected "X"` / `god-nodes`
- 增量：`graphify update <path>`（无 LLM）；manifest 带 `ast_hash`（MD5）与 mtime（**秒**，非毫秒——Prism 已做单位归一）

**要求**：Python ≥3.10（本机 3.12）。

## 升级流程

1. 取上游新 tag：`git clone --depth 1 --branch <tag> <repo>`；
2. 同步本目录（保持上述裁剪范围）；
3. 更新本文档表格中的版本号；
4. archify 直接验证 CLI；graphify 执行 `pnpm run 3rd:build && pnpm run 3rd:check`；
5. 跑 `pnpm test`（Prism 侧封装有集成测试）。

## 许可证

- archify：**MIT**（目录内保留原文）。
- graphify：**Apache-2.0**（主许可）+ 附 **MIT** 双许可文件与 NOTICE（上游原样保留）。
- 再分发时须一并保留各目录下的许可与声明文件。
