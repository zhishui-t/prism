# 3rd —— 第三方子工程（vendored）

本目录收录 Prism 依赖的外部工具，**以子工程形式引入**（源码进仓库，产物本地构建）。

| 目录 | 上游 | 版本 | 许可证 | 形态 | 调用方式 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `archify/` | [tt-a1i/archify](https://github.com/tt-a1i/archify) | **v2.16.0** | MIT | 自包含 CLI（零运行时依赖） | `node 3rd/archify/bin/archify.mjs <cmd>` |
| `graphify/` | [rhanka/graphify](https://github.com/rhanka/graphify) | **v0.17.1** | MIT | TS 源码（需构建） | `node 3rd/graphify/dist/cli.js <cmd>` |

## 为什么 vendored 而不是依赖 npm

- **archify**：上游 `private: true`，**未发布 npm**（npm 上的 `archify` 属另一个无关包）。
- **graphify**：npm 有 `@sentropic/graphify@0.17.1`，但 Prism 需要**锁定版本 + 可审计源码**；同时其可选 peer 依赖（`@sentropic/agent-stats-core@^0.3.0` 等 11 个）在 pnpm 严格解析下会失败，需独立安装。

## archify（v2.16.0）

自包含，**无需构建**。已裁剪非运行必需目录（`test/`、`recipes/`、`references/`、`brand-marks/`），保留：

```
3rd/archify/
├── bin/archify.mjs          # CLI 入口
├── renderers/               # 五类图渲染器
├── schemas/                 # JSON-IR schema（校验器）
├── assets/template.html     # 输出模板
├── delta/                   # Before/Delta/After 对比
├── migrations/              # schema 迁移
├── scripts/check-render-output.mjs
├── examples/*.json          # 官方示例（仅 JSON，HTML 产物已剔除）
└── LICENSE / package.json
```

验证：

```bash
node 3rd/archify/bin/archify.mjs --help
node 3rd/archify/bin/archify.mjs demo /tmp/archify-demo
```

## graphify（v0.17.1）

**需要构建**（产物 `dist/` 不入库，见根 `.gitignore`）。首次使用或升级后执行：

```bash
pnpm run 3rd:build          # 等价于 cd 3rd/graphify && npm install && npm run build
```

已裁剪 `docs/`（11M）、`tests/`、`spec/`（构建非必需）。保留源码与构建配置：

```
3rd/graphify/
├── src/                     # TS 源码
├── packages/graph/          # 内部包 @sentropic/graph
├── studio/                  # Studio SPA 源码
├── scripts/                 # 构建脚本
├── tsup.config.ts           # 构建配置
└── package.json             # version 0.17.1
```

**注意**：graphify 用 **npm**（非 pnpm）安装——其 11 个可选 peer 依赖中 `@sentropic/agent-stats-core@^0.3.0` 在 npm 上不存在（最新 0.2.0），pnpm 严格模式会直接报错，npm 则按 optional 跳过。这是上游的依赖声明问题，不是 Prism 引入的。

## 升级流程

1. 取上游新 tag：`git clone --depth 1 --branch <tag> <repo>`；
2. 同步本目录（保持上述裁剪范围）；
3. 更新本文档表格中的版本号；
4. archify 直接验证 CLI；graphify 执行 `pnpm run 3rd:build` 后验证 `node 3rd/graphify/dist/cli.js --version`；
5. 跑 `pnpm test`（Prism 侧封装有集成测试）。

## 许可证

两个上游均为 **MIT**。各目录下保留其 `LICENSE` 原文与版权声明；再分发时须一并保留。
