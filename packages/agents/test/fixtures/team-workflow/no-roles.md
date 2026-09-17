---
team_id: no-roles-team
name: 无角色列团队
description: 工作流表没有「负责角色」列——收窄必须整体跳过。
members:
  - role: dev-1
    count: 1
  - role: tester
    count: 1
---

# 无角色列团队

## 工作流

| # | 阶段 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | 串行 | 任务书 | recon.md | 结论落盘 | 缺资料 → 补调研 |
| 2 | 开发 | 并行 | recon.md | patch | 自验通过 | 卡死 → 队长 |
| 3 | 交付 | 串行 | 全部 | DELIVERY.md | 用户验收 | — |

## 备注

这里说明为什么没有角色列。
