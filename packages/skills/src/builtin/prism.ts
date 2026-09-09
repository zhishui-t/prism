import type { PrismSkill } from '../types.js'
import { PRISM_MARKER_PREFIX, prismSkillMarker } from '../marker.js'

/**
 * `prism` 元 skill（skill-loading.md §6.5 / design-v3 §3.2）：
 * 教宿主如何使用 Prism（MCP 工具、CLI、团队启用链路）。
 * - name kebab-case；description 含触发词且 ≤1024 字符（含冒号 → 必须 YAML 双引号）
 * - marker 写在 frontmatter 之后的独立 HTML 注释行（design-v3 §5 P12），
 *   安装冲突策略据此区分「Prism 装的（可覆盖）」与「人写的（不覆盖）」。
 */
const PRISM_SKILL_CONTENT = `---
name: prism
description: "使用 Prism 平台能力时触发：检索/沉淀知识（kb）、查询代码图谱（graph）、启用团队与派发角色（team/role）、装配 Skill，或用户提到 prism、PRISM_HOME、知识库、落库、启用团队时使用。"
---

${prismSkillMarker('prism')}

# Prism 使用手册（元 Skill）

Prism 是本机的研发效能控制面：知识库（分层 KB）、代码图谱、专家角色库与团队编排。
它不执行任务，只提供定义、检索与装配；执行归宿主（你）。

## 1. MCP 工具（prism_*）

| 工具 | 何时用 |
| :--- | :--- |
| prism_kb_search | 回答「项目怎么做的/规范是什么」前先查知识库，不要凭空编 |
| prism_kb_get | 取单条知识全文（可指定版次） |
| prism_kb_deposit | 用户说「记住/沉淀/落库」时；必须带来源（任务 ID + 角色） |
| prism_graph_query / prism_graph_status | 追代码调用链、影响面；先 status 后 query |
| prism_role_list / prism_role_render | 拉取角色定义、渲染成宿主格式（装配用） |
| prism_team_get / prism_team_activate | 启用团队：返回成员 + 工作流 + 每个角色的 dispatch 状态 |

## 2. 团队启用链路（关键）

1. \`prism_team_activate { team_id }\` 返回 \`members[].dispatch\`：
   - \`native\`：角色已装进宿主目录，直接 \`subagent_type: "<角色名>"\` 派发；
   - \`fallback\`：未装——用 \`general-purpose\` 派发，并把它返回的 \`definition\`
     （核心契约 + 职责）粘进 prompt 开头；交付报告须注明「降级派发」。
2. 角色文件在**会话启动时扫描一次**：新装/改写的角色要**下一会话**才能 native 派发。
3. 装配命令：\`prism role install <name> --zcode-dir <宿主目录>\`（或 \`prism team install <id>\`）。

## 3. 知识沉淀规则

- 检索优先级：\`role > project > global\`；回答时注明知识来源（层/书/ID@版次）。
- 沉淀必须带来源；安全红线类知识强制 \`layer: global\`。
- 不确定的知识先 search 再 deposit（同 id 追加版次，不覆盖历史）。

## 4. CLI 速查

\`\`\`
prism init [--home <PRISM_HOME>] [--zcode-dir <宿主目录>] [--force]   # 接入初始化
prism kb search <q> / kb get <id> / kb deposit                        # 知识库
prism role list/show/validate/render/install/import                   # 角色
prism team list/show/validate/install/activate                        # 团队
prism skill list/install                                              # Skill
prism serve [--port 7777]                                             # HTTP API + 控制台
\`\`\`
`

/** prism 元 skill：教宿主如何使用 Prism（随 `prism init` / `prism skill install` 安装）。 */
export const prismSkill: PrismSkill = {
  name: 'prism',
  description:
    '使用 Prism 平台能力时触发：检索/沉淀知识（kb）、查询代码图谱（graph）、启用团队与派发角色（team/role）、装配 Skill，或用户提到 prism、PRISM_HOME、知识库、落库、启用团队时使用。',
  content: PRISM_SKILL_CONTENT,
  builtin: true,
}

/** 断言内置 skill 自身合法（防模板被改坏后静默装出坏 skill）。 */
export function assertBuiltinSkillsValid(): void {
  for (const skill of builtinSkills) {
    const marker = `${PRISM_MARKER_PREFIX}skill: ${skill.name})`
    if (!skill.content.includes(marker)) {
      throw new Error(`内置 skill 缺少 Prism marker: ${skill.name}`)
    }
  }
}

/** 全部内置 skill（design-v3 §3.2 listBuiltinSkills）。 */
export const builtinSkills: PrismSkill[] = [prismSkill]
