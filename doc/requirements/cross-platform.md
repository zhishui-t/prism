# Prism 平台支持（Windows / macOS / Linux）

> 状态：**已定**
> 日期：2026-09-12
> 裁决：**macOS 与 Windows 都是一线平台**（历史上按 Windows 单平台开发，2026-09-12 起双平台同级）
> 核心问题：哪些地方必须按平台分支？新代码怎么避免又写死一方？

---

## 1. 结论

| 平台 | 定位 | 说明 |
| :--- | :--- | :--- |
| **Windows** | 一线（实测） | 原开发平台；MinGW/CMake 工具链、Vulkan 加速 |
| **macOS arm64** | 一线（预编译包实测，推理未实测） | 官方预编译包 + **Metal**（包内 `libggml-metal.*.dylib`） |
| **macOS x64（Intel）** | 一线（**端到端实测通过**） | 官方预编译包**不含 Metal**（上游显式 `-DGGML_METAL=OFF`）→ 走 CPU + BLAS |
| Linux | 尽力（未实测） | 代码按 POSIX 分支走通，未在真机验证过全链路 |

**平台差异是"点状"的，不是架构性的**——全部集中在 4 类：路径分隔符、可执行体命名、Python 解释器名、加速后端。除这 4 类之外，**不得出现任何平台判断**（出现即视为漏抽象，应在 §3 的某一处收口）。

---

## 2. 差异矩阵

