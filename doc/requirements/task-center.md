# Prism 任务中心设计（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：任务台账、依赖图、状态回报。
> 结论：**被动台账**——执行方回报状态，Prism 只记录、可视化、审计。

---

## 1. 定位

**Prism 不驱动任务。** 任务由宿主（或 agent-team 的队长）创建与推进，Prism 只做台账：

| 做 | 不做 |
| :--- | :--- |
| 记录任务与依赖 | 不派发任务 |
| 可视化依赖图 | 不决定串并行 |
| 记录状态变更 | 不主动推进状态 |
| 审计留痕 | 不重试/取消（除非显式调用） |

---

## 2. 数据模型

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  dag_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  dependencies TEXT DEFAULT '[]',   -- 依赖的任务 id 数组
  write_scopes TEXT DEFAULT '[]',   -- 写域（advisory 冲突提醒）
  revision INTEGER NOT NULL DEFAULT 0,
  attempt_token TEXT,
  assigned_agent TEXT,
  executor TEXT,
  status TEXT NOT NULL,
  result TEXT,
  error_type TEXT,
  created_at TEXT,
  updated_at TEXT
)

CREATE TABLE dags (
  dag_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

CREATE TABLE edges (
  dag_id TEXT NOT NULL,
  from_task_id TEXT NOT NULL,
  to_task_id TEXT NOT NULL,
  PRIMARY KEY (dag_id, from_task_id, to_task_id)
)
```

（沿用已移植的 schema，14 态状态机不变。）

---

## 3. 状态机

复用已移植的 **14 态 32 转移**（`WAITING/BLOCKED/RUNNING/COMPLETED/…/COOLDOWN`）。

**派生规则**（由状态机计算产生，`report()` 的显式回报不接受；由一次显式回报触发，系统只维护状态一致性，不代替宿主发起工作）：

| 规则 | 转移 | 触发 |
| :--- | :--- | :--- |
| 失败传播 | `WAITING/BLOCKED → SKIPPED` | 上游进**失败终态**（`FAILED/BANNED/LOOP_TERMINATED/CANCELLED`），下游不再有意义 |
| SKIPPED 重激活 | `SKIPPED → WAITING/BLOCKED` | 上游**离开**失败终态（人工重开）；依赖就绪 → `WAITING`，否则 → `BLOCKED` |
| 上游完成解锁 | `BLOCKED → WAITING` | 上游进**完成终态**（`COMPLETED/CLOSED`），解锁依赖已就绪的 `BLOCKED` 下游 |

另含 **失败终态 → retry/skip/cancel** 的显式转移。

两个口径必须分开（混用会让级联写先落库、再被审计拒绝）：
- **事前授权**（矩阵）：`report()` 判断「调用方能否请求该转移」。上表第三行的 `BLOCKED → WAITING` 本就在矩阵内，宿主也可直接请求；
- **事后留痕**（矩阵 ∪ 派生规则）：审计判断「系统能否产生该转移」。

**唯一变化**：状态由**执行方回报**，不是 Prism 推进。

---

## 4. 回报协议

宿主/队长经 MCP 回报：

```ts
prism_task_report({
  task_id, from_status, to_status, by, result?, error_type?
})
  → { ok: true } | { ok: false, reason }
```

**校验**：
- 转移必须合法（状态机判定，非法拒绝）；
- 写审计（`task.status_changed`）；
- 更新 `revision`（乐观并发）。

### 4.1 批量登记（可选）

```ts
prism_task_register({
  dag_id, team_id, project_id, version, tasks: [{ id, description, assignee, depends_on }]
})
```

用于队长规划完成后一次性登记 DAG（被动记录，不触发执行）。

---

## 5. 可视化

| 界面 | 内容 |
| :--- | :--- |
| 任务中心页 | 按 `session_id` / `dag_id` 过滤的任务列表 + 依赖图 |
| 依赖图渲染 | 纯 SVG（参考 Weave 的 `dag-panel.tsx`：最长依赖路径分层、状态色、点击聚焦上下游链） |
| 状态色 | 14 态各一色 |
| 实时刷新 | WebSocket/SSE 推送状态变更 |

---

## 6. 与团队工作流的关系

```
团队定义（工作流声明）
   ↓ 队长读取
创建任务 + 登记 DAG（prism_task_register）
   ↓ 宿主自己的派发机制
执行 → 回报状态（prism_task_report）
   ↓
Prism 台账 + 依赖图 + 审计
```

**Prism 全程被动**：登记、回报、可视化。

---

## 7. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 被动台账 | ✅ 是 |
| 2 | 复用 14 态状态机 | ✅ 是 |
| 3 | 回报协议 | ✅ `prism_task_report` |
| 4 | 是否提供批量登记 | ⏳ 提供 / 单条 |
| 5 | 实时推送方式 | ⏳ WebSocket / SSE |
| 6 | 依赖图渲染 | ✅ 纯 SVG（参考 dag-panel） |
