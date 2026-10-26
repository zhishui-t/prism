# Workflows —— 工作流单元库（一等公民 · 约定层）

> 工作流是「怎么干」的过程单元，从角色正文与团队定义的散文里提出来，成为**独立可复用文件**。
> 角色可以绑定自己的工作流；团队的工作流表用「引用:」语法调用角色级单元——同一份过程定义，
> 写一次，处处引用。本目录是**约定层**（零产品改动）：宿主按路径装配，派发时把路径给子代理自己读，不转述。

## 单元格式（骨架）

```markdown
---
workflow: <id>            # 唯一 id（kebab-case，= 文件名）
name: <中文名>
level: role | team        # 角色级（绑定角色）/ 团队级（供团队编排引用）
binds: [<角色名>]          # 角色级必填；多承接者/队长指挥时留空，见步骤表「承接」列
skills: [<skill名>]       # 步骤用到的 skill
---

# <名称>（<id>）

> 一句话定位。

## 步骤表

| # | 步骤 | 承接 | skill | 输入工件 | 输出工件 | 完成判定 | 回流 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |

## 硬性约束
- （不可跳步 / 不可倒置 / 证据要求等）

## 被谁引用
- 角色绑定 / 团队引用清单
```

## 引用语法

- **角色绑定**：角色文件正文加一行 `> 本角色工作流：<路径>（派发时附路径，子代理自己读）`
- **团队引用**：团队工作流表的「负责角色」或「输入」列写 `引用: workflows/<单元>.md`——
  该阶段照被引单元的步骤表与硬性约束执行
- **技能即工作流载体**：有的工作流本体在 skill 里（如 design-verify 六步），单元文件只做
  登记与输入输出定义，正文指向 skill 文件，**不重写**——skill 是唯一真相源

**设计约束（压缩恢复的基石）**：步骤表每行的「完成判定」必须可从黑板文件**机械判定**
（工件存在 / 门禁签署 / 状态列值），不得依赖对话记忆——队长上下文被压缩后，进度靠文件重建
（读黑板 → 重读流程定义 → 向用户简报断点），不靠记忆。单元文件本身是**无状态**的过程定义，
执行状态一律落在黑板；子代理实例各持上下文不受队长压缩影响，实例死亡也要能从黑板重建
（登记表探活 + 最近产物恢复）。

## 冲突裁决

与声明「严格执行」的团队定义（如 `examples/teams/delivery.md`）冲突时，**以团队定义为准**
（同 agent-team 的模板冲突规则）；本目录是一般规范源。执行细节以团队定义里的领域经验优先。

## 装配

```bash
cp -r examples/workflows ~/.zcode/workflows/     # 或你宿主的 workflows 目录
```

角色/团队文件里的引用路径按装配位置改写（同 examples 根 README 的绝对路径提醒）。

> **已资产化（2026-10-24，workflow-asset.md）**：工作流单元成为 Prism 第 5 类资产——
> `prism workflow list | show | validate`（CLI）、MCP `prism_workflow_list | get`、控制台「工作流库」页
> （浏览/校验状态/深链 `#/workflows/<id>`）、角色表单可勾选挂载。v1 只读（编辑保持文件级），
> 目录解析走适配器 `agent.workflowDir`（prism.yaml `workflows_dir` 可覆盖）。
> 本目录骨架 = 资产契约的规范源，二者由 `packages/agents` 的解析/校验单点保持一致。

## 单元清单与对照表

| 单元 | 级别 | 绑定/服务 | 对应既有定义 |
| :-- | :-- | :-- | :-- |
| `frontend-pipeline.md` | 角色 | frontend-dev | delivery.md「前端三技能组合」/ frontend-dev.md 三段 |
| `tester-dual-track.md` | 角色 | tester-whitebox + tester-blackbox | delivery.md「tester 技能流水线」阶段 7+8 |
| `dev-red-green.md` | 角色 | dev | dev.md「核心契约/工作方式」+ delivery.md 开工门禁（spec-guard） |
| `design-verify-flow.md` | 角色 | 队长指挥 + 独立实例 | design-verify skill 六步（载体即 skill） |
| `sec-audit.md` | 角色 | reviewer | 新增（reviewer 契约「安全/红线检查」的过程化） |
| `vuln-response-flow.md` | 团队 | vuln-response 团队 | 新增（独立 intake 演示） |

> delivery 十阶段是「严格执行」团队定义内的工作流，**不**在本目录复制——映射关系见
> `examples/pipeline.md` 主干地图。
