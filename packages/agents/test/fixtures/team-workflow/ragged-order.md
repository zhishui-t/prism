---
team_id: ragged-team
name: 行级降级团队
description: 列数不齐 / 「#」非整数 / 实例记号非法——全部降级不抛（R-v11-5）。
members:
  - role: dev-1
    count: 1
---

# 行级降级团队

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | dev-1 | 串行 | 任务书 | recon.md | 结论落盘 | — |
| x | 设计 | dev-1 | 串行 | recon.md | design.md | 需求全覆盖 |
| | 开发 | dev-1 | 串行 | design.md | patch | 自验通过 | — |
| 4 | 测试 | dev-1/0 | 串行 | patch | test-report.md | 全项有运行证据 | 缺陷 → dev |
