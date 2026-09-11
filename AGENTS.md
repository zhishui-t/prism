# AGENTS.md

> 本文件面向在本仓库工作的 AI 编码助手（ZCode / Codex / Claude Code 等）与人类贡献者。
> 目标：**让新加入的 agent 在不读完全部代码的情况下，知道边界在哪、约定是什么、改完怎么验证。**

---

## 1. 项目一句话

Prism 是团队的知识与协作**控制面**：管理知识库、知识图谱、代码图谱、架构图谱、角色/团队定义、任务台账，通过 MCP/HTTP 供宿主 agent 使用。

**它不执行、不调度、不调 LLM、不管版本控制。**

---

## 2. 红线（改动前必读）

违反以下任何一条，改动都不成立：

| # | 红线 | 原因 |
| :--- | :--- | :--- |
| R1 | **不侵入宿主 agent 调度** | 宿主（ZCode/Codex 等）有自己的子 agent 管理，各不一样，Prism 不猜 |
| R2 | **不调 LLM** | 需要 LLM 的活由宿主产出结果后调 `prism_kb_enrich` 直接回写（无队列） |
| R3 | **不做审核** | 宿主说落库就落库；沉淀规则写在团队定义里，Prism 只记录/可视化/审计 |
| R4 | **绝不把全图/全库塞进上下文** | 检索返回子集，尊重预算 |
| R5 | **测试绝不写真实宿主目录** | 所有测试用临时目录（`PRISM_HARNESS_ROOT`/`--harness-root` 重定向；旧名亦认） |
| R6 | **不硬编码 `~/.zcode`** | 路径全部参数化，通过适配器/配置注入 |
| R7 | **文件为真相，数据库为索引** | 知识正文是 Markdown 文件；DB 只是可重建的索引 |
| R8 | **不管版本控制** | 不读 git、不提交、不推送、不写 `.gitignore`；只回答「文件在不在」。提交/更新是宿主的职责，宿主做完任务后自行提交再触发刷新 |

---

## 3. 架构约定

### 3.1 分层与依赖方向

```
cli ──→ server ──→ agents ──→ core
 │        │          │          │
 └────────┴──────────┴──────────┴──→ knowledge（core 之外独立）
```

- **core**：纯域模型，不含任何宿主耦合。状态机、持久化、审计、熔断、任务台账、HarnessAdapter 接口。
- **knowledge**：知识库领域。只依赖 core。
- **agents**：角色/团队定义 + 宿主适配器。只依赖 core。
- **skills**：Skill 定义与安装。只依赖 core。
- **server**：组合根。HTTP/MCP 装配，**不含领域逻辑**（B4 教训：曾经镜像过 agents 契约，导致漂移，已删除）。
- **cli**：命令行面，薄封装。
- **apps/web**：React 控制台，零 UI 库。

**跨包契约冻结**：`packages/*/src/types.ts` 是对外唯一真相。改它必须同步所有消费方。

### 3.2 宿主适配器

```ts
interface HarnessAdapter { defaultRoot, agent, dispatch, model, skill, instructions, mcp,
                           renderRole, renderTeamDefinition, parseRole, ... }
```

- **内置 + 运行期插件，运行期只激活一个**（`prism.yaml: harness` 键 / `PRISM_HARNESS`）。
- 换 harness = 改配置重启，**不是**同时接多个（见 `doc/requirements/deployment-model.md`）。
- **新增 harness 不改 Prism 代码**：把适配包放进 `<PRISM_HOME>/harnesses/<name>/`
  （`harness.json` + 入口 `.mjs`）即自动注册（`packages/agents/src/harness-plugins.ts`）。
  进发行版的内置适配器才改 `harness-manifest.ts`。
- **适配器自述全部宿主约定**（根目录 / 角色·团队·Skill 目录 / MCP 注册位置与形态 /
  产物渲染格式 / 指令文件）——通用层不得出现任何具体 harness 命名（R6 的延伸）。
  配方见 `doc/requirements/adding-a-harness.md`。

### 3.3 存储

- SQLite 三库：`tasks.db` / `core.db` / `knowledge.db`，WAL 模式。
- 所有写操作走 `SingleWriterQueue` 串行化（跨进程由 WAL + busy_timeout 兜底）。
- 写路径模式：**文件快照 → 写文件 → 事务提交 → 失败回滚并还原文件**。

---

## 4. 开发流程

### 4.1 验证阶梯（改完必跑）

```bash
pnpm typecheck     # 1. 类型
pnpm test          # 2. 单测（759）
pnpm lint          # 3. 风格
pnpm build         # 4. 构建
pnpm test:e2e      # 5. 端到端（涉及 CLI/HTTP/Web 时）
pnpm test:package  # 6. 发行冒烟（打包→解压→在解压环境验证；改路径解析/打包/三方件时必跑）
```

**顺序不能跳**：类型错误会让单测跑不起来，构建失败会让 e2e 跑旧产物。

**为什么第 6 步不可省**：`test`/`test:e2e` 全程跑在仓库内（`packages/<pkg>/dist/`），
而打包物化后是 `node_modules/@prism/<pkg>/dist/`（**多一层**）——任何写死相对层级的
路径解析都只在发行版暴露（2026-09-11 实际踩中：tarball 内 anydoc 不可用、graphify
静默回落 PATH 上的无关版本）。该脚本同时会**先删旧产物再打包**，避免拿上一轮 tarball
验证出误导性 PASS。

### 4.2 改代码前

1. 读相关 `doc/requirements/*.md` 的设计与决策记录（尤其「已定」「待定」表）；
2. 看是否有同类既有实现可复用（**不要重新发明**）；
3. 涉及跨包契约的改动，先确认消费方。

### 4.3 提交前

