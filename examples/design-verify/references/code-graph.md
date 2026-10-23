# 代码图谱优先 — 符号解析的第一选择

> 第 1 步的前置层。**能用代码图谱就不用 grep**：图谱是 AST 索引，知道「这是函数/类/文件」以及谁调谁；grep 只知道「这串字符出现过」。但图谱会陈旧、会漏动态调用，所以**有图谱先用、没图谱降级 grep、陈旧图谱不信任**——三段式，缺一不可。

## 1. 判定顺序（每次开工先跑一次）

```bash
prism graph status <项目名>        # 或 MCP: prism_graph_status
```

| 返回 | 动作 |
| :-- | :-- |
| 图谱不存在 / 项目未注册 | **降级**：直接走文件锚点 + grep（本 skill 的 `check-anchors.mjs`）。在 verdict 里记 `graph: unavailable` |
| 图谱存在且「陈旧: 否」 | **走图谱**：用它解析方案里的符号，再把解析结果写成文件锚点 |
| 图谱存在但「陈旧: 是」 | **不信任**：要么请用户/自己显式重建（`prism graph build <目录> --name <项目名>`），要么**降级 grep** 并在 verdict 记 `graph: stale(<变更数>/<总数>)` |

> 实测提醒：本仓自身就是例子——`prism graph status prism` 返回「陈旧: 是（变更 149/269 个文件）」。此时 `graph explain graphExplainCmd` 报 `L268`，而文件里实际在 **`L274`（偏移 6 行）**；同样一次运行里 `runGraph` 的 `L29` 却恰好正确。**陈旧图谱的偏移是逐文件不规则的**：有的准、有的偏几行，所以无法用「整体 +N 行」校正，只能逐条复核——它比没有图谱更危险，因为它看起来权威。

## 2. 图谱能做什么（比 grep 强在哪）

| 能力 | 命令 / MCP | 用途 |
| :-- | :-- | :-- |
| 符号是否存在 + 位置 | `prism graph explain <符号> --project <名>` / `prism_graph_explain` | 直接判定「文档引用的函数真的存在吗」，并给出 `file Lnn`；**不匹配注释/字符串/死代码** |
| 谁调用谁 | 同上（Connections 里 `--> calls` / `<-- calls`） | 语义层复核：断言「A 调用 B」时看边是否存在 |
| 两节点路径 | `prism graph path <A> <B> --project <名>` / `prism_graph_path` | 验证「下单→发消息」这类数据流断言是否有真实调用链 |
| 变更影响面 | `prism graph affected <节点> --depth N` / `prism_graph_affected` | 第 2 步判定核心链路、第 3 步红队评估横切风险 |
| 枢纽节点 | `prism graph god-nodes` / `prism_graph_god_nodes` | 找高风险集中区，优先抽样反证 |

**机械加速**：一次解析一批符号（找不到的即幻觉候选）：

```bash
node <skill目录>/scripts/resolve-symbols.mjs "OrderService,placeOrder,inventory-deduct" --project <名>
# 或用 PRISM_CLI 指定非 PATH 的 CLI：
PRISM_CLI="node K:/work/project/prism/packages/cli/dist/index.js" node .../resolve-symbols.mjs ...
# 图谱陈旧但仍想参考（结果必须人工复核）：
... --allow-stale
```

退出码：`0` 全部命中 / `1` 有 NOT-FOUND（幻觉候选）/ `2` 用法错误 / `3` 图谱不可用或陈旧（**调用方应降级 grep**）。

## 3. 图谱不能做什么（必须回到文件锚点）

- **给不出逐字引文**：图谱只给 `file Lnn`，`quote:` 仍需打开文件取原文——所以图谱解析后**仍要写文件锚点**，图谱是「找位置」不是「替代锚点」
- **非代码制品**：配置键、YAML/JSON、SQL、消息主题、部署清单——这些不在 AST 图谱里，只能 grep
- **动态调用**：反射、字符串路由、依赖注入容器、事件总线订阅（字符串 topic）——静态图谱看不见，grep 反而是唯一手段
- **同名歧义**：`explain` 对同名符号只返回首个匹配，通用名（`handler`、`init`）必须人工确认唯一性
- **陈旧图谱**：见上，行号会偏移

## 4. 与锚点账本的衔接（标准动作）

```
图谱解析符号 → 得到 file + line
        ↓
打开该文件，取该行逐字子串作为 quote
        ↓
写成 anchors.md 的文件锚点（file / line / quote）
        ↓
check-anchors.mjs 机械核查（此时它同时充当「图谱结论的独立复核」）
```

这样图谱负责**语义定位**，脚本负责**逐字确证**，两者互为交叉验证——图谱说「在 L29」，脚本说「L29 这行确实是这句代码」，任一方错都会被另一方抓到。这也是为什么**图谱命中后仍要跑锚点核查**，不能省。

## 5. 降级与记录（写进 verdict / gate）

第 1 步产出里必须有一行来源声明，供第 4 步门禁核对：

```markdown
- 符号解析来源: graph（prism，built_at 2026-10-15，stale=否）
- 符号解析来源: graph-stale（149/269 变更，已降级复核）
- 符号解析来源: grep（图谱不可用：项目未建图）
```

降级不是缺陷，**隐瞒降级才是**——`grep` 来源意味着同名歧义与注释误命中风险未消化，第 1 步的语义层复核要相应加强。
