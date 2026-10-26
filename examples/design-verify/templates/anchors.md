# 锚点账本（anchors）

> 第 1 步的机器可查输入。从设计文档挑出**承重断言**（标准见 `../references/evidence-anchors.md`），
> 逐条登记；`scripts/check-anchors.mjs` 按本格式核查：
>
> ```
> node <skill目录>/scripts/check-anchors.mjs .design-verify/anchors.md > .design-verify/verdict.md
> ```
>
> 格式约定：`##` **只留给锚点 id**（单 token，如 A1；小节说明用 `###` 或正文）。
> `quote` 必须单行内逐字子串；`grep` 为字面子串（非正则）；`count` 为出现次数（非行数）；
> `count: 0` = 断言「已不存在」。路径相对 `--root`（缺省当前目录）。
> 工件链：上游 ← 设计文档承重断言（图优先：resolve-symbols.mjs）｜下游 → verdict.md（脚本核查）→ semantic-review.md（独立实例复核）。
> 下方条目是格式示例，**路径指向本仓不存在的示例文件**，直接跑只会得到 MISSING-FILE / FABRICATED 一类裁决——
> 这不是脚本故障，是示例锚点的预期结果。使用时请整体替换为真实锚点（裁决随 cwd 与仓库内容变化，不要拿示例结果当基准）。

### 文件锚点（断言「某处存在某物 / 某行为」）

## A1
claim: 订单创建后同步发送库存扣减消息
file: src/main/java/com/order/OrderService.java
line: 87
quote: kafkaTemplate.send("inventory-deduct",

## A2
claim: 新结算开关默认关闭
file: packages/server/src/config.ts
quote: settlementV2 = false

### grep 锚点（断言「某标识符共出现 N 处」；count: 0 = 断言「已不存在」）

## A3
claim: inventory-deduct 主题仅在订单发送与消费端订阅两处出现
grep: inventory-deduct
path: src/main
count: 2

## A4
claim: 旧版结算入口已全部移除
grep: settleLegacy
path: packages
count: 0
