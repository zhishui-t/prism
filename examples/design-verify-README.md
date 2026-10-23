# Examples —— design-verify 设计文档开发前验证技能

一套「拿着 AI 写的设计文档准备开发之前，先验证再写码」的完整流程技能：**两端锚死真相
（业务真相 + 代码证据），中间机器查事实、矩阵查断头路、红队挑风险，人只守三个位置
（质检抽查 / 门禁裁决 / 业务确认）**。专为「接手陌生项目、不懂业务没读过代码」的处境设计——
把验证从「判断对错」（需要业务知识）改造成「核对证据」（机械可查 + 人抽查）。

## 流程一览（六步 · 轻重双路径）

| 步 | 做什么 | 产出（`.design-verify/`） | 门禁 |
| :-- | :-- | :-- | :-- |
| 0 | 锁定业务真相源（有专家签字 / 无专家蒸馏一页行为契约并显式降级） | behavior-contract.md | 真相已确认或已声明代理 |
| 1 | 事实锚定：**图优先解析符号**（有图谱用 `prism graph explain/path/affected`，无图或陈旧则降级 grep）→ 承重断言 → 锚点账本 → 脚本机械核查 + 独立实例语义复核 + **人抽 5 条质检** | anchors.md / verdict.md / semantic-review.md | BLOCKER（编造 / 文件不存在 / 格式坏 / 读取失败）清零 |
| 2 | 跨文档闭环：追溯矩阵找断头路，六类缺口分级处置（第六类只记不堵） | trace-matrix.md / backlog.md | 核心链路断头路清零 |
| 3 | 技术风险红队：新会话独立实例按固定清单挑刺，人对高风险横切点抽样反证 | redteam-report.md | P0 风险有验证方式或修复方案 |
| 4 | 门禁裁决：Go / Go with Gaps / No-Go（**只能人签**） | gate.md | 显式签署才开工 |
| 5 | 修复与复验：只查修复项及影响面，不全量重跑 | gate.md 复验记录 | 闭环 |

全流程 vs 轻量（第 1 + 4 步）的触发条件、以及每步细则，见 `design-verify/SKILL.md` 与其
`references/`。**接手后第一份设计文档建议走全流程。**

## 目录

| 路径 | 内容 | 装配到 |
| :-- | :-- | :-- |
| `design-verify/` | design-verify 技能（六步指挥手册 + 3 份操作细则 + 5 份模板 + 1 个核查脚本） | `<技能目录>/design-verify/`（如 `~/.agents/skills/` 或 `~/.zcode/skills/`） |

## 依赖

- **必须**：队长会话有子智能体派发能力（第 1 步语义复核与第 3 步红队需要独立实例）
- **推荐**：**代码图谱（Prism `prism_graph_*` / `prism graph`）**——第 1 步图优先解析符号（有图先用、没图降级 grep、陈旧图不信任，细则见 `design-verify/references/code-graph.md` 与 `scripts/resolve-symbols.mjs`）；reviewer 角色契约（本仓 `examples/roles/reviewer.md`）与 spec 系列技能
  （spec-writer / spec-verify / spec-vs-impl-checker）——均为本地默认选型，见
  `design-verify/references/tooling.md`
- **全部外部工具为可选后置**（@nullius-inverba/claims、gsd-doc-verifier、cc-sdd、designdoc、
  RTMX、absolute-spec、wl-skills-design）：核实快照与进场条件（同维度比武胜出才替换）写在
  `references/tooling.md`，不随技能安装

## 装配（ZCode 宿主为例）

```bash
cp -r examples/design-verify ~/.agents/skills/design-verify   # 或 ~/.zcode/skills/
```

装配后新会话生效。对指挥会话说「验证设计文档」「锚点核查」「开发前验证」，或在用户即将
依据 AI 产出的设计文档开工时主动触发。

## 快速上手

```bash
# 0) 组件自检：spec 三件套等必需项是否齐备（缺什么列什么；SKILL_HOMES/ROLES_DIR 可覆盖目录）
node ~/.zcode/skills/design-verify/scripts/kit-check.mjs

# 1) 第一步·机械层冒烟
mkdir -p .design-verify
cp ~/.zcode/skills/design-verify/templates/anchors.md .design-verify/anchors.md   # 换成真实锚点
node ~/.zcode/skills/design-verify/scripts/check-anchors.mjs .design-verify/anchors.md
echo $?   # 0 = 无 BLOCKER；1 = 有 BLOCKER（看输出的裁决表）
```

## 与 agent-team 的关系

在 agent-team / delivery 流水线内，本技能可作为**卡点③（设计确认）质量审核**的执行手法
（锚点核查替代泛泛评审，gate.md 并入 `.design_ok` 证据链）；独立使用时流程完整自洽。
`.design-verify/` 与 `.agent-team/` 两块黑板并存互不干扰。