- 新功能带测试；修 bug 带回归测试；
- 更新受影响的文档（`doc/requirements/`、README、本文件）；
- 提交信息说清**为什么**，不只说改了什么。

---

## 5. 已知陷阱（踩过的坑）

| 陷阱 | 表现 | 正确做法 |
| :--- | :--- | :--- |
| **trigram 检索中文** | 两字词（「性能」）搜不到 | 用 **bigram + unicode61** |
| **ZCode 递归扫 agents/** | 团队文件被注册成假 agent | 团队落 `roles_dir` 同级 `teams/`，不在 `agents/` 内 |
| **默认链写真实宿主** | 测试污染 `~/.zcode` | 写守卫（`guard_required`）+ 测试用临时目录 |
| **3rd 源码别进本仓历史** | 曾 vendored 291 个第三方文件，升级即巨大 diff | 一律 **git submodule** 锁 tag；构建产物落 gitignore 的运行时目录 |
| **mtime 单位差** | 刚建完图就报「陈旧」 | Python manifest 是秒、Node stat 是毫秒，需归一 |
| **Windows `spawn` .cmd** | EINVAL | `.cmd` 走 `shell: true`；`.js` 走 `node` + `prefixArgs` |
| **镜像契约** | 两处定义漂移 | 单一真相源，消费方 re-export |
| **bare sleep 测异步** | 负载下 flake | 用轮询 API（如 `waitFor(jobId, timeout)`） |
| **架构图产物失联** | 产物不知属于哪本书 | 渲染时写 sidecar `<name>.meta.json`（`--book/--module`）；界面按作用域过滤 |
| **专属 env 泄漏到别的 harness** | 插件 harness 的 `defaultRoot` 被 `ZCODE_DIR` 覆盖 | 通用覆盖只认 `PRISM_HARNESS_ROOT`；专属变量由对应适配器内部消费 |
| **软删被重扫静默撤销**（已修复，`packages/knowledge/test/restore.test.ts` 锁定） | 引用型条目改源文件后 `status` 回到 active | 索引更新**保留 status**；恢复须显式 `restore`（不是靠重扫） |
| **版次文件的 status 被压平成 active** | 文件写 `candidate`/`superseded`，`reindex` 后一律变 `active` | 解析按 `EntryStatus` **全量往返**；越界值 warning + 回落 `active`，绝不静默改写（R7 文件为真相） |
| **凭记忆猜符号/路径/flag/env** | 设计或代码引用了不存在的类型名、状态名、文件名、CLI flag、env（本轮设计稿一轮被抓 6 处） | 动手前先 grep/`fast_locate` 核对存在性；设计评审把「引用不存在的名字」列为专项检查项 |
| **SQL `LIMIT` 截断向量召回** | 库一大，插入靠后的相关条目永远召不回 | 向量相关性算完余弦才知道，SQL 层不能按 rowid 截断（需全扫） |
| **写死相对层级解析三方件路径**（已修复，`packages/core/test/repo-root.test.ts` 锁定） | 开发态全绿、**发行版全废**：打包物化后 `node_modules/@prism/<pkg>/` 比 `packages/<pkg>/` 多一层，`../../../../3rd` 落到 `node_modules/3rd` | 一律用 `core.repoRoot(import.meta.url)` **向上查找**发行根；改路径/打包后必跑 `pnpm test:package` |

---

## 6. 目录速查

| 要改什么 | 去哪 |
| :--- | :--- |
| 任务状态机 / 持久化 / 台账 | `packages/core/src/{state,persistence,tasks}/` |
| 知识条目 / 检索 / 知识图谱 | `packages/knowledge/src/` |
| 角色 / 团队 / 适配器 / 目录解析 | `packages/agents/src/` |
| HTTP 路由 / MCP 工具 | `packages/server/src/{http/routes,mcp}/` |
| Graphify / Archify 封装 | `packages/server/src/graph/{graphify,archify}.ts` |
| CLI 命令 | `packages/cli/src/commands/` |
| 控制台页面 | `apps/web/src/pages/` |
| 三方件（submodule）/ 向量化 / 文档转换 | `3rd/`（见 `3rd/README.md`）；embedding: `packages/server/src/kb/embedding.ts`；anydoc: `packages/knowledge/src/convert.ts` |

---

## 7. 命令参考

```bash
# 开发
pnpm typecheck / test / lint / build
pnpm test:e2e

# 单包测试：⚠️ core / server / cli 三个包没有 test 脚本，
# `pnpm --filter @prism/<pkg> test` 是「空操作假绿」（exit 0 且零输出），别用它判定通过。
pnpm exec vitest run packages/<pkg>/test     # 在仓库根执行；knowledge/agents/skills 亦可用 --filter
# 改过 packages/core 后，跑 knowledge 测试前必须先 `pnpm --filter @prism/core build`
# （knowledge 测试经 node_modules 解析 @prism/core/dist，否则验的是旧产物）

# 3rd 子模块（submodule）
pnpm run 3rd:init      # git submodule update --init --recursive（克隆后一次）
pnpm run 3rd:build     # 安装 graphify Python 依赖
pnpm run 3rd:check     # 可用性自检（archify + graphify + Python 依赖 + anydoc）
pnpm run 3rd:setup     # 下 anydoc 平台二进制 + llama.cpp 编译/模型（可选）

# 打包
pnpm run package       # → dist/prism-<version>.tgz
```

---

## 8. 交付标准

一个改动算完成，需要：

1. `pnpm typecheck && pnpm test && pnpm lint` 全绿；
2. 新行为有测试覆盖（含边界与错误路径）；
3. 文档同步（设计文档 / README / 本文件）；
4. 涉及宿主目录的操作，实测确认**真实宿主零污染**；
5. 提交信息可追溯（为什么改、验证方式）。
