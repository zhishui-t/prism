# Prism 工作流单元资产（workflow-asset）设计（讨论稿 v0.2）

> 状态：**v1 已实现（只读库）+ v2 已实现（图编辑器写路径）**；日期：2026-10-23；范围：packages/{core,agents,server,cli} + apps/web；
> 原则：工作流是一等资产（第 5 类，role/team/skill/harness 之后），文件为真相、DB 为索引（R7），
> 目录全部经适配器/配置参数化（R6），测试零宿主污染（R5）。
> 设计源：examples/workflows/ 约定层（2026-10-23 定稿的单元骨架）资产化。

## 1. 背景与定位

工作流（「怎么干」的过程单元）此前散在角色正文与团队定义的散文里（前端三段流水线写了两遍），
不可复用、界面不可见。资产化后：`<workflows_dir>/<id>.md` 为唯一真相，角色 frontmatter/正文挂载、
团队阶段表「引用:」、控制台工作流库页、CLI/MCP 三面同源读取。

**两级形态**：角色级（binds 绑定角色）/ 团队级（供团队编排引用）。**v1 只读**——
编辑保持文件级（低频、markdown 友好）；结构化编辑器是 v2（§9）。

## 2. 文件契约（frontmatter 五键 + 步骤表）

```jsonc
// <workflows_dir>/<id>.md
---
workflow: <id>            // kebab-case，= 文件名（不含 .md）
name: <中文名>
level: role | team
binds: [<角色名>]          // 角色级必填建议非空；强校验存在性
skills: [<skill名>]        // 声明性白名单
---
# <名称>（<id>）
## 步骤表                  // 必要组成；列同义词见 §3
| # | 步骤 | 承接 | skill | 输入工件 | 输出工件 | 完成判定 | 回流 |
## 硬性约束                // 自由正文
```

类型契约：`WorkflowDefinition` / `WorkflowStep`（`packages/agents/src/types.ts`，冻结接口）。
`WorkflowStep.owner`（承接）是**自由文本**（`+` 分隔多值）——合法值含「队长/人/独立实例」等
编排语义词，**不做角色存在性强校验**；角色绑定由 frontmatter `binds` 显式声明并强校验。
「完成判定必须可从文件机械判定」（压缩恢复的基石）是步骤表的**内容约束**，由单元作者遵守，
解析器不强制（v1 不做 lint）。

## 3. 解析（`agents/src/workflow/parse.ts`）

- 复用 `splitFrontmatter`；frontmatter 缺失/语法错误 → `WorkflowParseError`（`no_frontmatter` / `parse_failed`）
- 步骤表：扫 `## 步骤表` 小节（到下一个 `#`/`##` 标题；`###` 不截断，同 team 口径），
  表头 = ≥2 核心列命中 + 下一行分隔行；列同义词表：`#`/序号、步骤/名称、承接/负责、skill/技能、
  输入工件/输入、输出工件/输出、完成判定/判定、回流路径/回流
- 行级错误**不抛**，降级 `ParseIssue`（warning 并入 issues）：`steps_section_missing` /
  `steps_table_missing` / `step_row_ragged`（截断/补空）/ `step_order_defaulted`（非正整数按行号回退）/
  `steps_multiple_tables`（只认第一张）
- 单元格转义：`\|` → `|`（同团队工作流表契约）
- **库加载跳过无 frontmatter 的文件**（README 等文档文件按「不是单元」静默跳过，不算错误）；
  其余解析错误**原样抛出**（坏单元要可见）

## 4. 校验（`agents/src/workflow/validate.ts`）

| 规则 | 行为 |
| :--- | :--- |
| `workflow` 空 / `name` 空 / `steps` 为空 / `level` 非 role·team | error（`workflow_id_required` / `workflow_name_required` / `workflow_steps_empty` / `workflow_level_invalid`） |
| 步骤序号重复（「#」列需从 1 连续编号） | error（`workflow_step_order_duplicate`——order 是「回 N」的寻址基准，重复即歧义） |
| `workflow` 非 kebab-case | warning（`workflow_id_not_kebab`，同角色 name 口径——宿主约定宽于校验器，不阻断） |
| `binds` 引用的角色不存在（提供角色库时，小写不敏感） | error（`workflow_binds_role_unknown`） |
| 角色级 `binds` 为空 | warning（`workflow_binds_empty`——多承接者单元建议改标 team 级） |
| `承接` 列值既非角色也非编排豁免词 | warning（`workflow_step_owner_unknown`；豁免词表 `STEP_OWNER_WORDS`：队长/leader/主会话/人/人签/独立实例/新会话/脚本/全部/全员/—/-） |
| `skills` 引用未安装（提供名单时） | warning（`workflow_skill_unknown`） |
| 库内 id 重复 | error（`workflow_duplicate`，`validateWorkflowUniqueness`） |

