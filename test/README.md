# 测试

Prism 的验证分三层：**单测**（vitest，随包存放）· **端到端**（本目录）· **打包冒烟**。

## 单测

```bash
pnpm test          # 全量单测（各包 test/ 目录；当前 800+ 例，以实际输出为准）
pnpm test:watch    # 监听模式
```

单测遵循「**绝不写真实宿主目录**」红线：全部用临时目录 + 注入（`PRISM_HOME` / `ZCODE_DIR` / 依赖注入）。

## 端到端（`pnpm test:e2e`）

```bash
pnpm build         # 前置：消费各包 dist 产物
pnpm test:e2e      # 全链路：CLI → 服务 → HTTP API → 控制台
```

`run-e2e.mjs` 在**单个临时目录**内串起 21 组共 158 项断言：

| 组 | 覆盖 |
| :--- | :--- |
| 1 | `prism init`：装 Skill、写 MCP 注册（**不代建团队**：建不建团队由使用者决定） |
| 2 | 知识库：import（frontmatter 生效）→ 两字中文词检索 → 知识图谱双链建边 |
| 3 | 角色：手写进 roles_dir → list；团队：使用者自建（`team new --template core-dev`）→ validate → activate |
| 4 | 富化直付：`kb enrich` 直接回写（工作队列已移除） |
| 5 | 任务台账：register DAG → report（合法/非法转移） |
| 6 | harness：默认激活、env 覆盖、未知 harness 报错 |
| 7 | 架构图谱：`arch render` 产出自包含 HTML |
| 8 | 服务：health/kb/graph/tasks/arch 等 API + 控制台页面 + SPA 回退 |
| 10–13 | 项目知识导入链路、治理能力、冲突检测闭环、扫描历史 |
| 14 | 角色/团队/技能：技能使用视图 + `skill` 子命令 |
| 15–16 | 上下文包（模式 B）、AGENTS.md 注入块（模式 C） |
| 17 | 本地向量混合检索（装了 BGE-M3 才跑，否则 SKIP） |
| 18 | harness 插件：放目录即注册（零代码侵入） |
| 19 | design-v4 §6 验收补充（F-A1/A2/A4/B4/C1/C3/D2/E2/E3）——含 v6 增删改：`team new/edit/rm`、`role new/edit/rm` |
| 20 | design-v5 §2 验收补充（F-C2 合并入口 / F-C3 团队激活图谱状态 / F-C4 团队工作流图） |
| 9 / 10.1 | **真实 `~/.zcode/agents` 运行前后清单比对**（零污染硬断言）+ 临时目录无新增残留 |

`--keep` 保留临时目录用于排查。

### 前置条件

- `pnpm build` 已跑过；
- **架构图谱**需要 vendored archify（自包含，无需额外安装）；
- **代码图谱**需要本机 Python ≥3.10 + `pnpm run 3rd:build`（e2e 不强制，未安装时跳过该组）。

## 测试资产（`fixtures/`）

| 文件 | 用途 |
| :--- | :--- |
| `smoke-knowledge.mjs` | knowledge 包 dist 独立冒烟（不经单测）：版次递增、两字词命中、历史版可取、统计一致 |
| `e2e-perf.md` | 带 frontmatter 的导入样例（验证 id/book/module/tags 生效） |
| `notes-perf.md` | 无 frontmatter 的导入样例（验证回落行为） |
| `sample.md` | 最简导入样例 |

## 打包冒烟

```bash
pnpm run package   # → dist/prism-<version>.tgz
```

解压后 `node bin/prism.js --version` 应输出版本号（验证 workspace 依赖已物化、无符号链接残留）。
