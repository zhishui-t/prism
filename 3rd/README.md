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
| `anydoc/` | [firecrawl/anydoc](https://github.com/firecrawl/anydoc) | **v0.2.4** | MIT | Rust（napi-rs）；**不可自编译**（本机无 Rust） | 下载平台预编译 `.node` |

> 运行时目录（gitignored，由脚本生成，不在 submodule 内）：
> - `3rd/llama-runtime/{bin,bin-vulkan,models}` —— llama-server 二进制 + GGUF 模型
> - `3rd/anydoc-runtime/{anydoc.js,index.js,anydoc.<platform>.node}` —— JS 包装层 + 原生绑定
>
> 安装：`pnpm run 3rd:setup`（anydoc + embedding 一次装好）；`3rd:check` 自检。

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
- **anydoc**：虽是**正规发布的 npm 包**（`@firecrawl/anydoc`），仍归入 3rd——**统一治理**，
  且能顺带解决「tarball 只带本机平台原生包」的跨平台分发问题：源码进 submodule，
  平台二进制由目标机按自身平台下载（每个平台一个 release 资产）。它是 Rust 原生库，
  本机无 Rust 工具链不可自编译，故只下载官方预编译。

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

- 主二进制（落 `3rd/llama-runtime/bin/`）：
  - **Windows**：本地 MinGW + CMake 源码编译（`GGML_NATIVE`/关 OpenMP/关 curl 提速），
    找不到工具链时回落官方预编译包；
  - **macOS / Linux**：默认直接用**官方预编译包**（无需本机工具链）；想本地编译加 `--source`。
- 加速后端（按平台，判据见 `doc/requirements/cross-platform.md` §2）：
  - Windows / Linux：官方 **Vulkan** 预编译包（约 28MB，NVIDIA/AMD/Intel 通用，无需 CUDA SDK）
    → `bin-vulkan/`，运行时 `-ngl 99` 全层卸载；
  - **macOS arm64**：Metal 随包分发（`libggml-metal.*.dylib`），无需额外下载；
  - ⚠ **macOS x64（Intel）**：官方预编译包**不含 Metal**（上游 `-DGGML_METAL=OFF`）→ 走 CPU + BLAS。
    要 Metal 只能 `--source` 源码编译。
- 模型：按算力分档下载（探测到加速器才装 large+small，否则只装 small）。
  **Intel Mac 不会被判为「有加速器」**（硬件支持 Metal，但预编译包没有）。
- 下载源：release 走镜像（`ghfast.top` 等，github.com 直连常阻断）；模型走 `hf-mirror.com`。
- 归档解压统一走 `scripts/archive.mjs`：摊平上游顶层目录、**保留 dylib 版本链软链**、
  补 POSIX 可执行位（漏任一项都会「装了却起不来」）。

## anydoc（v0.2.4，Rust 原生，下载预编译）

文档转 Markdown（doc/docx/odt/pdf/ppt/pptx/rtf/epub/xlsx/ods/odp/csv）的本地引擎。
**Rust (napi-rs) 原生库**，本机无 Rust 工具链不可自编译 → 下载官方 GitHub Release 的
平台预编译 `.node`；上游 JS 包装层从 submodule 的 `node/` 拷来，与二进制同目录
（napi 加载器优先 `require('./anydoc.<platform>.node')`，零改动加载）。

```bash
prism ...                                     # 无专用命令；随 3rd:setup 安装
node scripts/setup-anydoc.mjs                 # 选项：--check / --force
```

- 产物 `3rd/anydoc-runtime/`（gitignored）：`anydoc.js` + `index.js` + `*.d.ts` +
  `package.json`（包装层）+ `anydoc.<platform>.node`（原生绑定）。
- 平台资产名与上游 `napi.targets` 一致：`darwin-{arm64,x64}` / `linux-{x64,arm64}-{gnu,musl}`
  / `win32-x64`（上游仅发布这些）。
- 下载源走镜像（`ghfast.top` 等），官方直连兜底。
- 加载方：`packages/knowledge/src/convert.ts`（按绝对路径动态 import 此目录）。
  未安装时 `md/txt/html` 仍直读，二进制格式降级跳过，不阻断扫描。

## 升级流程

```bash
cd 3rd/<name> && git fetch --tags && git checkout <new-tag> && cd -
git add 3rd/<name> && git commit -m "chore(3rd): <name> → <new-tag>"
# 同步本文档表格 + 对应脚本里的版本常量：
#   llama.cpp → scripts/setup-embedding.mjs 的 LLAMA_TAG
#   anydoc    → scripts/setup-anydoc.mjs 的 ANYDOC_TAG
pnpm test && pnpm test:e2e
```

## 许可证

- archify：**MIT**；graphify：**Apache-2.0** + MIT 双许可 + NOTICE；llama.cpp：**MIT**；
  anydoc：**MIT**。
- submodule 内各自保留原文；再分发时须一并保留各目录下的许可与声明文件。
