# 加角色 / 改模型 / 改思考档位

## 存放位置

| 位置 | 路径 | 生效范围 |
|------|------|----------|
| 用户级（推荐） | `~/.zcode/agents/<name>.md` | 所有项目 |
| 项目级 | `<repo>/.zcode/agents/<name>.md` | 仅该项目，可随仓库共享 |

也可以用界面：设置 → 子智能体 → 新建（效果同写文件）。
注意：`~/.zcode/agents/` 同时被其他体系使用（当前有 dev、frontend-dev、junior-dev、reviewer、tester、workbuddy 等），新建团队角色用不冲突的名字，且**先经用户同意再写**。

## 文件格式

```markdown
---
name: my-role            # 必填，必须与文件名一致，kebab-case
description: "职责 + 适用于 + 不适用于 + 与相近角色的分工"   # 必填，队长派遣的决策依据
color: cyan              # 可选：red/blue/green/yellow/purple/orange/pink/cyan
tools: ["*"]             # 可选：["*"] 全部；或列表如 [Read, Glob, Grep, Bash]
model: GLM-5.3           # 可选：供应商模型 ID（GLM-5.3 / GLM-5.3-Flash / ...）；缺省继承会话模型
thoughtLevel: max        # 可选：low / high / max
permission: default      # 可选：default/acceptEdits/plan/auto/dontAsk/bypassPermissions
---

# 角色：xxx

## 核心契约
**一句话原则。**（解释它如何裁决日常两难）

## 职责 / 工作方式 / 边界（禁止）
...
```

正文整体作为该角色的系统提示词。

## 核心契约的写法（团队规范，必须遵守）

每个角色的正文第一节必须是 `## 核心契约`，一句**可裁决冲突的原则**。好契约的标准：具体到能在两难时当裁判——
- ✅「先证明，后攻坚」（遇到"直接写还是先验证"的犹豫时，答案确定）
- ✅「没有运行证据的通过等于造假」（"开发说没问题能不能过"——不能）
- ❌「认真负责地完成任务」（口号，无法裁决任何冲突）

## description 的写法

它是队长派遣时的决策依据（队长只看名字和描述选人），按四段写：**职责 → 适用于 → 不适用于 → 与相近角色的分工**。写得越能排除误派越好。

## 生效时机（已实测）

agent 列表在**会话启动时扫描一次并定格**，运行中不重读文件——
- 新建/修改的角色文件：**下一个会话**才可派遣（本会话派遣会报 `not found`）
- 本会话兜底：`subagent_type: "general-purpose"`，把新角色的核心契约与职责粘进 prompt 开头，行为一致但模型/思考档位跟随会话默认；交付报告中注明此降级

## 改模型 / 思考档位

改对应角色文件的 `model` / `thoughtLevel` 字段即可，同样下一会话生效。模型 ID 以供应商配置为准（BigModel 当前：GLM-5.3、GLM-5.3-Flash、GLM-5-Turbo；思考档位 low/high/max）。

内置两个角色的模型也可在界面的「继承默认」下拉里覆盖（存于 `~/.zcode/v2/agents-state.json`），自定义角色直接改文件。