## 5. 目录解析（对齐 teams 的三层链）

`AgentConvention.workflowDir: string | null`（core 适配器接口，对称 `teamDir`）→
zcode 适配器 `<root>/workflows` → `HarnessLayout.workflowsDir` → `prism.yaml` 可覆盖
（`workflows_dir`，第 5 个标量键）→ `resolveDirs` 落点/guard/provenance 各加一支；
`workflows_dir` 未配置但 `roles_dir` 已配置时**跟随同级**（与 teams 同一联动口径）。

## 6. 三入口面（v1 只读）

| 入口 | 面 |
| :--- | :--- |
| CLI | `prism workflow list [--source <dir>] [--roles-dir <dir>]` / `show <id>` / `validate [<id>]`（缺省全库 + 唯一性）；`--json` 整体可解析 |
| MCP | `prism_workflow_list`（`{count, workflows, workflows_dir}`）/ `prism_workflow_get { workflow }` |
| HTTP | `GET /api/workflows` → `{workflows, workflows_dir}`；`GET /api/workflows/:id` |

角色挂载（跨资产契约）：`RoleDefinition.workflows?: string[]`；**双形态存储**（同 skills 先例——
ZCode frontmatter 白名单不含它）：Prism 规范形态写 frontmatter `workflows` 键，宿主原生形态写
正文 overlay 节 `## 工作流绑定`；parse 双回收、render 幂等注入、`RolePatch.workflows` 补丁
（`[]` = 清空）。HTTP/MCP `role edit` 透传（`strictStrArray`）；`validateRole` 加
`workflow_unknown` warning（提供 `knownWorkflows` 时）。

## 7. 控制台（apps/web）

- 注册链：`nav.ts` PageKey + `route.ts` PAGES/WITH_SEL（`#/workflows/<id>` 深链）+ `Shell.tsx`
  NAV_GROUPS（org 组）+ `Icon.tsx` workflow 图标 + i18n ZH/EN 成对
- `WorkflowsPage`（照 TeamsPage 骨架，**只读**）：列表（level 徽标/binds/步骤数/校验状态）+
  详情 Modal（元信息 + 步骤块明细 + 正文 Markdown + `sourcePath` 文件级编辑提示）
- 步骤表**不复用** WorkflowFlow：其明细按角色库渲染 Ref，而承接列合法含编排语义词——
  按纯文本渲染，只有 frontmatter binds 渲染角色链接
- 角色表单挂载：`workflows` 字段（SelectedChips + PickerDialog `kind="workflow"`，
  平铺单组；仅 edit 提交——create 服务端暂不认）
- `RefKind` 加 `'workflow'` → `#/workflows/<name>`（团队工作流表「引用:」文本的识别可点化留 v2）

## 8. 错误码（HTTP 信封）

| code | 状态 | 语义 |
| :-- | :--- | :--- |
| `not_found` | 404 | 单元不存在（`workflowNotFoundMessage` 单点文案） |
| `role_patch_empty` | 400 | role PATCH 空补丁（文案已含 workflows） |
| `workflow_section_missing` | 400 | PATCH 要写步骤表，但文件没有 `## 步骤表` 小节（复用 v11 团队同名码） |
| `stale_write` | 409 | PATCH 的 `if_match` 与磁盘 mtime 不符（409） |
| `workflow_invalid` | 400 | 提交步骤校验未过（steps_empty 等），拒落盘（detail 带 issues） |

## 8a. v2 图编辑器（2026-10-23 实现；同日 UI 修订）

**图结构**：泳道（承接主语，横向带）× 步骤序。带内超过 4 个步骤**蛇形折行**
（偶行左→右、奇行右→左贴满行宽——折行处与上行尾垂直相邻，前向边全是短直线；
长流程不摊成超宽扁条）。画布列容量 = 各带最大行宽（≥2，窄带半列居中）。前向
实线箭头是顺序（模型固有，不可拖断）；**拖动改的是**——节点拖到别的行 = 改序、
拖到别的泳道带 = 换承接主语；从节点右缘手柄拖到**更早**的节点 = 建/改回流边
（写规范形 `回 N`，图上以右弧虚线 + 「回 N」短标签展示，原文悬停 title）；点回流
边 = 删（清为 `—`）。改序后全表 `回 N` 自动重编号。**不做自由拓扑画布**（与
「有序步骤表 + 回流」模型冲突）。

