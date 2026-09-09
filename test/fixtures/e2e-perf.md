---
id: E2E-PERF-001
title: E2E 性能守则
type: rule
layer: global
book: e2e-handbook
module: perf
tags:
  - 性能
  - e2e
---

# E2E 性能守则

遇到性能问题先量化，再做优化，避免过早优化。数据库查询禁止放在循环内。

补充：接口 P95 延迟超过 500ms 必须告警。
