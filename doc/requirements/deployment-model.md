# Prism 部署形态（讨论稿 v0.2）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 核心问题：Prism 运行时服务几个宿主？

---

## 1. 结论：编译期支持多 harness，运行期只服务一个

**一个 Prism 实例只服务一个 harness（如 ZCode），但服务该 harness 的多个会话。**

```
Prism 代码库
├── adapters/zcode.ts      ← 编译进来（当前实现）
├── adapters/codex.ts      ← 未来加，编译进来
└── adapters/claude.ts     ← 未来加
        ↓ 运行时配置选择（prism.yaml: harness: zcode）
   Prism 实例只加载其中一个
        ↓
   服务该 harness 的多个会话
```

| 维度 | 结论 |
| :--- | :--- |
| **harness 支持** | 代码里支持多个适配器（编译期） |
| **harness 激活** | **一个实例只激活一个**（运行时配置） |
| **会话** | 一个实例服务该 harness 的**多个会话** |

**为什么不"既要又要还要"**：不做运行时多 harness 路由——那是另一套复杂度（不同 harness 的会话身份、能力、注入机制都要动态区分）。换 harness = 改配置重启，不是同时接多个。

---

## 2. 为什么要支持多个 harness（编译期）

**换一个 harness 只需换配置，不用改代码。**

| 收益 | 说明 |
| :--- | :--- |
| 适配器隔离 | 每个 harness 的原生约定封在 `HarnessAdapter` 里 |
| 可移植 | 新增 harness = 实现适配器 + 注册 |
| 实例单纯 | 运行时只加载选中的那个适配器 |

---

## 3. 为什么要服务多个会话（运行期）

| 理由 | 说明 |
| :--- | :--- |
| 共享资产 | 知识库、代码图谱、角色/团队定义是团队级，不是会话私有 |
| 并行任务 | 一个团队同时开多个会话做不同任务是常态 |
| 台账隔离 | 任务台账按 `session_id` 隔离，但同一实例可见全局 |

```
        ZCode 会话 A ─┐
        ZCode 会话 B ─┼─→ Prism 实例（harness=zcode）
        ZCode 会话 C ─┘        ├─ 知识库（文件 + SQLite）
                               ├─ 代码图谱（.git 项目各自 graphify-out/）
                               ├─ 任务台账（按 session 隔离）
                               └─ 工作队列
```

---

## 4. 关键技术前提（已实测）

| 前提 | 结论 | 证据 |
| :--- | :--- | :--- |
| SQLite 多进程并发写 | **可行** | 实测 4 进程 × 200 行并发写：800/800 行，`integrity_check: ok` |
| WAL 模式 | 必需 | `journal_mode=WAL` + `busy_timeout` |
| 单写者队列 | 进程内有效 | 跨进程靠 SQLite 自身锁 |

**结论**：多会话共享不需要引入外部数据库。

---

## 5. 配置

```yaml
# <PRISM_HOME>/prism.yaml
harness: zcode              # 运行时激活哪个适配器（当前唯一可选值）
home: ~/.prism
server:
  port: 7777
mcp:
  transport: stdio          # stdio | http
```

**一个实例一个 harness**——没有 `harnesses: [zcode, codex]` 这种配置。

---

## 6. 会话身份

| 概念 | 来源 | 用途 |
| :--- | :--- | :--- |
| `host` | **实例配置固定**（`harness: zcode`） | 不需要每请求区分 |
| `session_id` | stdio 从启动参数 / HTTP 从请求头或 `prism_session_attach` | 台账隔离、审计溯源 |
| `role` / `team_id` | 请求携带 | 权限与上下文 |

**简化**：因为只有一个 harness，`host` 是常量，不必每次协商。

---

## 7. 部署形态

| 形态 | 适用 |
| :--- | :--- |
| **本地常驻**（推荐） | `prism serve` 后台跑，多会话共享 |
| **stdio 随会话** | 每会话一进程，共享同一数据目录 |
| 远程服务 | 暂不做 |

---

## 8. 并发与隔离

| 维度 | 策略 |
| :--- | :--- |
| 写操作 | 进程内单写队列 + 跨进程 SQLite WAL |
| 知识文件 | 版次制 + 内容哈希冲突检测 |
| 代码图谱构建 | 同一项目同时只允许一个构建（文件锁） |
| 任务台账 | 按 `session_id` 隔离 |
| 工作队列 | 认领制（attempt token）防重复认领 |

---

## 9. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 编译期多 harness、运行期单 harness | ✅ 是 |
| 2 | 多会话共享单实例 | ✅ 是 |
| 3 | 运行时多 harness 路由 | ✅ **不做** |
| 4 | harness 配置项 | ⏳ `prism.yaml: harness` / 环境变量 |
| 5 | 默认部署形态 | ⏳ 本地常驻 / stdio |
| 6 | MCP 传输 | ⏳ stdio / HTTP |