**身份约定**：布局/边/聚焦以**数组下标**为身份（order 只作展示与「回 N」解析）——
order 重复/跳号的历史数据不会让节点重叠；数据侧由 `validateWorkflow` 的
`workflow_step_order_duplicate`（error）拦保存，parse 侧 `step_order_defaulted`
（非正整数按行号回退）兜「#」列。

**写路径**（三入口同口径 `updateWorkflowDefinition`）：agents `editWorkflow`（写前
`validateWorkflow`，error 拒落盘；if_match=mtime）→ HTTP `PATCH /api/workflows/:id` →
MCP `prism_workflow_edit` → CLI `prism workflow edit <id> --steps-file <json|->`。
**底账保真**：GET 详情带 `steps_raw`（RawWorkflowTable：columns/rows/rowIds），提交行按
`rowId` 合并未映射列（自定义列改序不错行）——镜像 v11 团队工作流编辑器契约。

**控制台**：单元详情弹窗 `size=xl`（近全屏画布，SVG 固定高度 clamp(340px,58vh,600px)）；
**图与步骤表共用同一份草稿**——图视图点节点选中、右侧字段面板改全部八列；步骤表视图逐行表单；
两侧增删步骤/上下移；改动即脏（节点描边高亮 + 「未保存」徽标），保存 PATCH 一次写回；脏草稿
关闭弹窗先确认（Esc/遮罩/关闭钮同一条守卫）。保存成功后弹窗不卸载（列表 reload 与详情
reload 分线，详情弹窗在列表 `<State>` 之外）。团队详情工作流 Pane 的「图视图」为**只读**
（缩放/平移/点节点聚焦上下游）。

**坐标与缩放**（踩过的坑）：内容整体包在 `<g class="wf-zoom-layer" transform={zoom.transform}>`
里——曾漏这层，工具条百分比会变而图纹丝不动；指针 → 内容坐标走该 `<g>` 的 `getScreenCTM()`
反解（含 viewBox meet 映射 + 内层变换 + 页面滚动），**不要**手算 `rect`/`scale`——曾只除
`zoom.scale`，漏掉 SVG 自身 meet 缩放，拖一格飞两格（实测把第 4 步拖到第 2 位却掉到最后）。
happy-dom 无 CTM 时降级为等价算式（测试锁定）。

**身份**：草稿行身份是 `stepId`（= 原 rowId；新增行 `new:` 前缀，保存时不带 rowId）——
选中态、增删、移动、PATCH 的 rowId 对齐全按它，**不用数组下标**（拖拽重排后下标会指错行）。
样式走 `--sheet/--rule/--buckram` 等既有 token（曾因引用不存在的 `--line/--bg-1/--accent`
全部静默失效——教训：新增样式先核对 token 表）。

## 9. 待确认项

| # | 问题 | 状态 |
| :-- | :-- | :-- |
| 1 | 界面结构化编辑器（写路径 + if_match + 回收站 + CLI new/edit/rm） | ✅ 已实现（v2 图编辑器：PATCH/if_match/底账保真；CLI `workflow edit`）。`new/rm` 仍不做（单元=文件，低频） |
| 2 | 团队工作流表「引用: workflows/x.md」的存储结构化与可点化 | ⏳（v1 前端可文本识别；结构化需 team 契约改动） |
| 3 | `承接` 列是否引入强校验白名单（含编排词登记制） | ⏳（现状 warning + 豁免词表，避免假门禁） |
| 4 | workflows 与 KB/版本关联（单元变更历史、跨团队引用统计） | ⏳ |
| 5 | 角色级 binds 与「被谁引用」节的一致性自动校验 | ⏳（v1 靠 validateWorkflow 的 binds 强校验兜底） |
| 6 | 团队页图编辑（拖动映射 team PATCH） | ⏳（v3；团队编辑保留既有卡式编排器，图只读） |
| 7 | 自由拓扑画布（任意连线/自由摆放） | ❌ 明确不做（与有序步骤表 + 回流模型冲突） |
