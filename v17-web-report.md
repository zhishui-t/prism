# v17-web-report（dev A ｜ B-C8 + W-8 + W-9）

workbuddy_session_id: wbdy-a804ee78-c87

## 结论

B-C8（path 服务端 chain + from-graph symbols）与 W-8/W-9①（前端消费）交付，定向门禁全绿。**两处任务书前提订正**：① B-7 服务端（rollup cursor/409）**已由并行实例落盘**（我侦察时点未落，派发 W-9 时已在其工作区）；② W-9②（rollup 前端分页）**同样已在磁盘**（explore-logic mergeRollupPage / GraphExplore more() 409 分支 / i18n 翻页口径 / 双测试文件）——本会话按「同文件并行不互踩」纪律对 W-9② 只做核销验证，未改其文件。

## B-C8 服务端（上一棒 job-ad083691447f 交付）

- `graphify.ts`：删 graphPath 子进程封装（三面重指后零消费方），新增 `graphPathChain(root,from,to)`——直读 graph.json（mtime+size 失效键进程内缓存，rollup 先例）+ BFS 自求路径；起点/终点按图内首个唯一匹配落（实测多义时 1 跳解胜 3 跳解）；hop file:line 取发出该跳的边（实测 calls 边字段 `source_file/source_location`，两份真图 1964 calls 边 0 缺失）；多义跳双空 + `ambiguous:true`；**链尾跳无发出边 → 双空**（与 graphify CLI 语义一致）。
- 响应增 `chain: [{id,label,file,line,ambiguous?}]`，既有键集不变（测试钉 `['chain','found','hops','project','raw']`）；缓存 mtime+size 变化重读有断言。
- from-graph（arch.ts）：additive `symbols?: string[]`；node/symbols 互斥 400；IR 按 chain 相邻对构（6 跳=6 消息防链外边——测试断言 `s0→s3` 不进图；7 参与者）；不传 symbols = legacy 逐字节不变（纯函数同输入同字节）。MCP schema/描述、CLI `--symbols`、内置 Skill 速查、README、code-graph.md、cli-mcp-surface.md 逐面同步。
- 失准数字订正：设计稿「159+/164 重名」是 label/norm_label 混用——实测 2340 节点、2063 唯一 label、**159 个 label 值跨文件重复、164 个 norm_label 多义**，四处口径已改。

## W-8 + W-9①（本轮 job-61669829bde8 交付，9 文件全在 apps/web/）

- **W-8**：CallChainGraph 每跳边渲染 `file:line`（几何纯函数 chainEdgeMidY/chainLabelBoxes，viewBox 随标注加宽防裁切）；`ambiguous` 跳 `.chain-node.ambiguous`（opacity 0.5，复用 disabled 惯例）+ `<title>` 自陈；空 file/line 不画标注。
- **W-9①**：导出寻址载荷扩两形态（`sequenceTarget`：relations→`{node}` / path→`{symbols: chain.map(id)}` / 未找到→undefined）；path 模式导出按钮 enabled（POST body 带 symbols）；`archRenderFromGraph` 入参联合 `{project,node}|{project,symbols}`；i18n 新增 `graph.viz.ambiguous`、`graph.seq.noteChain` 并重写失准的 `graph.seq.noId`（中英双表）。
- **W-9②（核销，非我所改）**：409 回首页状态机已在 GraphExplore `more()`（seq token 并发守卫；stale→丢累计回首页，不当错误摆界面）；`mergeRollupPage` 为直接拼接不查重（依据：服务端整层排序切片不重不漏，设计 B-7 未要求客户端去重）。

## SPEC 断言落点（全绿）

- C8.1：graph-path-chain.test.ts（6 跳→chain 7 节点逐跳 file:line、多义端点 ambiguous、首个唯一匹配、缓存失效、键集）+ 前端 graph-call-chain-dom:472/499/508（标注渲染/空不画/灰显）。
- C9.1：arch-render-from-graph（symbols 6 跳→7 参与者+6 消息、互斥 400、legacy 逐字节不变）+ cli/arch-from-graph(8) + 前端 graph-logic:340-384（寻址载荷逐分支）+ call-chain-dom:708（按钮启用+POST symbols）。
- C9.2：按钮 enabled ✅；「跳过+标注」**部分闭环**——服务端已计略去条数，但 HTTP 响应/sidecar meta 均无 subtitle，前端暂给静态口径 noteChain（TODO 已标，缺口见下）。
- B7.3：「更多」真分页 + 总数 + i18n 翻页口径——已落盘（explore-logic 22 + graph-explore-dom 27 条断言，含 409 回首页 DOM 级覆盖 :694）。

## 门禁（终态，dev 独立复核 web 全量 + typecheck）

`pnpm typecheck` exit 0；`pnpm exec vitest run apps/web/test` **65 文件/1060 条 exit 0**（独立复核一致）；`pnpm lint` exit 0；`pnpm exec vitest run packages/server/test packages/cli/test` 82 文件/924 条 exit 0（arch-routes/arch-from-graph 负载下单跑恒绿，已知子进程争用 flaky 非回归）；server graph-rollup 25 条 exit 0。`pnpm build`/`test:e2e` 未跑（不在本波定向门禁，波次 3 收口）。

## 遗留（供队长裁决）

1. **C9.2 缺口**：from-graph symbols 分支响应无 `subtitle`（HTTP 响应与 sidecar meta 都没有）——需服务端 additive 增 `subtitle?: string`（值取 ir.meta.subtitle），前端把静态口径换真计数。
2. **dedupe 裁决**：`mergeRollupPage` 拼接不查重 vs 任务书聊天口径「去重合并」——落盘实现符合设计文档（服务端保证不重不漏），维持或加防御由队长定，谁持有 explore-logic.ts 谁统一改。
3. server 全量套在负载下 archify 子进程争用有超时史（单跑恒绿）；波次 3 全量阶梯收口时留意。
4. W-8 边界（chain 空或超限时无标注）靠 drawable 分支自然成立，无显式断言——低风险可补。
