# 3rd —— 第三方依赖（git submodule）

本目录收录 Prism 依赖的全部外部工具，**以 git submodule 形式引入并锁定上游发布 tag**。
源码不进本仓（只存 gitlink），克隆后需初始化子模块；构建产物与模型落在 gitignore 的
运行时目录，不污染子模块。

```bash
git submodule update --init --recursive   # 克隆后初始化（或用 git clone --recurse-submodules）
```

| 目录 | 上游 | 锁定版本 | 许可证 | 形态 | 构建 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `archify/` | [tt-a1i/archify](https://github.com/tt-a1i/archify) | **v2.16.0** | MIT | Node CLI（自包含，**免构建**） | 无 |
| `graphify/` | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | **v0.9.57** | Apache-2.0（含 MIT 双许可） | Python 源码（**免构建**，PYTHONPATH 直跑） | 装 Python 依赖 |
| `llama.cpp/` | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | **b10883** | MIT | C++ 源码（**需编译**） | 本地 MinGW+CMake 编译 |

> 运行时目录（gitignored，由脚本生成，不在 submodule 内）：
> `3rd/llama-runtime/{bin,bin-vulkan,models}` —— llama-server 二进制 + 下载的 GGUF 模型。

## 为什么用 submodule 而不是 vendored 源码 / npm

- **可升级、可审计**：锁定上游发布 tag，`git submodule update` 即可升级，不把第三方源码
  混进本仓历史（此前 vendored 方式产生 291 个跟踪文件，升级即产生巨大 diff）。
- **archify**：上游 `private: true`，**未发布 npm**（npm 的 `archify` 属另一个无关包）。
- **graphify**：Prism 采用 **Python 实现**（Graphify-Labs 上游，PyPI 名 `graphifyy`，
  产物 `graphify-out/`）。npm 的 `@sentropic/graphify` 是另一套 Node fork，不采用。
  **注意**：上游 `v1.0.0` tag 是一次「Claude Code skill」形态的重写（CLI 面完全不同），
  与 `0.9.x` 不兼容，故锁定最后一个兼容发布 **v0.9.57**。
- **llama.cpp**：官方未发布可依赖的库，且需按本机算力编译（CPU/GPU 参数不同），
  故源码 submodule + 本地编译；b10883 是同时提供源码与预编译 release 的最新 tag。

## archify（v2.16.0，免构建）

上游仓库根的 `archify/` 子目录才是 CLI 包：

```
3rd/archify/
├── archify/bin/archify.mjs     # CLI 入口（注意多一层 archify/）
├── archify/renderers/          # 五类图渲染器
├── archify/schemas/            # JSON-IR schema（校验器）
├── archify/assets/template.html
├── archify/examples/*.json     # 官方示例（Prism 测试用）
└── LICENSE / package.json
```

```bash
node 3rd/archify/archify/bin/archify.mjs --help
node 3rd/archify/archify/bin/archify.mjs demo /tmp/archify-demo
```

## graphify（v0.9.57，Python，免构建）

纯 Python 包，经 `PYTHONPATH=3rd/graphify python -m graphify <cmd>` 直跑
（Prism 封装自动注入 PYTHONPATH，不污染 site-packages）。只需装一次运行依赖：

```bash
pnpm run 3rd:build          # pip 安装 tree-sitter 系列 + networkx/numpy/rapidfuzz
pnpm run 3rd:check          # 可用性自检（archify + graphify + 依赖）
```

命令面与产物：
- 建图：`graphify <path>`（tree-sitter AST，零 LLM）→ `<path>/graphify-out/graph.json` + `manifest.json`
- 报告/可视化：`graphify cluster-only <path> --no-label`（零 LLM）→ `GRAPH_REPORT.md` + `graph.html`
- 查询：`query "<q>" --graph <path>` / `path "A" "B"` / `explain "X"` / `affected "X"` / `god-nodes`
- 增量：`graphify update <path>`（无 LLM）

要求：Python ≥3.10。

### 离线化资源（Prism 自有，不在 submodule）

`assets/vis-network.min.js`（v9.1.6，MIT）——graphify 生成的 `graph.html` 原本从
`unpkg.com` CDN 加载它（断网即空白）。Prism 的 studio 路由代理到该副本并改写 HTML 引用，
实现离线可用（B12）。**该文件是 Prism 自有资产**，故放仓库根 `assets/`，不放 `3rd/`。

## llama.cpp（b10883，需编译）

源码是 submodule，**构建产物与模型落在 `3rd/llama-runtime/`**（gitignored），
绝不写进 submodule（保证 `git submodule status` 干净）。

```bash
prism embedding install              # 一条命令完成：编译 + 按算力下载模型 + 装 GPU 包
# 或直接跑脚本：
node scripts/setup-embedding.mjs     # 选项：--tier small|default|large / --gpu / --no-gpu / --prebuilt / --check
```

- CPU 二进制：本地 MinGW + CMake 编译（`GGML_NATIVE`/关 OpenMP/关 curl 提速）；
  找不到工具链时回落官方预编译包。
- GPU 二进制：官方 **Vulkan** 预编译包（约 28MB，NVIDIA/AMD/Intel 通用，无需 CUDA SDK），
  运行时 `-ngl 99` 全层卸载。
- 模型：按算力分档下载（有显卡 large+small，无显卡只 small）。
- 下载源：release 走镜像（`ghfast.top` 等，github.com 直连常阻断）；模型走 `hf-mirror.com`。

## 升级流程

```bash
cd 3rd/<name> && git fetch --tags && git checkout <new-tag> && cd -
git add 3rd/<name> && git commit -m "chore(3rd): <name> → <new-tag>"
# 更新本文档表格；llama.cpp 还需同步 scripts/setup-embedding.mjs 的 LLAMA_TAG 与 embedding-models 校验
pnpm test && pnpm test:e2e
```

## 许可证

- archify：**MIT**；graphify：**Apache-2.0** + MIT 双许可 + NOTICE；llama.cpp：**MIT**。
- submodule 内各自保留原文；再分发时须一并保留各目录下的许可与声明文件。
