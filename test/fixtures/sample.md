---
id: PERF-001
title: 循环内禁止数据库查询
type: rule
layer: global
book: perf-standards
module: db-access
tags: [性能, 数据库]
---

# 循环内禁止数据库查询

在循环中执行数据库查询会导致 N+1 问题，严重影响性能。

## 规则
- 禁止在 for/while 循环内直接调用数据库查询
- 批量查询应使用 IN 或 JOIN 一次取回
