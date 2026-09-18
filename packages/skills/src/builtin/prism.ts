import type { PrismSkill, SkillAsset } from '../types.js'
import { PRISM_MARKER_PREFIX, prismSkillMarker } from '../marker.js'

/**
 * `prism` 元 skill（skill-loading.md §6.5 / prism-skill.md）：
 * 教宿主**如何使用 Prism**——六大模块的 MCP 工具、CLI、团队启用链路、知识沉淀约定。
 *
 * 组织原则（prism-skill.md §4 渐进披露）：主 SKILL.md 只放判定表与骨架，
 * 细节进 `references/`，按需读取——避免每次触发都把全部细节塞进上下文。
 * - name kebab-case；description 含触发词且 ≤1024 字符（含冒号 → 必须 YAML 双引号）；
 * - marker 写在 frontmatter 之后的独立 HTML 注释行（design-v3 §5 P12）。
 */
const PRISM_SKILL_CONTENT = `---
name: prism
description: "使用 Prism 平台能力时触发：检索/沉淀知识（kb）、查询知识图谱与代码图谱（graph）、渲染架构图（arch）、启用团队与派发角色（team/role）、领取 LLM 待办（work）。或用户提到 prism、PRISM_HOME、知识库、落库、代码图谱、影响面、架构图、启用团队时使用。注意：纯代码结构问答优先 graphify；本 Skill 负责 Prism 服务接入与资产消费。"
---

${prismSkillMarker('prism')}

# Prism 使用手册（元 Skill）

Prism 是本机的**研发效能控制面**：知识库、知识图谱、代码图谱、架构图谱、专家角色与团队。
**它不执行任务、不调 LLM、不调度 agent**——只提供资产；执行归宿主（你）。

## 0. 快速路径：先看状态，再决定查还是建

**回答任何「项目怎么做的 / 规范是什么 / 谁调用谁」之前，先确认资产存在**，不要盲目重建：

| 要查什么 | 先看状态 | 有产物 → | 没产物 → |
| :--- | :--- | :--- | :--- |
| 知识（规范/红线/决策） | \`prism_kb_stats\` | 直接 \`prism_kb_search\` | 告知「知识库为空」，问用户是否导入 |
| 代码结构（调用/影响面） | \`prism_graph_status\` | 直接 \`prism_graph_query\` | 提示先 \`prism graph build <项目根>\` |

**关键**：\`graphify-out/graph.json\` 已存在且用户只是问问题 → **直接查询，不要重新建图**。
建图只在这些情况发生：用户明确要求、产物不存在、或 \`status\` 报陈旧且用户同意重建。

## 1. 快速判定：什么时候用哪个

| 用户意图 | 用什么 | 细节 |
| :--- | :--- | :--- |
| 查规范 / 安全红线 / 架构决策 | \`prism_kb_search\` → \`prism_kb_get\` | [references/knowledge.md](references/knowledge.md) |
| 用户说「记住 / 沉淀 / 落库」 | \`prism_kb_deposit\`（必带来源） |
| **导入项目知识/文档** | **宿主自己做**：读文档 → 用你的 LLM 能力提取 → 逐条 \`prism_kb_deposit\` | [references/import.md](references/import.md) |
| 派发子代理前组装上下文 | \`prism_context_pack\`（按角色知识绑定 + 预算） | [references/knowledge.md](references/knowledge.md) |
| 知识之间的引用关系 / 找关联条目 | \`prism_kb_graph\` | [references/knowledge.md](references/knowledge.md) |
| 谁调用谁 / 影响面 / 最短路径 | \`prism_graph_query/path/affected/explain/god-nodes\` | [references/graph.md](references/graph.md) |
| 画架构图 / 时序图 / 数据流图 | **Prism 自动派生，你不用产 IR**：\`prism_arch_generate\`（或 CLI \`prism arch from-team / from-graph / from-state\`） | [references/arch.md](references/arch.md) |
| 派团队干活 | 先 \`prism_team_activate\` 看 dispatch，再派发 | [references/team.md](references/team.md) |
| 导入项目文档（二进制） | \`prism_kb_convert\`（→Markdown）→ 你提炼 → \`prism_kb_deposit\` | [references/import.md](references/import.md) |
| 批量导入整个项目文档 | \`prism_kb_import\`（扫目录建引用索引） | [references/import.md](references/import.md) |
| 回写你的 LLM 产出（摘要/标签/实体） | \`prism_kb_enrich\` | [references/import.md](references/import.md) |
| 环境自检 / 换宿主 / 打包 | \`prism doctor\` / \`prism harness show\` | [references/cli.md](references/cli.md) |

## 1.5 第一次接入：从零到能用

\`\`\`bash
prism init --yes                     # ①探测 ②建骨架 ③装本 Skill ④写 MCP 注册 ⑤提示重启
prism doctor                       # 自检：Node 版本 / 目录 / DB / graphify / 端口
prism serve --ensure               # 后台幂等起控制台（已在跑则复用）；--check 看状态 / --stop 停它
\`\`\`

**验收标准**（\`prism doctor\` 应全绿）：
- Node ≥ 22.5；\`PRISM_HOME\`（默认 \`~/.prism\`）可写；
- \`graphify\` 可调用（\`3rd/graphify\` 或 PATH）；
- MCP 注册已写入宿主配置；Skill 已装到 \`skills_dir\`。

> **「重启后 Prism 不启动」怎么解（最容易走偏的一节）**
>
> Prism 接进宿主用的是 **MCP 的 stdio 形态**（注册里是 \`command: node\` + \`args: [server.js]\`）：
> **宿主启动时自己拉起这个进程，宿主退出它自动结束**——**所以本来就不需要配开机自启**。
> 真正的常见故障是**注册指向的路径失效**（部署目录被清理，或指到了开发布局
> \`packages/server/dist/…\` 而包里实际是 \`node_modules/@prism/server/dist/…\`）→ 宿主永远拉不起来。
> 修法就一条：\`pnpm run deploy\` —— 把包装到**恒定路径** \`<PRISM_HOME>/runtime/\` 并校正注册；
> 之后升级只换目录内容，**注册路径永不变**。
>
> 控制台（web UI，默认 127.0.0.1:7777）是**另一回事**——它要常驻，有两条路：
> **① 宿主启动时 MCP 顺带 \`ensure\` 拉起**（零配置）；**② 登录自启**（\`deploy\` 会装进启动文件夹）。
> 关掉自动拉起：\`PRISM_SERVE_AUTOSTART=0\`；换端口：\`PRISM_SERVE_PORT=<n>\`；
> 查状态 / 停止：\`prism serve --check\` / \`prism serve --stop\`。

**装完必须重启宿主**——MCP 工具与 Skill 在会话启动时加载，当前会话看不到。
**首次建图**：\`prism graph build <项目根> --name <项目名>\`（Python graphify，零 LLM）。
**首次导入知识**：\`prism kb import <file.md> --layer global --book <书>\`。

## 2. 团队启用链路（最关键，别搞错）

1. \`prism_team_activate { team_id }\` 返回 \`members[].dispatch\`：
   - \`native\`：角色已装进宿主目录，直接 \`subagent_type: "<角色名>"\` 派发；
   - \`fallback\`：未装——用 \`general-purpose\` 派发，并把它返回的 \`definition\`（核心契约 + 职责）粘进 prompt 开头；交付报告须注明「降级派发」。
2. 角色文件在**会话启动时扫描一次**：新装/改写的角色要**下一会话**才能 native 派发。
3. 角色与团队**直接住在宿主目录**（\`<roles_dir>/*.md\`、\`<teams_dir>/<id>.md\`）——**没有"导入/装配"这一步**：
   建角色 = \`prism_role_new\`（MCP）／\`prism role new <name>\`（CLI）／web 控制台；
   建团队 = \`prism_team_new\`（MCP）／\`prism team new <id>\`（CLI）／web 控制台。
   改/删同理同名：\`prism_role_edit|rm\`、\`prism_team_edit|rm\`（CLI \`role edit|rm\` / \`team edit|rm\`）。
   派生要求：\`prism_team_activate\` 报 \`fallback\` 时说明该角色文件不在宿主目录，别去找"装配命令"。

## 3. 硬约定（违反会被评审打回）

| 约定 | 说明 |
| :--- | :--- |
| **先查后答** | 回答「项目怎么做的/规范是什么」前先 \`prism_kb_search\`，不要凭空编 |
| **标注来源** | 引用知识必须带来源地址：\`层[/owner]/书/模块/ID@版次\` |
| **沉淀带来源** | \`prism_kb_deposit\` 必带 \`deposited_by\`（谁/团队）；安全红线类强制 \`layer: global\` |
| **图谱换 token** | 用查询拿子图，**绝不读全图**；先 \`prism_graph_status\` 看是否陈旧 |
| **不抢调度** | Prism 不派发任务；派发是宿主的活 |
| **不调 LLM** | 需要 LLM 的活落成 work_request，由你（宿主）拉取执行 |

## 4. 四个「不」（边界）

- **不侵入调度**：子 agent 管理归宿主，Prism 不碰；
- **不调 LLM**：Prism 零 API key；需要 LLM 的活（摘要/分类/实体抽取）由**你产出后用 \`prism_kb_enrich\` 回写**；
- **不做审核**：宿主说落库就落库，Prism 只记录/可视化/审计；
- **不管版本控制**：Prism **不读 git、不提交、不推送、不写 .gitignore**。
  它只回答「文件在不在」；提交/更新是宿主的职责——**宿主做完任务后自行提交，
  再触发 \`prism kb sync\` / \`prism graph build\` 刷新索引**。

## 4.5 诚实规则（引用 Prism 数据时必须遵守）

- **查不到就说查不到**：\`prism_kb_search\` 无命中 → 明确告知「知识库没有这条」，**不要用常识补全**；
- **引用必带来源地址**：格式 \`层[/owner]/书/模块/ID@版次\`，便于人回溯；
- **陈旧要标注**：\`prism_graph_status\` 报 \`stale: true\` 或知识条目 \`freshness\` 低 → 回答时说明「可能已过期」；
- **不编边**：图谱没有的关系不要推断；\`confidence\` 字段（EXTRACTED/INFERRED）照实呈现；
- **不读全图**：用查询拿子图（\`limit\`/\`depth\` 有界），避免把整张图塞进上下文。

## 5. 工具速查（48 个 MCP 工具）

| 分组 | 工具 |
| :--- | :--- |
| 知识库（17） | \`prism_kb_search\` \`prism_kb_get\` \`prism_kb_deposit\` \`prism_kb_convert\` \`prism_kb_import\` \`prism_kb_enrich\` \`prism_kb_graph\` \`prism_kb_tree\` \`prism_kb_stats\` \`prism_kb_catalog\` \`prism_kb_path\` \`prism_kb_remove\` \`prism_kb_restore\` \`prism_kb_conflicts\` \`prism_kb_resolve_conflict\` \`prism_kb_versions\` \`prism_kb_book_structure\` |
| 代码图谱（8） | \`prism_graph_query\` \`prism_graph_path\` \`prism_graph_explain\` \`prism_graph_affected\` \`prism_graph_god_nodes\` \`prism_graph_summary\` \`prism_graph_status\` \`prism_graph_merge\` |
| 架构图谱（1） | \`prism_arch_generate\`（五类图统一入口：workflow 传 \`team\`，architecture/sequence/dataflow 传 \`project\`，lifecycle 无入参；可选 \`book\`/\`module\`/\`out\`） |
| 角色团队（22） | \`prism_role_list\` \`prism_role_get\` \`prism_role_new\` \`prism_role_edit\` \`prism_role_rm\` \`prism_role_render\` \`prism_team_list\` \`prism_team_get\` \`prism_team_new\` \`prism_team_edit\` \`prism_team_rm\` \`prism_team_render\` \`prism_team_activate\` \`prism_context_pack\` \`prism_skill_effective\` \`prism_skill_list\` \`prism_skill_install\` \`prism_skill_uninstall\` \`prism_skill_categorize\` \`prism_skill_category_add\` \`prism_skill_category_rename\` \`prism_skill_category_rm\` |

> **导入三件套**：\`prism_kb_convert\`（文档→Markdown，本地 anydoc 转换）→ 你提炼 →
> \`prism_kb_deposit\` 逐条落库；或 \`prism_kb_import\` 一次扫描整个项目目录建引用索引。
> \`prism_kb_enrich\` 把你的 LLM 产出（摘要/标签/实体）回写进库（Prism 不调 LLM、不审核）。
>
> **MCP 与 CLI 的分工**：需要结构化调用（宿主 agent 用）优先 MCP；一次性/交互式操作（人在终端用）
> 走 CLI。架构图谱**两个入口都有**：MCP \`prism_arch_generate\`（会话内首选），CLI \`prism arch ...\`。
>
> ✅ **别手搓架构图 JSON**：五类图（workflow / architecture / sequence / lifecycle / dataflow）的 IR
> **全部由 Prism 纯函数自动派生**，数据源分别是团队定义、代码图谱、任务状态机——
> 你只要 \`prism_arch_generate { type, team?, project? }\`（或对应的 CLI 子命令），**不需要产 IR**。
> \`prism arch schema\` 已降级为契约核对/排障用途。
>
> ⚠ 真实图谱上可能**有理由地拒画**（同目录扁平仓库无处分层、图谱无跨文件 calls 边、层数不足两级），
> 此时会报错并说明理由——这是预期行为，**别改口径硬画**。\`dataflow\` 的口径是**依赖流向视图**
> （图谱没有 reads/writes 边），不是数据读写流。详见 [references/arch.md](references/arch.md)。

## 6. CLI 速查

\`\`\`
prism init [--yes] [--force]                   # 接入：注册 MCP + 装 Skill + 建骨架（--harness-root 覆盖落点=测试/CI 专用）
prism serve [--port 7777]|--ensure|--check|--stop  # 控制台：前台 / 后台幂等 / 查状态 / 停
prism doctor                                   # 环境自检
prism harness list | show                      # 运行时宿主适配器
prism kb     import/sync/search/get/tree/stats/graph/path/remove/conflicts/resolve/export/reindex
prism graph  build/query/path/explain/affected/god-nodes/summary/export/status
prism inject <项目根> [--team <id>] [--remove]  把 Prism 指引写进项目 AGENTS.md 标记块
prism project add/list/show/remove          项目台账（登记后 kb sync 可扫）
prism arch   types/schema/validate/render/from-team/from-graph/from-state  # 架构图谱（五类图全自动派生）
prism role   list/show/new/edit/rm/validate/render [--source <dir>]
prism team   list/show/new/edit/rm/validate/render/activate [--source <dir>] [--roles-dir <dir>]
prism skill  list/install/update/uninstall/validate/effective/categorize/category
                                              # category add <名称> | rename <旧名> <新名> | rm <名称>
                                              # 分类清单增删改（不碰宿主技能文件）
\`\`\`

**写守卫**：目标是默认宿主目录且未显式指定时会拒绝（\`guard_required\`），加 \`--yes\` 确认写入默认宿主配置（\`--harness-root\` 为测试/CI 专用）。
`

