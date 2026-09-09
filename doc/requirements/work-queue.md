# Prism 工作队列设计（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：Prism 需要 LLM 工作时（embedding/摘要/图表 IR），如何交给宿主执行。
> 原则：**Prism 不调 LLM**；工作经队列委派宿主；拉取式，不侵入。

---

## 1. 为什么需要队列

Prism 有三类工作自己做不了（因为不调 LLM）：

| 工作 | 用途 |
| :--- | :--- |
| `embed` | 知识向量化（RAG 语义检索） |
| `summarize` | 知识摘要（提升检索质量） |
| `classify` | 标签/分类 |
| `extract_entities` | 实体/关系抽取（进知识图谱） |
| `diagram_ir` | Archify 图表 IR 撰写 |

**Prism 只落任务，宿主认领执行。**

---

## 2. 拉取式（Pull-based）

**Prism 不能主动唤醒宿主**（那是侵入）。所以是拉取：

```
Prism 落 work_request (pending)
   ↓  宿主 agent 主动查询
prism_work_pending  → 列出待办（类型/输入/期望 schema/优先级）
prism_work_claim    → 认领（签发 attempt token，防重复）
   ↓  宿主用自己的 agent + LLM 执行
prism_work_complete → 回填结果（Prism 校验后入库）
```

### 2.1 触发拉取的方式（已核实 ZCode hooks）

ZCode 支持 7 个 hook 事件，可用于提醒宿主"有活干"：

| Hook | 用途 |
| :--- | :--- |
| `SessionStart` | 会话开始时检查待办 |
| `UserPromptSubmit` | 用户提交时顺带检查 |
| `Stop` | 回合结束时检查（避免遗漏） |

**但 hook 只做"提醒"，不替代拉取**——Prism 仍是被动响应。

> 也可纯靠 Skill 指引：在 `prism` Skill 里写明"完成任务后调用 `prism_work_pending` 检查待办"。

---

## 3. 数据模型

```sql
CREATE TABLE work_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- embed|summarize|classify|extract_entities|diagram_ir
  payload TEXT NOT NULL,           -- JSON：输入与期望
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|claimed|completed|failed|expired
  priority INTEGER NOT NULL DEFAULT 0,     -- 越大越优先
  attempt_token TEXT,              -- 认领签发的 UUID（复用乐观并发守卫）
  claimed_by TEXT,
  claimed_at TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

### 3.1 状态机

```
pending ──claim──→ claimed ──complete──→ completed
   ↑                  │
   │                  ├──fail──→ failed
   └──超时回收─────────┘
                      └──超时──→ expired
```

| 状态 | 说明 |
| :--- | :--- |
| `pending` | 待认领 |
| `claimed` | 已认领（有 attempt_token） |
| `completed` | 完成并校验通过 |
| `failed` | 执行失败 |
| `expired` | 认领超时未回填 → **回收为 pending** |

---

## 4. 工具签名

```ts
// 列出待办（宿主主动调）
prism_work_pending({ kind?, limit?, priority_min? })
  → { items: [{ id, kind, payload, priority, created_at }] }

// 认领（签发 attempt_token）
prism_work_claim({ id })
  → { attempt_token, payload, deadline }

// 回填（带 token 校验）
prism_work_complete({ id, attempt_token, result })
  → { ok: true } | { ok: false, reason }
```

**并发安全**：claim 签发 UUID + 状态原子迁移（复用已有的 attempt-token 乐观并发守卫），**同一任务不会被两个宿主认领**。

---

## 5. 结果校验

| 类型 | 校验 |
| :--- | :--- |
| `embed` | 维度正确、数值有限 |
| `summarize` / `classify` | schema 合法 |
| `extract_entities` | 实体/关系结构合法 |
| `diagram_ir` | 调 `archify validate`，不通过则拒绝并附修复诊断 |

**校验失败**：任务置 `failed`，附错误；可选重试（重新入队，`priority` 提升）。

---

## 6. 护栏

| 项 | 策略 |
| :--- | :--- |
| **积压上限** | 超过阈值停止入队并告警（不无限增长） |
| **优先级** | 团队规则给定（Prism 只执行不判定） |
| **超时回收** | claim 后 N 分钟未回填 → expired → 回收为 pending |
| **重试上限** | 同一任务失败 N 次后不再自动重试，标记待人工 |
| **成本可见** | 控制台显示待办数、最老任务年龄、已完成统计 |

---

## 7. 完整流程示例（知识富化）

```
① 导入知识（anydoc 本地转换）→ 落库 active
② Prism 落 work_request(kind=summarize, payload={knowledge_id})
③ 宿主完成任务后调 prism_work_pending 看到待办
④ 宿主认领 → 用自己的 LLM 生成摘要 → prism_work_complete
⑤ Prism 校验 schema → 写入知识条目 → 触发重建索引
```

**关键**：② 之后知识**已可检索**（关键词层），③④⑤ 是质量增强，不阻塞可用性。

---

## 8. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 拉取式（非推送） | ✅ 是 |
| 2 | 认领用 attempt token 防重复 | ✅ 是 |
| 3 | 超时回收 | ⏳ 默认时长（10min / 30min / 可配） |
| 4 | 是否用 ZCode hook 提醒 | ⏳ 用 / 纯靠 Skill 指引 |
| 5 | 积压上限默认值 | ⏳ 待定 |
| 6 | 失败重试次数 | ⏳ 1 / 3 / 不自动重试 |
