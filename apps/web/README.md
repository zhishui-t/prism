# @prism/web · 控制台

Prism 的 React 控制台（Vite + React 18 + TypeScript，零 UI 库）。六个一级页：
知识库 / 代码图谱 / 项目台账 / 角色 / 团队 / 技能。

## 运行与构建

```bash
pnpm --filter @prism/web dev        # 开发服务器（/api 与 /studio 代理到 127.0.0.1:7777）
pnpm --filter @prism/web typecheck  # 类型
pnpm exec vitest run apps/web/test  # 单测（在仓库根执行）
pnpm --filter @prism/web build      # 产 dist/（含裸 CJK / 死键两道守卫）
```

开发前先起 Prism server（`prism serve`，默认 7777）；控制台本身不带后端。

## 布局契约（v19）

```
.layout (flex, 100vh)
├── .sidebar (248px；≤1180px 收成 72px 图标栏)
│   ├── .brand
│   ├── .side-nav → .nav-block → .nav-item（<a href="#/page">）
│   └── .sidebar-foot（连接状态 / 主题 / 语言）
└── .workspace (flex column)
    ├── .topbar（面包屑 Prism / 页面 / 深链实体）
    └── .main (overflow: hidden)
        └── .page (唯一滚动容器)
            └── .page-inner (max-width 1440，居中)
```

满高页面（知识库 / 技能 / 团队 / 代码图谱）用 `.page-fill` 吃剩余高度；
**滚动发生在页面内部**（`.book-sidebar` / `.book-content` / `.md-list` / `.page`），
不要写 `100vh - 顶栏 - 内边距` 这类人工减法。

## 设计系统

全部 token 在 `src/styles.css` 顶部，两个主题各覆盖同一组：

| 组 | 取值入口 |
| :--- | :--- |
| 表面 | `--paper` / `--sheet` / `--sheet-2` / `--sheet-raised` |
| 文字 | `--ink` / `--mute` |
| 线 | `--rule` / `--rule-strong` |
| 主色 | `--buckram` / `--buckram-weak` / `--on-buckram` |
| 状态 | `--ok` / `--warn` / `--err` / `--madder` / `--lamp` |
| 字号 | `--fs-100` … `--fs-700` / `--fs-read` / `--fs-h1`…`--fs-h4` |
| 间距 | `--s-1` … `--s-7` |
| 圆角 | `--r-1` / `--r-2` / `--r-3` |
| 阴影 | `--shadow-1` / `--shadow-2` / `--shadow-3` |

约定：

- 页面与组件**只消费 token**，不就地写 hex / rgb；数据域颜色（角色 / 条目类型 / 架构类型）走
  `--role-*` / `--type-*` / `--arch-*`，两个主题各有一份。
- 图标一律走 `components/Icon.tsx`（内联 SVG，零依赖）；不引图标库、不用 emoji 当控件。
- 文案一律走 `i18n.ts`（中英双表）；`pnpm --filter @prism/web build` 会跑裸 CJK 与死键守卫。
- 动效只动 `transform` / `opacity` / 颜色；`prefers-reduced-motion` 在文件末尾一刀切归零。
- 样式契约测试（`apps/web/test/styles-*.test.ts`）直接读 `styles.css` 文本，
  改选择器 / 关键声明时同步更新它们；不要用 `getComputedStyle`（happy-dom 不解析外部样式表）。

## 页面结构速查

| 页面 | 关键容器 |
| :--- | :--- |
| 知识库 | `.book-layout` → `.book-sidebar`（目录 / 检索）+ `.book-content`（书页 / 正文） |
| 代码图谱 | `.graph-page` → 项目选择 + `.graph-query-card` + `.graph-main`（查询 / 层级探索） |
| 项目台账 | `.pane` + `.table-scroll` + `.cmd-row` |
| 角色 | `.role-toolbar` + `.role-grid` → `.role-card`；详情 `<Modal size="lg">` |
| 团队 | `.team-toolbar` + `.team-grid` → `.team-row`；详情 `<Modal size="lg">`；表单 `<Drawer>` |
| 技能 | `.scope-head` 统计条 + `.skill-list-head` + `.skill-grid.dense`（名 / 引用 / 来源） |

## 交互约定（v19）

- **`/`**：聚焦当前页第一个搜索 / 过滤框（`SearchField` 的 `data-search-input`）；
  输入框内、浮层打开时不抢键。
- **`Esc`**：在搜索框内清空并退出由输入驱动的模式（如知识库全文检索）；浮层内仍由浮层栈处理。
- 搜索框有值时显示清空按钮；空值时显示 `/` 提示。
- 顶栏右上角「复制链接」复制当前深链（`#/page/sel`），复制后就地回执。
- 技能列表列头随滚动吸顶；技能页提供显式「刷新」。
- 团队创建成功后就地给「查看详情」出口（关抽屉 + 落选中）。
- 角色 / 团队表单有未保存修改时，**X / Esc / 点遮罩**先确认；表单内的「取消」是显式放弃，
  不再二次确认。保存成功后当前值成为新初值，不再误报「有未保存修改」。

## 代码边界 / 性能约定

- **HTTP 信封只有一个实现**：`src/http.ts`。`api.ts` 与 `api-team.ts` 都从这里导入
  `request`，不再各抄一份；同一路径的**并发 GET 共用在途 Promise**，写请求（POST/PATCH/PUT/DELETE）
  不合并；GET 结束后不保留 TTL 缓存（避免看到过期数据）。
- **复制反馈只有一个实现**：`src/components/useClipboard.ts`（CopyButton / CopyCommand / 顶栏复制链接共用）。
- 列表派生数据用 `useMemo` 收口（见 `Skills.tsx` 的 `counts / shown / groups`）：
  拖拽、折叠、弹窗开关等状态变化不应重算全表过滤与分组。
- 大页面仍按「页面自己持有数据 + 纯函数逻辑下沉到 `*-logic.ts`」组织；
  跨页共享的只有 `components/*` 与 `http.ts`，不新增全局 store。

## 测试约定

- DOM 测试用 happy-dom + 裸 `react-dom/client`；页面组件可单独渲染，不必起 server。
- 样式契约测试用 node 环境读 `styles.css` 文本（`styles-motion-tokens` / `styles-scroll-containers` 等）。
- 应用骨架的导航分组 / 当前页高亮 / 面包屑由 `test/shell-nav.test.ts` 锁定。
