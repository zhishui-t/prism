# 测试

Prism 的验证分三层：**单测**（vitest，随包存放）· **端到端**（本目录）· **打包冒烟**。

## 单测

```bash
pnpm test          # 382 例，随各包 test/ 目录
pnpm test:watch    # 监听模式
```

单测遵循「**绝不写真实宿主目录**」红线：全部用临时目录 + 注入（`PRISM_HOME` / `ZCODE_DIR` / 依赖注入）。

## 端到端（`pnpm test:e2e`）

```bash
pnpm build         # 前置：消费各包 dist 产物
pnpm test:e2e      # 全链路：CLI → 服务 → HTTP API → 控制台
```

`run-e2e.mjs` 在**单个临时目录**内串起 9 组共 25 项断言：

| 组 | 覆盖 |
| :--- | :--- |
| 1 | `prism init`：装 Skill、写 MCP 注册、出厂团队落受控目录 |
| 2 | 知识库：import（frontmatter 生效）→ 两字中文词检索 → 知识图谱双链建边 |
| 3 | 角色：import → list |
| 4 | 工作队列：enqueue → claim（签发 token）→ complete（校验通过） |
| 5 | 任务台账：register DAG → report（合法/非法转移） |
| 6 | harness：默认激活、env 覆盖、未知 harness 报错 |
| 7 | 架构图谱：`arch render` 产出自包含 HTML |
| 8 | 服务：health/kb/graph/tasks/work/arch 六类 API + 控制台页面 + SPA 回退 |
| 9 | **真实 `~/.zcode/agents` 运行前后清单比对**（零污染硬断言） |

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