| 维度 | Windows | macOS | Linux |
| :--- | :--- | :--- | :--- |
| 路径分隔符 | `\` | `/` | `/` |
| 绝对路径形态 | `C:\a` / `C:/a` / `\\srv\share` | `/a/b` | `/a/b` |
| 可执行体后缀 | `.exe` / `.cmd` / `.bat` | 无 | 无 |
| 可执行位 | 不适用 | **必须有 `x` 位** | **必须有 `x` 位** |
| Python 解释器 | `python`（`python3` 常不存在） | `python3`（裸 `python` 已移除） | `python3`（`python` 可能指 py2） |
| **Python 版本要求** | 安装器给的 3.x | **需 ≥ 3.8**——graphify 的 `tree-sitter>=0.23` 装不上 3.7；macOS 自带的 `/usr/bin/python3` 是 **3.7.3**，太旧 | 需 ≥ 3.8 |
| zip 解压工具 | 系统**不带** `unzip` → Python `zipfile` | 系统 `unzip` | 系统 `unzip` |
| tar.gz 解压 | Win10+ 自带 bsdtar | 系统 `tar` | 系统 `tar` |
| 嵌入加速后端 | Vulkan（独立目录 `bin-vulkan/`） | **仅 arm64**：Metal（包内 `libggml-metal.*.dylib`）。**x64 包无任何加速后端** | CUDA / Vulkan（独立目录） |
| 加速后端的**判据** | 有无 `bin-vulkan/llama-server.exe` | 有无 `bin/libggml-metal*.dylib`（**不是** `platform==='darwin'`） | 有无 `bin-cuda/` 或 `bin-vulkan/` |
| llama.cpp 产物名 | `llama-server.exe` | `llama-server` | `llama-server` |
| 预编译包资产 | `-bin-win-cpu-x64.zip` / `-bin-win-vulkan-x64.zip` | `-bin-macos-{arm64,x64}.tar.gz` | `-bin-ubuntu-{x64,arm64}.tar.gz` |
| 行尾 | 检出 CRLF 会污染 diff | LF | LF |
| 路径大小写 | 不敏感 | 默认不敏感（APFS 默认） | 敏感 |

---

## 3. 必须按平台分支的位置（唯一真相源）

新代码要用到平台差异时，**从这里复用，不要就地再判一次**：

| 位置 | 管什么 | 判据 |
| :--- | :--- | :--- |
| `packages/server/src/graph/registry.ts` → `resolveManifestPath()` | manifest 路径解析与分隔符归一 | 盘符/UNC/`/` 三分支 + `process.platform` |
| `packages/server/src/graph/graphify.ts` → `resolvePythonCommand()` | Python 解释器名 | `PRISM_PYTHON` > Windows `python` > POSIX `python3` |
| `packages/server/src/kb/embedding.ts` → `SERVER_BIN` / `GPU_DIRS` / `accelBackend()` / `gpuBackendLabel()` | 嵌入二进制名；**加速后端探测**（全仓唯一判定点） | 平台 → 二进制名与**候选目录**；后端则由 `resolveAccelBackend()` 纯函数按「装了什么」判定（+ `PRISM_EMBEDDING_BACKEND` 覆盖） |
| `packages/server/src/kb/embedding.ts` → `cpuBackendHint()` | 走 CPU 时给用户的建议文案（Intel Mac 不能说「装 GPU 包」） | 平台 + `arch` |
| `packages/server/src/graph/archify.ts` | 前缀包含判断的分隔符方向 | `isWindows` |
| `packages/server/src/http/routes/studio.ts` → `isInside()` | 路径前缀比对（含大小写归一） | `process.platform` |
| `scripts/python.mjs` → `resolvePython()` | npm scripts 的解释器解析 | **与 graphify.ts 刻意镜像**（scripts/ 不进发行包，TS 侧无法导入；改一处必须同步另一处） |
| `scripts/archive.mjs` → `extractArchive()` | 归档解压 + 摊平 + POSIX 可执行位 | 扩展名分流 + `IS_WINDOWS` |
| `scripts/setup-embedding.mjs` → `PREBUILT` | 预编译包资产名 | 平台 + `arch` |
| `scripts/setup-anydoc.mjs` → `detectTarget()` | 平台 → 原生 `.node` 资产 | 平台 + `arch` + musl 判定 |

### 3.1 macOS 上的 Python 坑（实测）

macOS 自带的 `/usr/bin/python3` 是 **3.7.3**，而 graphify 依赖 `tree-sitter>=0.23`（要求 ≥3.8）
——**默认解释器装不上依赖**。本机若另有较新版本（如 `/usr/local/bin/python3.11`），显式指定：

```bash
PRISM_PYTHON=/usr/local/bin/python3.11 pnpm run 3rd:build   # 装依赖
PRISM_PYTHON=/usr/local/bin/python3.11 prism graph build <proj>
```

排查顺序：**先看实际选中了哪个解释器**——`pnpm 3rd:check` 第一行就会打印
（`3rd 自检（darwin/x64，Python: python3）`），比对着日志猜要快。

判据实现：`resolvePythonCommand()`（TS 侧）与 `scripts/python.mjs`（npm scripts 侧），
解析顺序 `PRISM_PYTHON` > 平台惯例名，且 POSIX 上用 `X_OK` 探存在性（无执行位的同名文件不算命中）。

---

## 4. 踩过的坑（跨平台专属，逐条有证据）

| 坑 | 表现 | 正解 | 锁定测试 |
| :--- | :--- | :--- | :--- |
| **分隔符归一不分平台** | `manifest` 里的绝对路径被无条件 `replace(/\//g,'\\')` → macOS/Linux 上 `stat` 必失败 → **陈旧检测恒报 stale**（Windows 侧看不出来） | 只在**本机是 Windows** 时归一 | `packages/server/test/tasks.test.ts`（`resolveManifestPath` 用例） |
| **解释器名写死 `python`** | macOS/Linux 多半只有 `python3` → vendored graphify 起不来（`graphify_missing` / ENOENT） | `resolvePythonCommand()` 按平台 + `PRISM_PYTHON` 覆盖 | `packages/server/test/graphify.test.ts` |
| **二进制名写死 `.exe` + 加速目录写死 `bin-vulkan`** | macOS 上 `embeddingInstalled()` **恒 false** → 向量检索**静默降级**成纯 BM25，不报错也不阻塞——最难发现的一类 | `SERVER_BIN` / `GPU_DIRS` 按平台 | `packages/server/test/embedding-platform.test.ts` |
| **`flattenInto` 只拷 `isFile()`，软链被静默丢弃** | macOS 预编译包的 **dylib 版本链**（`libllama-common.0.dylib → …0.4.0.dylib`，共 16 条）全丢 → `llama-server` 启动即 `dyld: Library not loaded: @rpath/libllama-common.0.dylib` + `Abort trap: 6`。Windows 的 zip 里没有软链，所以**只在 macOS/Linux 暴露** | 软链单独重建（`readlink`+`symlink`，无权限时退化解引用拷贝）；见 `scripts/archive.mjs::copyLink` | `packages/server/test/archive-extract.test.ts` |
| **用 `platform==='darwin'` 判定 Metal** | Intel Mac 上**误报**加速后端：① `doctor` 谎报 Metal；② `autoTier()` 切到 `large`（609MB）**在纯 CPU 上跑**（单条十秒级）；③ 多传无意义的 `-ngl 99`。上游 `release.yml` 对 macOS 两架构开关不同（arm64 `GGML_METAL_EMBED_LIBRARY=ON`；x64 `-DGGML_METAL=OFF`）；且**硬件**照样报 `Metal Support: Metal 3` → 看硬件/看平台必然假阳性 | 判据改为「包内有没有 `libggml-metal*.dylib`」，抽成纯函数 `resolveAccelBackend()` 并可被逐分支测试 | `packages/server/test/embedding-platform.test.ts` |
| **上游包顶层目录未摊平** | 解压出 `<dest>/<包名>/llama-server`，运行时按 `<dest>/llama-server` 找 → **装了却检测不到** | `extractArchive()` 解压到暂存目录后递归定位二进制并摊平 | `packages/server/test/archive-extract.test.ts` |
| **缺 `.gitattributes` + 单文件 CRLF/裸 CR** | `apps/web/src/Shell.tsx` 曾是全仓唯一 CRLF 文件、且夹带一个**裸 CR**（JS 视其为换行）→ 跨平台 diff 出「整文件重写」 | 加 `.gitattributes`（`* text=auto eol=lf`，`.cmd/.bat` 例外）并归一行尾 | — |
| **npm scripts 里裸 `python`** | `3rd:build` / `3rd:check` 在 macOS 上必失败 | 走 `scripts/python.mjs` / `scripts/check-3rd.mjs` | — |

---

## 5. 验证现状

| 项 | 状态 |
| :--- | :--- |
| `resolveManifestPath` / `resolvePythonCommand` / `SERVER_BIN` + 加速后端判定 | ✅ 有单测，Windows 与 POSIX 分支都在断言里 |
| 归档解压 + 摊平 + **软链保留** | ✅ 合成归档（顶层目录 / 扁平 / 二进制名不匹配须报错 / dylib 版本链软链 / staging 残留清理）实测通过 |
| macOS **x64** 预编译包真实下载 | ✅ 实测：`llama-b10883-bin-macos-x64.tar.gz` **10.7MB**，官方直连与 2 个镜像前缀全部可达（HTTP 200） |
| macOS **x64** 向量链路**端到端** | ✅ **实测通过**（Intel Mac / Intel Iris Plus 655 / b10883）：冷启动 **1008ms**、热态 **8–12ms**、常驻 **43.9MB**、cos(语义相关)**0.760** / cos(无关)**0.278** |
| macOS x64 的 Metal | ✅ 实测**不存在**：包内无 `libggml-metal*`、全部二进制无 `ggml_metal` 符号，`llama-server` 只链 `CoreFoundation` + `libggml-blas`。（对照：同 tag 的 **arm64** 包内有 `libggml-metal.0.23.0.dylib`，1795 个 metal 符号） |
| macOS **arm64** 上实际推理 | ⏳ 未跑（本机为 x64；仅核对了包内容与上游构建矩阵） |
| Windows 侧回归 | ⏳ 未在真机验证本轮改动（本轮在 macOS 上进行；断言全部按平台条件化） |
| Linux | ⏳ 未实测 |

> **x64 上「无 Metal」不是配置问题，是上游设计**：`release.yml` 的 macOS 矩阵里
> `x64（macos-15-intel）` 显式 `-DGGML_METAL=OFF`，注释原文
> *"Metal is disabled on x64 due to intermittent failures with Github runners not having a GPU"*。
> 也就是说 Intel **硬件**支持 Metal（实测 `system_profiler` 报 `Metal Support: Metal 3`），
> 但官方**预编译包**没编进去。Intel Mac 想要 Metal 只能 `pnpm run 3rd:setup -- --source`（源码编译时本脚本会传 `-DGGML_METAL=ON`）。

---

## 6. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | macOS 与 Windows 同级支持 | ✅ 是（2026-09-12） |
| 2 | Linux 是否算支持目标 | ⏳ 倾向"尽力"，未实测前不承诺 |
| 3 | 双平台 CI 矩阵（`windows-latest` + `macos-latest` 跑 typecheck/test） | ⏳ 当前仓库**无 CI**，是双平台最大的保障缺口 |
| 4 | WSL 是否计入 Windows 支持 | ⏳ 待定（当前按 Linux 分支处理） |
| 5 | macOS 上是否默认装 `large` 档模型 | ✅ 已修：判据不再「macOS 恒有加速器」——Intel Mac（x64 预编译包无 Metal）判定为无加速 → 只装 `small`；arm64 才走 `large + small` |
| 6 | `3rd` 子模块初始化是否纳入 `pnpm 3rd:setup` 自动完成 | ⏳ 当前需手动 `pnpm run 3rd:init` |
| 7 | **冷启动偶发「等满 60s 后失败」** | ⚠️ 观察到 1 轮（连续两次各卡满 `START_TIMEOUT_MS`=60s 后失败、第三次秒成；从**干净状态**复现），此后 5 次冷启动均 ~1.0s，**未再复现**。已修掉两个让问题更难查/更久的部分（详见下），根因待下次复现时凭日志定位 |

> **#7 的两处配套修复**（都是独立成立的缺陷，不依赖根因）：
> 1. **子进程输出曾整体丢弃**（`stdio: 'ignore'`），于是启动失败在用户侧只表现为
>    「模型未就绪（档位模型缺失？）」——**日志为零**，失败原因不可复原。现落盘到
>    `3rd/llama-runtime/llama-server.log`（超 2MB 截断），并在超时行自陈失败。
> 2. **`LOCK_STALE_MS`(120s) > `START_TIMEOUT_MS`(60s) 的错配**：持锁者最多等 60s 就放弃，
>    所以更旧的锁一定是残骸；原先要等 120s 才接管，导致残骸会让后续调用**每次白等 60s**。
>    现取 `START_TIMEOUT_MS + 30s`。