/** 附带文件：按需读取的细节（渐进披露）。 */
const PRISM_SKILL_ASSETS: SkillAsset[] = [
  {
    path: 'references/import.md',
    content: `# 导入项目知识（宿主工作流）

**你（宿主）是导入的执行者。** Prism 是库房，不调 LLM、不在 Web 触发导入——
读取、理解、提取全由你完成，Prism 只负责校验落库与检索。

## 两种导入方式

| 方式 | 谁干活 | 工具 |
| :--- | :--- | :--- |
| **引用型索引**（机械） | Prism（零 LLM） | \`prism_kb_import\`（或 CLI \`prism kb sync <项目名>\`） |
| **结构化提取**（智能） | **你**（用你的 LLM 能力） | \`prism_kb_convert\` 取正文 → 你提炼 → \`prism_kb_deposit\` |

两者不冲突：先 import 建底，再做结构化提取。

**二进制文档先转换**：docx/pdf/xlsx/pptx/csv 等用 \`prism_kb_convert { path, max_chars? }\`
拿 Markdown（本地 anydoc 转换，零 LLM；图片型扫描 PDF 返回 \`needs_ocr\`）。
md/txt/html 直接读原文即可，无需转换。

## 结构化提取工作流（你来做）

1. **读文档**：项目 docs/、AGENTS.md、README、设计文档、规范文件（二进制先 \`prism_kb_convert\`）
2. **提取知识单元**（每条一个知识点，不要整篇 dump）：
   - 规则 → \`type: rule\`（"禁止吞异常"）
   - 坑 → \`type: pitfall\`（"Windows 下 tar 路径会被当远程主机"）
   - 模式 → \`type: pattern\`（"写守卫：默认目录前必须确认"）
   - 指南 → \`type: guide\`（"如何发布版本"）
   - **单条正文建议 ≤ 1500 字**：本地 embedding 是 CPU 推理，超长会拖慢且被截断；
     长文档请**拆成多条**（本就符合"提取而非拷贝"）
3. **判断归属**：
   - 公司级规范 → \`layer: global\`
   - 本项目知识 → \`layer: project\` + \`owner: <项目名>\`
   - 角色专属 → \`layer: role\` + \`owner: <角色名>\`
   - 书 = 项目名（一个项目一本书）；模块 = 文档主题或目录
4. **逐条落库**：

\`\`\`json
prism_kb_deposit({
  title: "禁止吞掉异常",
  type: "rule",
  layer: "project",
  owner: "order-platform",
  book: "order-platform",
  module: "exception",
  content: "捕获异常后必须记录并重新抛出……",
  risk: "high",
  tags: ["java", "exception"],
  source: { kind: "agent", ref: "docs/standards/java.md#L42" },
  deposited_by: { subject: "<你的标识>" }
})
\`\`\`

## 硬约定

- **必带 source.ref**：指回原文件与行号，人可回溯
- **必带 deposited_by**：留痕
- **提取而非复制**：如果条目内容和原文一样，就不该建条目（直接用引用型索引）
- 正文里的 \`[[条目id]]\` 会自动建边——相关知识点互链
- 同 id 再 deposit = 新版次（内容没变会自动跳过，不会堆叠）

## 建代码图谱（也是你执行）

\`\`\`bash
prism graph build <项目根> --name <项目名>              # 全量（零 token）
prism graph build <项目根> --name <项目名> --incremental # 增量（已有图谱时）
\`\`\`

建完后 Web 控制台「代码图谱」页查看（只读）；宿主做完任务提交代码后自行触发增量重建。

## 向量化（Prism 自理，不依赖宿主）

embedding 由 Prism **内置模型**生成，**不需要你回填**——落库即自动向量化（模型就绪时）。
检索默认走 **BM25 + 向量融合（RRF）**：关键词命中不了的同义/跨语言查询也能语义召回。

**按算力自动分档**（有显卡用强档，无显卡用轻量档，你不用操心）：

| 档位 | 模型 | 维度 | 适用 |
| :--- | :--- | ---: | :--- |
| \`small\` | bge-small-zh-v1.5 | 512 | 无 GPU（CPU 友好，约 25MB） |
| \`default\` | BGE-M3 | 1024 | 多语言基线 |
| \`large\` | Qwen3-Embedding-0.6B | 1024 | 有 GPU（更强，约 0.2s/条） |

\`\`\`bash
prism embedding install                    # 首次：编译 llama.cpp + 按算力装模型（有显卡自动加 GPU/Vulkan 包）
prism embedding models                     # 查看三档与当前生效项
prism embedding use <small|default|large>  # 切换档位（写入 prism.yaml；换后跑 reindex 重算向量）
prism embedding status                     # 安装 / 后端(GPU|CPU) / 档位 / 维度
prism embedding reindex                    # 为已有条目补齐/重算向量（幂等）
\`\`\`

**换档注意**：不同模型向量空间不共通，换档后旧向量自动失效，需 \`prism embedding reindex\`
按新模型重算（未重算期间该条目仅靠 BM25 命中，不报错）。

未安装时自动降级纯 BM25，**不报错、不阻断落库**。
`,
  },
  {
    path: 'references/knowledge.md',
    content: `# 知识库（prism_kb_*）

## 内容模型

\`层 → 书 → 模块 → 条目\`。三层：\`global\`（公司级）/ \`project\`（项目级）/ \`role\`（专家专属）。
未归类的条目落 \`_inbox/\`（DB \`module=''\`）。

## 检索（prism_kb_search）

- 中文检索用 **bigram + unicode61**——两字词（如「性能」）能命中，四字词也行；
- 默认**只返回每个 id 的最新版次**；要全部版次传 \`all_versions: true\`；
- 过滤：\`layers\` / \`owner\` / \`book\` / \`module\` / \`limit\`；
- 每条结果带 \`source\`（\`层[/owner]/书/模块/ID@版次\`）与 \`excerpt\`；
- **长文档按标题分段建索引**：命中的结果额外带段级定位 \`hits\`（数组，缺省即为空/无该字段）
  —— 每项 \`{seq, heading_path, excerpt, score}\` 指出「**命中落在文档哪一节**」，回答长文档时
  优先据此定位（\`heading_path\` 为 \`A › B › C\` 形式的标题路径，导语段为空串）；
  响应级 \`chunk_scan_degraded: true\` 表示段向量扫描超护栏而整体缺席（退化为无段定位），
  \`hits_truncated: true\` 表示段列表被预算（每条目最多 4 段）截断——**未截断时这两个键不下发**。

**回答时必须标注来源**，让用户能溯源。

## 取单条（prism_kb_get）

- 不带版本 → 最新版；
- 带版本（\`ID@vN\`）→ 该版次；若已 superseded 会附带 \`superseded_by\`。

## 落库（prism_kb_deposit）

必填：\`title\` \`type\` \`layer\` \`book\` \`content\`；\`project\`/\`role\` 层必填 \`owner\`。

- 同 \`id\` 再次落库 → **版次 +1**（旧版置 superseded，不覆盖历史）；
- \`type\`：rule / doc / guide / pitfall / pattern / diagram / summary / other；
- \`risk\`：low / medium / high（供团队规则用，Prism 不据此判审）；
- **沉淀必须带 \`deposited_by\`**（\`{ subject, team? }\`）；
- 安全红线类知识强制 \`layer: global\`。

## 结构树（prism_kb_tree / prism kb tree）

\`层→书→模块\` 的计数结构，用于回答「知识库里有什么」。MCP 工具 \`prism_kb_tree\` 与 CLI \`prism kb tree [--layer <层>]\` 等价。

## 知识图谱（prism_kb_graph）

单一边表 + 多视图。边来自确定性抽取（零 LLM）：

| relation | 来源 |
| :--- | :--- |
| \`references\` | 正文双链 \`[[条目id]]\` |
| \`overrides\` | frontmatter 显式层间覆盖 |

- 不给 \`id\` → 全图概览（按度数排序）；
- 给 \`id\` → 该节点 BFS 邻域（\`depth\` 1-3）；
- 节点带 \`in_degree\`/\`out_degree\`；悬空引用保留在边上但不进节点列表。

## 手工改过文件后

正文是**真相**、DB 只是索引。手工编辑过 Markdown 后跑 \`prism kb reindex\` 重建索引与边表。

**段级索引的存量补齐**（长文档分段检索）：\`prism kb reindex --chunks [--book <书>]\` ——
按当前正文重切并补齐段行/段 FTS（幂等、逐条目事务、可中断重跑；已切且未变动的自动跳过）；
换过 embedding 档位后跑一次可一并补上段向量（嵌入未装时只补段行，不报错）。
\`prism embedding reindex\` 同样会顺带补齐段向量缺口，二选一入口即可。
`,
  },
  {
    path: 'references/graph.md',
    content: `# 代码图谱（prism_graph_*）

引擎：**Graphify**（vendored 子工程，tree-sitter AST，**代码零 token**）。
产物：\`<项目根>/graphify-out/\`（graph.json / manifest.json / graph.html / GRAPH_REPORT.md）。

## 先看状态（prism_graph_status）

返回 \`stale\` / \`changed_files\` / \`total_files\`。**陈旧就先建图**（或提示用户）。

**没建图时**（\`graph_not_found\` 或 \`graph_exists: false\`）：
不要反复重试查询——直接告诉用户「该项目还没建图」，并给出命令
\`prism graph build <项目根> --name <项目名>\`。建图是**显式动作**，由用户决定何时执行。

## 查询工具

| 工具 | 用途 | 关键参数 |
| :--- | :--- | :--- |
| \`prism_graph_query\` | BFS 遍历找相关节点 | \`q\`、\`dfs\` |
| \`prism_graph_path\` | 两节点最短路径 | \`from\` \`to\` |
| \`prism_graph_explain\` | 单节点及其邻居 | \`node\` |
| \`prism_graph_affected\` | **变更影响面**（反向遍历） | \`node\` \`depth\`（默认 2） |
| \`prism_graph_god_nodes\` | 枢纽节点排行 | \`top\` |
| \`prism_graph_summary\` | 规模统计（节点/边/社区） | — |

节点标签形如 \`handler()\`（函数）、\`app.py\`（文件）；返回带 \`src=文件 loc=行号\`。

## 使用原则

- **用查询换 token，不要读全图**；
- 影响面分析用 \`prism_graph_affected\`（反向遍历），不要自己猜；
- 改代码前先 \`affected\` 看波及范围，改完提示重新建图。

## CLI 等价

\`\`\`bash
prism graph build <目录> --name <项目名>      # 建图（零 LLM）
prism graph query "<问题>" --project <名>
prism graph path "A" "B" --project <名>
prism graph affected "<节点>" --depth 2 --project <名>
\`\`\`

## 与 graphify Skill 的分工

纯代码结构问答（「这个函数干嘛的」）优先用宿主自带的 **graphify** Skill；
需要**影响面 / 与 Prism 知识关联**时用 Prism 的图谱工具。
`,
  },
  {
    path: 'references/team.md',
    content: `# 角色与团队（prism_role_* / prism_team_*）

## 概念

- **角色 = 决策契约**：核心第一原则（冲突时牺牲什么）+ 职责 + 边界 + 能力白名单（Skill）+ 知识绑定（层/书）；
- **团队 = 成员引用角色 + 固定工作流 + 沉淀规则 + 优先级 + 仲裁链**。

角色/团队**直接住在宿主目录**（\`<roles_dir>/*.md\`、\`<teams_dir>/<id>.md\`；目录式 \`<id>/AGENTS.md\` 作兼容形态仍可被读到）。

## 启用链路（照做）

1. \`prism_team_activate { team_id }\` → 返回：
   - \`members[]\`：每个角色的 \`installed\`（是否已装）+ \`dispatch\`（\`native\`/\`fallback\`）；
   - \`workflow\` / \`deposit\` / \`arbitration\` / \`rework_limit\`。
2. 按 \`dispatch\` 派发：
   - \`native\` → \`subagent_type: "<角色名>"\`；
   - \`fallback\` → \`general-purpose\` + 把返回的 \`definition\`（核心契约 + 职责）粘进 prompt；报告注明「降级派发」。
3. **角色文件在会话启动扫描一次**——新装角色要下一会话才 native。

## 查看定义

- \`prism_role_list\`：角色库（含 \`issues\` 校验警告）。返回体里的 \`roles_dir\` **就是要传给增删改工具的 \`roles_dir\`**——读回直接回填，不要自己拼宿主路径；
- \`prism_role_render { name, model?, thought_level? }\`：渲染成宿主格式（含 \`target\` 路径）；
- \`prism_team_get { team_id }\`：团队定义全文。

## 建角色与建团队（没有"装配/导入"）

角色与团队**直接住在宿主目录**（\`<roles_dir>/*.md\`、\`<teams_dir>/<id>.md\`），
Prism 不持有第二份副本 —— 因此**不存在"把角色/团队装进宿主"这个动作**：

| 要做什么 | 怎么做 |
| :--- | :--- |
| 建团队 | \`prism_team_new { team_id, name, members, teams_dir, roles_dir? }\`（\`roles_dir\` 可选＝成员角色校验用；等价入口：web 控制台 \`POST /api/teams\`、终端 \`prism team new <id>\`） |
| 建角色 | \`prism_role_new { name, roles_dir, description?, skills?, knowledge? }\`（等价入口：web 控制台 \`POST /api/roles\`、终端 \`prism role new\`）；只给名字则写骨架 |
| 改团队 | \`prism_team_edit { team_id, teams_dir, name?/description?/members? }\`——改 members 时**工作流表就地按名册收窄** |
| 改角色 | \`prism_role_edit { name, roles_dir, description?/skills?/knowledge?/body? }\`——只改点名字段，正文不重排 |
| 删 | \`prism_team_rm\` / \`prism_role_rm\`（**删除进回收站**，可 \`prism trash restore <id>\` 还原；默认 3 天后彻底清除，自动清除需 serve 运行。CLI 删除默认宿主目录需 \`--yes\`） |
| 查在不在 | \`prism_role_list\`（角色库）/ \`prism_team_list\`（团队库）/ \`prism_team_get { team_id }\`（单个团队定义全文） |
| 校验 | \`prism team validate <id>\` / \`prism role validate\`（MCP 侧无独立校验工具，看 list/detail 的 \`issues\`） |
| 给技能分类 | \`prism_skill_categorize { names, category? }\`：写 Prism 侧分类映射（\`<PRISM_HOME>/skill-categories.json\`），**不校验技能是否存在、不碰宿主技能文件**；\`category\` 省略/空串 = **清除**；读回走 \`prism_skill_list\`（每条技能带 \`category\`）或 \`GET /api/skills\` |
| 增删改分类 | \`prism_skill_category_add { name }\` / \`prism_skill_category_rename { from, to }\` / \`prism_skill_category_rm { name }\`——分类清单本身（add 只登记分类名，空分类存得住；rename **级联**改映射；rm 后组内技能**回未分类**）。重名 → \`id_conflict\`、不存在 → \`not_found\`。等价入口：web 控制台 \`POST\\|PATCH\\|DELETE /api/skills/categories[/:name]\`、终端 \`prism skill category add\\|rename\\|rm\` |

> 增删改三动作在 CLI / HTTP / MCP **同名同位**（\`new|edit|rm\` ↔ \`prism_role_new|edit|rm\` ↔ \`POST|PATCH|DELETE /api/roles\`）。
> 写路径的目录参数（\`teams_dir\` / \`roles_dir\`）**必填**——一律显式参数化，防误写真实宿主目录。
> 取值来源单一：先 \`prism_role_list\` 拿 \`roles_dir\`、\`prism_team_list\` 拿 \`teams_dir\`（读写两侧键名同名，可直接回填）。
> \`<roles_dir>\`/\`<teams_dir>\` 由激活的适配器声明（如 WorkBuddy：\`~/.workbuddy/agents\`、\`~/.workbuddy/teams\`），
> \`prism.yaml\` 可覆盖；用 \`prism harness show\` 看当前适配器。
> **Skill 的装/卸三入口齐**：CLI \`prism skill install|uninstall|update\` ↔ MCP \`prism_skill_install|uninstall\` ↔ HTTP \`POST /api/skills/install|uninstall\`；写路径 \`skills_dir\` 必填（防误写真实宿主），先用 \`prism_skill_list\` 拿 \`skills_dir\` 回填。卸下去的产物**进回收站**（返回体带 \`trash_ids\`），可 \`prism trash restore <id>\` 还原。
> **技能分类三入口齐**（v8 F7）：CLI \`prism skill categorize <name...> [--category <分类>]\` ↔ MCP \`prism_skill_categorize { names, category? }\` ↔ HTTP \`POST /api/skills/categorize\`；全量表 \`GET /api/skills/categories\`。映射独立于技能台账——**Prism 不管该不该分类，只管存**。
> **分类清单增删改三入口齐**（v12 F4）：CLI \`prism skill category add|rename|rm\` ↔ MCP \`prism_skill_category_add|rename|rm\` ↔ HTTP \`POST|PATCH|DELETE /api/skills/categories[/:name]\`（**同名同位**）。存储迁为**双节** \`{ categories: string[], mapping }\`：\`categories\` 是分类名清单（**保序**，含空分类）、\`mapping\` 是技能→分类；任何写盘后 \`mapping\` 的值 ⊆ \`categories\`。重名 / 改名目标重名 → \`id_conflict\`（409），源分类不存在 → \`not_found\`（404），空名 → \`bad_request\`（400）。

## 沉淀规则（团队定义里）

团队定义含 \`deposit\`：默认层/类型/优先级/是否必带说明 + 匹配规则。
完成任务时按团队规则 \`prism_kb_deposit\`，**带来源（任务 ID + 角色）**。
`,
  },
  {
    path: 'references/enrich.md',
    content: `# 富化回写（prism_kb_enrich）

## 为什么有它

Prism **不调 LLM**（零 API key）。需要 LLM 的活（摘要/分类/实体抽取）由**你产出结果后回写**，
Prism 只做确定性落库（工作队列已移除，改为直付）：

| kind | 你产出 | Prism 落库效果 |
| :--- | :--- | :--- |
| \`summarize\` | \`{ summary }\` | 落 \`SUMMARY-<entry_id>\` 条目，正文 \`[[entry_id]]\` 建边 |
| \`classify\` | \`{ labels: [] }\` | 合并进原条目 tags（内容哈希去重，标签没变不产生新版次） |
| \`extract_entities\` | \`{ entities, relations }\` | 每个实体落 \`type: other\` 条目 + 关系双链建边 |
| \`diagram_ir\` | Archify IR | **不回写**（用 \`prism arch render\` 消费）；调用返回 skipped |

## 调用

\`\`\`
prism_kb_enrich { kind, payload, result, by? }
  payload: { entry_id, layer?, owner?, book?, module?, type? }   # 原条目上下文
  result:  你的 LLM 产出（结构见上表）
  by:      执行者标识（写入 deposited_by 留痕）
\`\`\`

## 边界

- Prism **不审核结果**——你说落就落；结构不符（缺 entry_id/summary 等）则跳过并说明；
- 回写失败会**抛出**（不静默），据错误修正后重试；
- 一次调用一种 kind，一对一（不做批处理）。
`,
  },
  {
    path: 'references/arch.md',
    content: `# 架构图谱（prism arch，CLI + MCP）

引擎：**Archify**（vendored 子工程，MIT）。IR 是源、HTML 是派生。

## 五类图 —— 全部由 Prism 自动派生（**你不需要产 IR**）

| type | 数据源 | 入口 | 说明 |
| :--- | :--- | :--- | :--- |
| \`workflow\` | 团队 DAG 工作流定义 | \`prism arch from-team <team_id>\` | 或 MCP \`prism_arch_generate {type:'workflow', team}\` |
| \`architecture\` | 已注册项目的代码图谱（社区聚类 + 依赖边） | \`prism arch from-graph architecture <project>\` | 需先 \`prism graph build <project>\` |
| \`sequence\` | 代码图谱的**跨文件 calls 边** | \`prism arch from-graph sequence <project>\` | 无跨文件 calls 边时**明确拒画** |
| \`lifecycle\` | Prism 任务状态机（14 态 **36 转移**） | \`prism arch from-state\` | 无入参，随时可跑 |
| \`dataflow\` | 代码图谱**目录角色分层 + 跨层依赖边** | \`prism arch from-graph dataflow <project>\` | 口径是「依赖流向」不是数据读写（见下） |

> **IR 是派生视图，不是你要写的东西**（红线 R7）。五类图的 IR **一律由 agents 包的纯函数算出**
> （零 IO / 零时钟 / 零随机，同输入必同字节）。**不要手搓 JSON，也不要回头让用户手写**——
> 你只需要选对入口、给出数据源名（team_id / project）。
>
> 打包前的老口径（「四类图由宿主按 \`arch schema\` 取契约生成」）**已废止**。

### 两条口径说明（都不是 bug，别当故障排查）

1. **\`dataflow\` 是「依赖流向视图」**：图谱关系里**没有 reads/writes 类边**，画不出真正的数据读写流。
   故按目录角色分层（入口/前端/后端/数据/脚本/测试）+ 依赖边跨层流动建图，口径写进 \`meta.subtitle\`。
   层次压缩后只保留命中层；**命中层 < 2 时明确拒画**。
2. **「有理由的拒画」是预期行为**：同目录扁平仓库（无处分层）、图谱无跨文件 calls 边（sequence 无话可说）、
   层数不足两级（dataflow）→ 报错并说明理由，**绝不产出坏图**。真实仓库上遇到拒画先看理由，
   别改口径硬画。

## 用法

\`\`\`bash
prism arch types                              # 列出五类

# 五类图各自的一键入口（推荐路径）
prism arch from-team core-dev                 # workflow：由团队定义派生
prism arch from-graph architecture mini-snake # architecture：由代码图谱派生
prism arch from-graph sequence mini-snake     # sequence
prism arch from-graph dataflow mini-snake     # dataflow
prism arch from-state                         # lifecycle：由任务状态机派生

# 通用选项
prism arch from-graph architecture mini-snake --out ./arch.html --top 12 --limit 30  # --out 完全接管落点
prism arch from-state --out ./lifecycle.html --title 任务生命周期
prism arch from-team core-dev --book order-platform --module order   # 归到书/模块
# 缺省落点：from-graph 三类项目图 → <projectRoot>/.prism/arch/<type>/；from-team/from-state → <PRISM_HOME>/archify/<type>/

# 契约核对 / 排障（降级用途，不是常规流程）
prism arch schema architecture                # 打印 IR 的 JSON Schema
prism arch schema common                      # 公共 $defs
prism arch validate architecture ir.json      # 校验 IR（schema + 布局）
prism arch render architecture ir.json        # 渲染一个现成 IR
\`\`\`

**MCP 等价（会话内首选这个，不用退出去敲 CLI）**：

\`\`\`
prism_arch_generate { type: 'workflow',     team: 'core-dev' }
prism_arch_generate { type: 'architecture', project: 'mini-snake' }
prism_arch_generate { type: 'sequence',     project: 'mini-snake' }
prism_arch_generate { type: 'dataflow',     project: 'mini-snake' }
prism_arch_generate { type: 'lifecycle' }
\`\`\`

返回 \`{ type, html, ir, bytes, title, subtitle, source, project? }\`（含标题与图注；拒画时直接报错并说明理由）。\`workflow\` 要 \`team\`，
\`architecture|sequence|dataflow\` 要 \`project\`（**必须已注册**），\`lifecycle\` 无入参。
可选 \`book\`/\`module\` 写进产物 sidecar（归到知识库的书/模块下）；可选 \`out\` 覆盖产物路径。

**产物落点（v9 F1）**：\`architecture|sequence|dataflow\` 三类**项目图**缺省落
\`<projectRoot>/.prism/arch/<type>/\`（project 必须已注册；root 被删/被挪会报
\`project_root_missing\`，Prism **不会**重建目录）；\`workflow|lifecycle\` 落
\`<PRISM_HOME>/archify/<type>/\`；给了 \`out\` 则完全接管落点。

**产物归属**：\`--book/--module\` 把产物归到知识库的书/模块下，渲染时同时写
\`<name>.meta.json\`（作用域 + archify 版本 + IR 哈希 + 标题）。界面在
「知识库 → 点开书 → 架构图」按作用域过滤显示，子标签 [预览 | IR | 元数据]。
不带 \`--book\` 的产物不属于任何书，只出现在全量列表（全局图集）里。

## 出图被拒时怎么读报错（生成器已内化这些约束）

渲染器有几条硬约束，**生成器已全部自动满足**——你不用管，但看到报错时能对上号：

- **节点文本不换行**：label / sublabel 超宽即判非法。生成器会自收敛文本（缩写、中文名 slug 化）。
  不要试图「加宽节点」硬塞——那会触发自动布线的横向错位与穿线。
- **连线侧向是方向契约**，不是位置；生成器自给 \`via\` 折点且据此跳过该校验。
- **\`edge-through-node\`**（连线穿无关节点）：无法靠命名通道避让，唯一解是自给 \`via\`——
  生成器内部用「Hanan 网格 + Dijkstra 折点优先」正交布线自动求解。
- **标签压节点**：标签默认落线段中点，生成器自挑 \`labelAt\` 规避。
- **最短段阈值**：architecture 24px / dataflow 34px / lifecycle 32px / workflow 28px。
- **同层节点净空** ≥10px（dataflow）。

## IR 要点（仅排障 / 手工渲染时需要）

- 必填 \`schema_version: 1\`、\`diagram_type\`、\`meta.title\`；
- \`architecture\` 组件类型枚举：\`frontend/backend/database/cloud/security/messagebus/external\`；
- 组件需显式 \`pos: [x,y]\` + \`size: [w,h]\`（或用 \`layout.mode: grid\` + \`cols\`）；
- 校验不通过**不会产出坏图**（\`archify_validation_failed\`）。
- **完整契约以 \`prism arch schema <type>\` 为准**——上面的枚举只是速记；schema 里还有
  \`meta.legend/views\`、\`quality_profile\` 等可选字段，别凭记忆写。

## HTTP 等价

\`POST /api/arch/from-team { team, out?, book?, module? }\` → 由团队派生工作流图；
\`POST /api/arch/render { type, ir, name?, project?, book?, module? }\` → 给 \`project\`（三类项目图）落
\`<projectRoot>/.prism/arch/<type>/<name>.html\`，否则落 \`<PRISM_HOME>/archify/<type>/<name>.html\`；
\`GET /api/arch/diagrams?book=&module=\` 按作用域列出产物（**双源**：项目源 + 全局源，条目带
\`source\`/\`project\`/\`preview\`/\`ir\`）；
\`GET /api/arch/ir/:type/:file\` 取 IR 源 + 元数据（可加 \`?project=\` 限定项目源）；
\`GET /api/arch/preview/:type/:file\` 可在控制台 iframe 预览（同上；同一 type+name 命中多源时必须带 \`?project=\`）。
`,
  },
  {
    path: 'references/cli.md',
    content: `# CLI 与运维

## 接入初始化

\`\`\`bash
prism init --yes                     # ①探测 ②建骨架 ③装 Skill ④写 MCP 注册 ⑤提示重启
prism doctor                        # 环境自检（Node/目录/DB/graphify/embedding/端口）
prism serve --ensure                # 后台幂等起控制台（只读控制面）
\`\`\`

**写守卫**：目标为默认宿主目录且未显式指定 → 拒绝（\`guard_required\`）；加 \`--yes\` 确认写入默认宿主配置（\`--harness-root\` 为测试/CI 专用）。

## 本地向量化（prism embedding）

向量化由 Prism 自理（内置模型、按算力分档，不调宿主 LLM）；未安装自动降级纯 BM25。

\`\`\`bash
prism embedding install                    # 首次装配：编译 llama.cpp + 按算力装模型（有显卡自动加 GPU/Vulkan 包）
prism embedding models                     # 三档一览（small/default/large）+ 当前生效
prism embedding use <small|default|large>  # 切换档位（写 prism.yaml；换后 reindex）
prism embedding status                     # 安装 / 后端(GPU|CPU) / 档位 / 维度
prism embedding reindex                    # 补齐或重算向量（幂等）
\`\`\`

**有显卡就用 GPU**：\`status\` 显示 CPU 时跑 \`prism embedding install --gpu\`（Vulkan 包约 28MB）。
无显卡自动用 \`small\` 档（512 维，CPU 友好）。

## 运行时宿主适配器（prism harness）

Prism 支持多 harness（内置 + **运行期插件**），**运行期只激活一个**：

优先级：\`PRISM_HARNESS\` 环境变量 > \`<PRISM_HOME>/prism.yaml\` 的 \`harness\` 键 > 默认 \`zcode\`。
第三方扩展 harness **不必改 Prism 代码**——把适配包放进 \`<PRISM_HOME>/harnesses/\` 即自动注册。

\`\`\`bash
prism harness list     # 内置 + 插件适配器 + 当前激活项 + 来源
prism harness show     # 当前适配器约定（角色目录/团队目录/Skill 目录/派发机制/模型声明）
\`\`\`

## 配置（<PRISM_HOME>/prism.yaml）

\`\`\`yaml
harness: zcode                 # 激活哪个适配器（缺省 zcode）
# 以下可选覆盖；不写则用激活适配器自述的目录
roles_dir: ~/.zcode/agents
teams_dir: ~/.zcode/teams     # roles_dir 同级——不在 agents/ 内（避免被宿主当 agent 扫到）
skills_dir: ~/.zcode/skills
\`\`\`

\`PRISM_HOME\` 默认 \`~/.prism\`，可用环境变量覆盖。

## 服务与控制台

\`\`\`bash
prism serve              # 前台起（Ctrl+C 停）
prism serve --ensure     # 后台幂等起（已在跑则复用）——宿主启动与登录自启走的就是这条
prism serve --check      # 查状态（退出码 0=在跑 / 1=没跑）
prism serve --stop       # 停掉后台那份
\`\`\`

> \`--ensure\` 是**幂等**的：多处并发调用（宿主 + 登录自启 + 手工）只有第一次真起服务，其余复用。
> 端口被**非 Prism** 程序占用时会明确拒绝，不会把别人的服务当成自己的。
> 日志 \`<PRISM_HOME>/state/serve-<port>.log\`；状态记录 \`<PRISM_HOME>/state/serve-<port>.json\`。
> 关掉宿主自动拉起：\`PRISM_SERVE_AUTOSTART=0\`。

控制台页面：知识库 / 代码图谱 / 角色 / 团队 / 技能 / 项目台账。
（知识图谱与架构图谱**没有一级页**——它们归入「知识库 → 点开一本书 → 详情面板」。）

## 打包与部署

\`\`\`bash
pnpm run package      # → dist/prism-<version>_<platform>.tgz（按平台分，含三方运行时 + 最小向量模型）
pnpm run deploy       # 装到 <PRISM_HOME>/runtime/ + 校正宿主 MCP 注册 + 装登录自启
pnpm run release      # 发 GitHub Release（复用本机 git 凭据，无需手工造 PAT）
\`\`\`

> **deploy 的落点是恒定路径**（\`<PRISM_HOME>/runtime/\`，不含版本号）——专门用来根治
> 「升级或清理之后 MCP 注册变成死路径、宿主拉不起来」。升级流程固定为
> \`pnpm run package && pnpm run deploy\`，**注册不需要动**。
`,
  },
]

/** prism 元 skill：教宿主如何使用 Prism（随 `prism init` / `prism skill install` 安装）。 */
export const prismSkill: PrismSkill = {
  name: 'prism',
  description:
    '使用 Prism 平台能力时触发：检索/沉淀知识（kb）、查询知识图谱与代码图谱（graph）、渲染架构图（arch）、启用团队与派发角色（team/role）、领取 LLM 待办（work）。或用户提到 prism、PRISM_HOME、知识库、落库、代码图谱、影响面、架构图、启用团队时使用。注意：纯代码结构问答优先 graphify；本 Skill 负责 Prism 服务接入与资产消费。',
  content: PRISM_SKILL_CONTENT,
  assets: PRISM_SKILL_ASSETS,
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
