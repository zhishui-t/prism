import { useEffect, useMemo, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  teamApi,
  type SkillDetail,
  type SkillUninstallOutcome,
  type SkillUsage,
} from '../api-team.ts'
import { ConfirmModal } from '../components/ConfirmModal.tsx'
import { CountLine } from '../components/CountLine.tsx'
import { EffectiveSkills } from '../components/EffectiveSkills.tsx'
import { MarkdownBlocks } from '../components/Markdown.tsx'
import { NavRow } from '../components/NavRow.tsx'
import { ScopeLayerRows } from '../components/SkillScopeList.tsx'
import { State } from '../components/State.tsx'
import { CopyCommand, Modal, PageHead, Pane, StatusTag, firstSentence } from '../components/ui.tsx'
import { useAsync } from '../components/useAsync.ts'
import { parseMarkdown } from '../markdown.ts'
import { hrefOf, navigate } from '../route.ts'
import { useT } from '../i18n.ts'
import {
  categoryColor,
  categoryErrorKey,
  categorizePayload,
  COLLAPSED_STORAGE_KEY,
  dropCategorizeCall,
  groupSkills,
  GROUP_ORDER_STORAGE_KEY,
  mergeSkillCatalog,
  moveGroup,
  normalizeCollapsed,
  normalizeGroupOrder,
  renameCollapsed,
  UNCATEGORIZED,
  cleanSkillDescription,
  externalDeleteErrorKey,
  type SkillCatalogRow,
  type SkillDragPayload,
} from './skills-logic.ts'

/**
 * 组序的本地读写（v12 F4 / W-6，SPEC-4.10）：口径与 `theme.ts` 的 `readStored` / `setTheme`
 * 同款——**存不下就只在本次会话生效**（隐私模式 / 禁用存储不打断交互），读到的非字符串数组
 * 一律当空（不外抛）。
 *
 * 放组件文件（而不是 `skills-logic.ts`）的理由：那一边是**纯函数层**（node 直测、不碰
 * `window`）；本地键与归一化判据在那边，I/O 只在这里。
 */
function readGroupOrder(): string[] {
  try {
    const raw = window.localStorage.getItem(GROUP_ORDER_STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

function writeGroupOrder(order: readonly string[]): void {
  try {
    window.localStorage.setItem(GROUP_ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    // 存不下就只在本次会话生效——不因此打断排序交互
  }
}

/**
 * 折叠态（收起集合）的本地读写（v12 F4 / W-7，SPEC-4.8）：与上面的组序**同款口径**——
 * I/O 留在组件文件（`skills-logic.ts` 那一侧只放纯判据 `normalizeCollapsed` /
 * `renameCollapsed`，保持可 node 直测、不碰 `window`）。
 *
 * 自愈：**读侧**（缺键 / 非 JSON / 非数组 / 项非字符串）一律回落空集（= 全展开），
 * 不外抛；下一次切换即写回**合法** JSON。写不下（隐私模式）同样只在本次会话生效。
 */
function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY)
    if (raw === null) return new Set()
    return new Set(normalizeCollapsed(JSON.parse(raw) as unknown))
  } catch {
    return new Set()
  }
}

function writeCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed]))
  } catch {
    // 同 `writeGroupOrder`：存不下不打断交互
  }
}

/**
 * 技能页（v7 §4.3 S1-S10）：**三正交轴的技能台账**，不是「带徽标的列表」。
 *
 * 三轴（全站一个说法）：
 * - **来源**：内置 / 外部（仅本地有 SKILL.md）——行内文字标记，不用第二个同色徽标（S3）；
 * - **宿主**：已装 / 未装——未装行加 lamp + 「被 N 角色引用」警示（S4）；
 * - **层级 = 谁指定它**：全局 / 团队 / 角色——详情画成三行（`ScopeLayerRows`，与 teams 共用）。
 *
 * 废止 `N refs` 徽标（S1）；`skills_dir` 只用 `GET /api/skills` 读回值，读回为空即禁用
 * 安装/卸载（S6，绝不猜宿主目录）。
 *
 * **F8 §3.1 三档层级（本页）**：
 * - 第一眼 = 行内名字（`.md-row .t`，mono `--fs-200`/600 + 选中左 3px `--buckram` 引线）
 *   + 描述 1 行摘要（`.md-row .s`，32 字）/ 详情里的描述正文（`.skill-desc`，`--fs-300`）；
 * - 常用 = 未装时的 `.scope-callout`（安装命令）与 `.scope-rows` 三行（谁指定了它）；
 * - 深挖 = `.skill-deep`（`<details>` 默认折叠：安装路径 + SKILL.md 全文，含 render｜源码档位）。
 *
 * **F7 分类分组**：
 * - **列表侧**：按 `category` 分组（`skills-logic.ts#groupSkills` 的纯判据），组头 = `CountLine`
 *   `size="section"`（组名 + 引线 + 计数）+ `.toc-chev`，组内行容器 = `.collapse`**默认全展开**；
 *   未分类组置末尾、组头带 `lamp`。折叠只服务「技能上百条时按需收窄」，不是默认态。
 *   「这条技能属于谁」取两路**各自合并的 `category` 字段**（内置 = `GET /api/skills`，
 *   外部 = F7-1 起同样并进 `GET /api/skills/usage`，R-v8-5：不回头查第二张表）。
 * - **详情侧**：分组只存在于列表——详情侧无分组概念。
 *
 * **v12 F4（W-6）分类管理 + 组序**：
 * - **组集与组序改由分类清单驱动**：`GET /api/skills/categories` 的 `categories` 数组是
 *   **权威组集**——因此**空分类也成组**（组内 0 条、计数 0，SPEC-4.4；行上的 `category` 字段
 *   表达不出这件事）。行里不在清单内的**游离值**（删除后残留等）由 `groupSkills` 归未分类
 *   （SPEC-4.3 读侧口径）。清单**未就绪**（加载中 / 请求失败）时不传第二参，退回「由行推组」
 *   的旧口径——宁可暂时少几个空组，也不把整页行一次性打成未分类。
 * - **组序**（SPEC-4.10）：清单顺序是底，用户排序存 `localStorage['skills-group-order']`
 *   （键与纯判据在 `skills-logic.ts`，I/O 在本文件头部）。新分类缺省落在**已命名组末尾**、
 *   删除后残留键在挂载 effect 里自愈（`normalizeGroupOrder` 的注释逐条写死了这两点）。
 *   未分类组不参与排序（恒末）。
 * - **分类管理面**：新建（列表顶部的入口 + 名字输入）/ 改名（组头「改名」→ 就地输入）/
 *   删除（组头「删除」→ `ConfirmModal`，文案说明「组内技能回未分类」）。三者的失败码 →
 *   人话走 `skills-logic.ts#categoryErrorKey`（409 重名 / 404 源不存在 / 400 空名的**动作相关**分派）。
 *   成功后一律**刷新**（`GET` 为准，不做本地臆测级联——改名要等服务端回报的 mapping 才算数）。
 * - **过滤视图下空分类组不渲染**：过滤是「把命中行挑出来」，留着 0 命中的组头会与「某组空了
 *   连组头一起消失」的既有口径打架（`groupSkills` 的 `hideEmpty`）。
 *
 * **v12 F4（W-5）列表方块化 + 详情弹窗**：
 * - **卡片网格**：组内由 `.md-row` 行列表改为 **`NavRow variant="card"`**（与角色页同一套卡片
 *   token / 同一个网格定义 `.skill-grid`——`styles.css` 里它与 `.role-grid` **共用一条规则**，
 *   只加选择器不复制取值）。卡片四件：名（`.role-name.mono` + 分类色点 `.role-dot`）→
 *   一句话（`.role-desc`，1 行截断）→ 徽章（`.role-tags`：来源 / 宿主 / 未装且有引用方）。
 *   色点由 `skills-logic.ts#categoryColor` 按**分类名**确定性取既有 `--role-*` token，
 *   未分类不出色点（不新增颜色字面量 / 变量）。
 * - **详情 = 居中弹窗**：与团队页（W-4）同一迁移口径——右栏 `.md-detail` 与「选择提示」Pane
 *   一并消失，列表走单列（`.md.solo`）；选中（hash `#/skills/<name>`）时详情整体进
 *   `<Modal size="lg">`（宽度 = `--modal-w`），关闭 = `navigate({ page: 'skills' })`。
 *   装卸 / 外部删除的 `ConfirmModal` 叠在详情弹窗之上，Esc 只关**栈顶**（浮层栈的既有契约）。
 *   面板头的身份由弹窗头承担，故 `Pane` 头里那个重复的技能名 `h3` 已删（同 `TeamDetail` 口径）。
 *
 * **v12 F4（W-7）拖拽归类 + 折叠记忆 + 键盘替代（SPEC-4.6/4.7/4.8）**：
 *
 * - **拖拽源 = 技能卡**（`NavRow draggable`）：`dragstart` 记下 `{name, 组键}`（`SkillDragPayload`）
 *   并尽力 `dataTransfer.setData('text/plain', name)`（原生 DnD 在部分浏览器要求 dragstart 里
 *   设数据才会触发 drop）——**载荷真相在 state**，`dataTransfer` 只是原生要求的旁路（无它也能跑，
 *   见测试用的合成事件）。
 * - **落点 = 整个分类组**（`.skill-group` 包住「组头 + 卡片网格」）：组头与网格两处都可落，
 *   组内空白/空分类组的空态也一并算落点（没有死区）。`dragover` 给组加 `.drop-target`
 *   （`--buckram` 虚线框，既有引线语义色），`dragleave` / `drop` / `dragend` **三处都摘**；
 *   `dragleave` 用 `relatedTarget` 是否仍在组内判「真离开」（否则在子节点间移动会误摘）。
 * - **drop → `skillCategorize` → 刷新**：映射与清除语义走**纯函数** `dropCategorizeCall` /
 *   `categorizePayload`（未分类目标 = **省略 `category`** = 服务端的清除档，见两函数注释）；
 *   成功**不做本地臆测级联**，一律 `refreshAll()`（与分类 CRUD 三动作同一口径）。
 * - **同组放回 = 空操作**（纯函数返回 `null`，不发请求）；拖拽排序记债不做（F4 原口径）。
 * - **过滤态**：`groups` 只含命中组 ⇒ 被过滤隐藏的分类组**根本不渲染**，自然不是落点
 *   （不会「拖到一个看不见的组」）。**折叠态**：组头仍在 DOM 里（收起不卸载），故收起组
 *   照常可落——但组内卡片已 `visibility: hidden`、不可见也就不可能成为**拖拽源**。
 * - **键盘替代（SPEC-4.7）**：无鼠标归类走**详情弹窗内的分类下拉**（选项 = 未分类 + 清单全集，
 *   与列表分组同一权威源；`change` 即走同一条 categorize 通道）。
 * - **折叠记忆（SPEC-4.8）**：收起集合存 `localStorage['skills-collapsed']`（JSON 数组，
 *   缺键/损坏一律自愈成空 = 全展开）；与组序键 `skills-group-order` 并存，且**分类改名时
 *   由 `renameCollapsed` 同步迁移**（两把键都以分类名为键）。
 * - **「未分类」恒末不可删**：DnD 只写 mapping，**不提供任何删除入口**（删除只走 W-6 的组头动作）。
 *
 * **v10 F3ui 外部技能删除（本批）**：详情工具条的破坏性动作是**二选一**——
 * usage 行 `external_removable === true`（宿主目录里人写、无 Prism 标记的目录）显「删除」
 * （`DELETE /api/skills/external/:name`，整目录进回收站），否则显既有的「卸载」
 * （只清 Prism 产物）。字段缺失 / `false` 一律按现状走卸载（内置与 Prism 产物零变更）。
 */

/**
 * 技能台账行（F1 起抽到 `skills-logic.ts#SkillCatalogRow` 并**与角色表单选取器共用**）：
 * 两路合并的口径、排序与字段来源注释都在那里——本页只消费，不再自己合并
 * （此前内联在下面的 `useMemo` 里，选取器若再抄一遍就是第二处镜像）。
 */
type SkillRow = SkillCatalogRow

export function SkillsPage({ sel }: { sel?: string }) {
  const t = useT()
  const skills = useAsync(() => teamApi.skills(), [])
  const usage = useAsync(() => teamApi.skillUsage(), [])
  /**
   * 分类清单（v12 F4 / W-6）：**组集与组序的权威来源**（能表达空分类）。
   *
   * ⚠ 它**不进页面级 `State` 的 error**——清单拉不回来只是「少几个空分类组」，
   * 分组退回「由行推组」的旧口径（`groupSkills` 第二参缺省），整页列表照常可用。
   * 把辅助面的一次失败升级成整页错误，代价与收益不匹配。
   */
  const categories = useAsync(() => teamApi.skillCategories(), [])
  const [filter, setFilter] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  /**
   * 收起的**分类组**（F7 §3.5）：与知识库目录树的 `collapsedDirs` 同口径——存**收起态**，
   * 缺省即展开，故「默认全部展开」是天然的（折叠是用户主动的收窄手段，不是默认态）。
   * 键 = 分类名；未分类组的键是哨兵 `''`（分类名恒非空，不会撞）。
   *
   * v12 F4（W-7，SPEC-4.8）：初始值改成**从 localStorage 惰性读**（`readCollapsed`），
   * 每次切换写回 ⇒ 重进页面保持；损坏 / 缺键自愈成空集（见两个文件级 helper 的注释）。
   */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(readCollapsed)
  /**
   * 拖拽态（v12 F4 / W-7）：`drag` = 正在被拖的卡片（名 + 当前组键），`dragOver` = 当前
   * 悬停的落点组键（`dragover` 置、`dragleave` / `drop` / `dragend` 摘）。两者分开存：
   * `drag` 决定「drop 有没有载荷」，`dragOver` 只驱动高亮类（同一个组反复 `dragover`
   * 不会因 `dragOver` 未变而重渲染——见组容器的 `onDragOver` 里的相等判断）。
   */
  const [drag, setDrag] = useState<SkillDragPayload | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  /** 页内视图切换（**不进 hash**，S7）：详情 | 有效集（正向视图） */
  const [view, setView] = useState<'detail' | 'effective'>('detail')
  const [busy, setBusy] = useState(false)
  const [pendingUninstall, setPendingUninstall] = useState<SkillDetail | null>(null)
  /**
   * 待确认的**外部技能删除**（F3ui）：存技能名——删除口只吃 `:name`（整目录由服务端按
   * 落点搬运），不需要 `SkillDetail` 的其余字段，故不复用 `pendingUninstall` 的载荷。
   */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** 删除失败的就地反馈（模态未关时不能落到背后的列表上，同 `ConfirmModal#error` 的既有口径）。 */
  const [deleteError, setDeleteError] = useState('')
  /** 删除成功的**页级提示条**（列表刷新后人在列表上，反馈贴结果而不是留在已关的模态里）。 */
  const [notice, setNotice] = useState('')
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'warn' | 'err'; lines: string[] } | null>(null)

  /* ── v12 F4（W-6）分类管理面的页内状态（四组，各自的输入 / 就地错误分开存）──────────────
     新建与改名都是**就地表单**（技能页的表单面，分类名本身就是用户可见标识——不受团队域
     「展示面纯 id」那条口径约束）；删除走既有 `ConfirmModal`（危险动作的唯一确认零件）。 */
  const [groupOrder, setGroupOrder] = useState<string[]>(readGroupOrder)
  const [adding, setAdding] = useState(false)
  const [addName, setAddName] = useState('')
  const [addError, setAddError] = useState('')
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState('')
  const [pendingRemoveCategory, setPendingRemoveCategory] = useState<string | null>(null)
  const [removeCategoryError, setRemoveCategoryError] = useState('')

  const key = sel?.trim() ?? ''
  const detail = useAsync(
    () => (key === '' ? Promise.resolve(undefined) : teamApi.skill(key)),
    [key],
  )

  useEffect(() => setView('detail'), [key])

  /**
   * 台账行 = 两路合并（口径与排序都在 `mergeSkillCatalog`，F1 起与角色表单选取器共用一份）。
   * 外部技能的 `category` / `external_removable` 与 `installed` / `roles` / `teams` 同源同路
   * （都只出现在 usage 路）——逐字段语义见 `skills-logic.ts`。
   */
  const rows = useMemo<SkillRow[]>(
    () => mergeSkillCatalog(skills.data?.skills ?? [], (usage.data ?? []) as SkillUsage[]),
    [skills.data, usage.data],
  )

  /**
   * S1 页头三轴计数（F8 §3.4 #3 后只剩两轴）：「内置 / 外部」这一列已删——来源是行内文字标记
   * （S3）且 F7 的分类组头已逐组报数（本批已落），页头再报一遍是按行第二遍陈述；
   * 保留的两轴都**行动相关**：已装/未装（决定命令块出不出）与 被角色/团队引用（决定谁是引用方）。
   */
  const counts = useMemo(
    () => ({
      installed: rows.filter((r) => r.installed).length,
      missing: rows.filter((r) => !r.installed).length,
      byRole: rows.filter((r) => r.roles.length > 0).length,
      byTeam: rows.filter((r) => r.teams.length > 0).length,
    }),
    [rows],
  )

  // S9：过滤扩到 name + 描述 + 引用方名（正文需逐个拉详情，客户端不做）
  const keyword = filter.trim().toLowerCase()
  /** 过滤态：决定「空分类组渲不渲染」（见下方 `groupSkills` 的 `hideEmpty`）。 */
  const filterActive = keyword !== '' || onlyMissing
  const shown = rows.filter((r) => {
    if (onlyMissing && r.installed) return false
    if (keyword === '') return true
    const hay = [r.name, r.summary, ...r.roles, ...r.teams].join(' ').toLowerCase()
    return hay.includes(keyword)
  })

  const categoryNames = categories.data?.categories

  /**
   * 残留键自愈（SPEC-4.10「刷新后保持」的配套）：存储里可能留着**已删除分类**的名字。
   * 判据（丢谁、留谁）在 `normalizeGroupOrder`（纯函数）；这里只管「发现残留就剪掉并写回」。
   * 只在**真有残留**时写，免得每次首访都往 localStorage 落一份默认序。
   */
  useEffect(() => {
    if (categoryNames === undefined) return
    if (groupOrder.every((name) => categoryNames.includes(name))) return
    const pruned = groupOrder.filter((name) => categoryNames.includes(name))
    setGroupOrder(pruned)
    writeGroupOrder(pruned)
  }, [categoryNames, groupOrder])

  /** 生效组序 = 清单顺序 + 用户存储序（新分类缺省补在已命名组末尾；见 `normalizeGroupOrder`）。 */
  const namedOrder = useMemo(
    () => (categoryNames === undefined ? undefined : normalizeGroupOrder(categoryNames, groupOrder)),
    [categoryNames, groupOrder],
  )

  /**
   * F7 分组（§3.5）+ v12 W-6：分组只吃**已过滤**的行——命中的组才出现，组头计数即命中数
   * （过滤后某组空了，该组连组头一起消失，不留空壳）。分类清单就绪时它同时是**组集与组序**
   * （空分类成组）；未就绪（`undefined`）时退回「由行推组」的旧口径。判据在 `skills-logic.ts`。
   */
  const groups = groupSkills(shown, namedOrder, { hideEmpty: filterActive })

  /**
   * 参与排序的**已命名组序**：清单就绪时用 `namedOrder`（含被过滤隐藏的空组——移动不丢它们的
   * 相对位置）；未就绪时由可见组推（那一支没有空组，两者等价）。
   */
  const movableOrder = namedOrder ?? groups.filter((g) => g.category !== UNCATEGORIZED).map((g) => g.category)

  /** 组头 ↑↓：改生效序 → 存 localStorage（未分类不参与，见 `moveGroup` 的契约）。 */
  const reorder = (name: string, delta: -1 | 1) => {
    const next = moveGroup(movableOrder, name, delta)
    if (next === movableOrder) return // 越界：`moveGroup` 原样返回引用，不白写一次存储
    setGroupOrder(next)
    writeGroupOrder(next)
  }

  /** 组头是**展开切换**不是导航实体：对齐知识库目录树 `.toc-mod` 的既有交互口径。 */
  const keyboardToggle = (e: ReactKeyboardEvent<HTMLDivElement>, run: () => void) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    run()
  }

  /**
   * 折叠切换 + **写回本地**（W-7，SPEC-4.8）：用当次 state 直接算下一态（不塞进函数式
   * updater——写 localStorage 是副作用，放进 updater 会在 StrictMode 的双调用下写两次；
   * 折叠是逐次用户驱动，直接读 `collapsedGroups` 不会丢更新）。
   */
  const toggleGroup = (category: string) => {
    const next = new Set(collapsedGroups)
    if (next.has(category)) next.delete(category)
    else next.add(category)
    setCollapsedGroups(next)
    writeCollapsed(next)
  }

  const loading = skills.loading || usage.loading
  const error = skills.error ?? usage.error
  const skillsDir = skills.data?.skills_dir ?? ''
  const dirMissing = skills.data !== undefined && skillsDir === ''

  const refreshAll = () => {
    skills.reload()
    usage.reload()
    detail.reload()
    // W-6：分类管理面（新建 / 改名 / 删除）失败后要能重取清单；成功路径也靠它把服务端
    // 的**级联结果**（改名后组内技能的展示分类）拉回来——不做本地臆测级联。
    categories.reload()
  }

  const install = async (name: string) => {
    if (skillsDir === '') return
    setBusy(true)
    setFeedback(null)
    try {
      const out = await teamApi.skillInstall({ skills_dir: skillsDir, names: [name] })
      const lines = [
        t('skills.install.done', { n: out.written.length }),
        ...out.written.map((n) => `${t('skills.install.written')} ${n}`),
        ...out.skipped.map((s) => t('skills.install.skippedLine', { path: s.path, reason: s.reason })),
      ]
      setFeedback({ kind: out.skipped.length > 0 ? 'warn' : 'ok', lines })
      refreshAll()
    } catch (e) {
      setFeedback({ kind: 'err', lines: [t('common.loadFailed', { msg: e instanceof Error ? e.message : String(e) })] })
    } finally {
      setBusy(false)
    }
  }

  const uninstall = async () => {
    if (pendingUninstall === null || skillsDir === '') return
    setBusy(true)
    setFeedback(null)
    try {
      const out: SkillUninstallOutcome = await teamApi.skillUninstall({
        skills_dir: skillsDir,
        names: [pendingUninstall.name],
      })
      const lines = [
        t('skills.uninstall.done', { n: out.removed.length }),
        ...out.removed.map((n) => `${t('skills.uninstall.removed')} ${n}`),
        ...out.kept.map((k) => t('skills.uninstall.keptLine', { name: k.name, reason: k.reason })),
      ]
      setFeedback({ kind: out.kept.length > 0 ? 'warn' : 'ok', lines })
      setPendingUninstall(null)
      refreshAll()
    } catch (e) {
      setFeedback({ kind: 'err', lines: [t('common.loadFailed', { msg: e instanceof Error ? e.message : String(e) })] })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 删除**外部**技能（F3ui）：与 `uninstall` 是两条不同语义的动作（见本文件头注），
   * 故独立一条链路而不是给 `uninstall` 加分支——两者的入参、返回值、失败面都不同。
   *
   * 三点刻意：
   * 1. **不要求 `skills_dir`**：本口无 body，服务端用它自己解析的同源目录（`wiring.ts` 口径）；
   *    `skills_dir` 读不回来时「卸载」要禁用，但删除不受这条影响（少一个假禁用）；
   * 2. 失败码映射走 `skills-logic.ts#externalDeleteErrorKey`（纯函数、node 直测）；
   *    未知码原文透出（`common.loadFailed`），不猜服务端文案；
   * 3. 成功后若删的正是当前选中项 → 回列表页：实体已不存在，停在详情上只会看到
   *    一次 404「未命中」（与角色页 D-2「删除后不留幽灵浮层」同一条裁决）。
   */
  const removeExternal = async () => {
    if (pendingDelete === null) return
    const name = pendingDelete
    setBusy(true)
    setDeleteError('')
    setNotice('')
    try {
      const out = await teamApi.skillDeleteExternal(name)
      setPendingDelete(null)
      setNotice(t('skills.delete.done', { name, id: out.trash_id }))
      if (key === name) navigate({ page: 'skills' })
      refreshAll()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const mapped = externalDeleteErrorKey(msg)
      setDeleteError(mapped !== null ? t(mapped) : t('common.loadFailed', { msg }))
    } finally {
      setBusy(false)
    }
  }

  /**
   * v12 F4（W-6）分类三动作。共同口径：
   * - **本地先校验空名**（`bad_request` 的服务端口径就是「trim 后为空」）——省一次注定失败的请求，
   *   文案与服务端那一档同键（`skills.category.err.empty`），不造第二套措辞；
   * - 失败码 → 人话走 `categoryErrorKey(msg, action)`（纯函数、node 直测），未知码原文透出；
   * - **成功一律 `refreshAll()`**：改名要等服务端回报的 `mapping` 级联，删除要等清单重取 —— 
   *   本地臆测级联迟早与服务端漂移（冻结契约里 `mapping` 的写方是服务端）。
   */
  const submitAdd = async () => {
    const name = addName.trim()
    if (name === '') {
      setAddError(t('skills.category.err.empty'))
      return
    }
    setBusy(true)
    setAddError('')
    setNotice('')
    try {
      await teamApi.skillCategoryAdd({ name })
      setAdding(false)
      setAddName('')
      setNotice(t('skills.category.addDone', { name }))
      refreshAll()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const mapped = categoryErrorKey(msg, 'add')
      setAddError(mapped !== null ? t(mapped) : t('common.loadFailed', { msg }))
    } finally {
      setBusy(false)
    }
  }

  const submitRename = async () => {
    if (renameTarget === null) return
    const from = renameTarget
    const to = renameName.trim()
    if (to === '') {
      setRenameError(t('skills.category.err.empty'))
      return
    }
    // 同名 = 服务端契约里的幂等 no-op；本地直接收口，免得报一句「A 改名为 A」
    if (to === from) {
      setRenameTarget(null)
      return
    }
    setBusy(true)
    setRenameError('')
    setNotice('')
    try {
      await teamApi.skillCategoryRename({ from, to })
      // W-7（SPEC-4.8 配套）：折叠键与组序键都以分类名为键，改名时把收起集合里的旧名一并
      // 搬过去（`renameCollapsed` 在旧名不在集合里时**原样返回同引用**，此时不写盘）。
      const migrated = renameCollapsed(collapsedGroups, from, to)
      if (migrated !== collapsedGroups) {
        setCollapsedGroups(new Set(migrated))
        writeCollapsed(migrated)
      }
      setRenameTarget(null)
      setRenameName('')
      setNotice(t('skills.category.renameDone', { from, to }))
      refreshAll()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const mapped = categoryErrorKey(msg, 'rename')
      setRenameError(mapped !== null ? t(mapped) : t('common.loadFailed', { msg }))
    } finally {
      setBusy(false)
    }
  }

  const removeCategory = async () => {
    if (pendingRemoveCategory === null) return
    const name = pendingRemoveCategory
    setBusy(true)
    setRemoveCategoryError('')
    setNotice('')
    try {
      await teamApi.skillCategoryRemove(name)
      setPendingRemoveCategory(null)
      setNotice(t('skills.category.removeDone', { name }))
      refreshAll()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const mapped = categoryErrorKey(msg, 'remove')
      setRemoveCategoryError(mapped !== null ? t(mapped) : t('common.loadFailed', { msg }))
    } finally {
      setBusy(false)
    }
  }

  /**
   * v12 F4（W-7）归类写操作：**拖拽 drop 与详情下拉共用这一条通道**（SPEC-4.6/4.7）。
   *
   * - 载荷由纯函数 `categorizePayload(name, target)` 构造（目标为未分类 ⇒ 省略 `category`
   *   = 服务端的**清除**档，语义口径见该函数注释）；
   * - `surface` 只决定反馈落哪：列表上的拖拽 → 页级提示条（模态没开，人就在列表上）；
   *   弹窗内的下拉 → `feedback`（就地显示在详情里，页级条被浮层盖住看不见）；
   * - 成功**不本地臆测级联**，一律 `refreshAll()`（同分类 CRUD 三动作）；
   * - 失败原文透出（`common.loadFailed`），不猜服务端文案。
   */
  const applyCategorize = async (name: string, target: string, surface: 'page' | 'modal') => {
    setBusy(true)
    setFeedback(null)
    setNotice('')
    try {
      await teamApi.skillCategorize(categorizePayload(name, target))
      const line =
        target === UNCATEGORIZED
          ? t('skills.drag.cleared', { name })
          : t('skills.drag.moved', { name, category: target })
      if (surface === 'modal') setFeedback({ kind: 'ok', lines: [line] })
      else setNotice(line)
      refreshAll()
    } catch (e) {
      const line = t('common.loadFailed', { msg: e instanceof Error ? e.message : String(e) })
      if (surface === 'modal') setFeedback({ kind: 'err', lines: [line] })
      else setNotice(line)
    } finally {
      setBusy(false)
    }
  }

  /** `dragstart`：记载荷 + 尽力把技能名写进 `dataTransfer`（原生 DnD 的旁路要求）。 */
  const startDrag = (e: ReactDragEvent<HTMLAnchorElement>, row: SkillRow, category: string) => {
    setDrag({ name: row.name, category })
    try {
      e.dataTransfer.setData('text/plain', row.name)
      e.dataTransfer.effectAllowed = 'move'
    } catch {
      // 无 `dataTransfer` 的宿主（happy-dom 合成事件等）：载荷真相在 state，不影响归类
    }
  }

  /** `dragend`（拖拽无论落没落成都会触发）：兜底摘掉高亮与载荷。 */
  const endDrag = () => {
    setDrag(null)
    setDragOver(null)
  }

  /**
   * `drop`：同组放回不发请求（纯函数给 `null`），跨组/清除才走通道。落点恒为**组键**，
   * 与 `SkillDragPayload.category` 同一坐标系（未分类都是哨兵 `''`）——这就是「按看到的组判」。
   */
  const dropOnGroup = (e: ReactDragEvent<HTMLDivElement>, category: string) => {
    e.preventDefault()
    setDragOver(null)
    const payload = drag
    setDrag(null)
    if (payload === null || busy) return
    const call = dropCategorizeCall(payload, category)
    if (call === null) return
    void applyCategorize(payload.name, category, 'page')
  }

  /**
   * MINOR-13：`useAsync` 换 key 不清 `data`（`useAsync.ts:21`），首帧会把**上一个技能**的
   * 正文画到新 hash 下。只消费「名字与当前 key 一致」的那条（与 `Roles.tsx:111` 的
   * `linked.data.name === key` 同一守卫）；对不上且未报错时按未就绪走 loading，
   * 不落 notFound（否则换 key 的首帧会闪一次「未命中」）。
   */
  const d = detail.data !== undefined && detail.data.name === key ? detail.data : undefined
  const staleDetail = detail.data !== undefined && detail.data.name !== key
  /**
   * 选中技能在台账里的那条行（详情接口不下发 `category` / `external_removable`，
   * 两者都**只**来自 usage 路合出来的行）。一个 `find` 供两处消费，不回查、不按名字猜。
   */
  const selectedRow = d !== undefined ? rows.find((r) => r.name === d.name) : undefined
  /**
   * 选中技能的「外部可删」态（F3ui）：判定归服务端（见 `SkillUsage.external_removable`）。
   */
  const externalRemovable = selectedRow?.externalRemovable === true
  /**
   * 选中技能的**生效分类**（W-7 键盘下拉的当前值）：行上的值必须**命中清单**才算数
   * （游离值 / 清单未就绪 ⇒ 按未分类呈现，与 `groupSkills` 的读侧口径一致）。
   */
  const selectedCategory =
    selectedRow?.category !== undefined && (categoryNames ?? []).includes(selectedRow.category)
      ? selectedRow.category
      : UNCATEGORIZED
  /**
   * 详情正文（W-5 起整块进居中弹窗，见下方渲染）。
   *
   * 四种状态一字未改（加载 / 深链未命中 / 正文），只去掉了「未选中」那一档——未选中时
   * 弹窗**根本不挂载**（同团队页 W-4：无选中 = 纯列表，右栏与「选择提示」Pane 一并消失）。
   */
  const detailPane =
    detail.loading || (staleDetail && detail.error === undefined) ? (
      <Pane>
        {/* B10：详情加载走统一骨架，不再手写 `…` */}
        <State loading />
      </Pane>
    ) : detail.error !== undefined || d === undefined ? (
      /* 深链未命中（S9/R8 模式）：带名称 + 出路 */
      <Pane>
        <h3 className="mono">{key}</h3>
        <p className="muted">{t('skills.notFound.desc', { name: key })}</p>
        <div className="row">
          <a className="tool-btn" href={hrefOf({ page: 'skills' })}>{t('skills.notFound.back')}</a>
          <a className="tool-btn" href={hrefOf({ page: 'teams' })}>{t('skills.notFound.teams')}</a>
        </div>
      </Pane>
    ) : (
      <Pane
        head={
          <div className="pane-head">
            {/* W-5：技能名不再在这里重复一遍——**身份由弹窗头承担**（同 `TeamDetail` 的迁移口径），
                否则同一个名字会在弹窗头与面板头各出现一次。面板头只留状态与动作位。 */}
            <StatusTag kind={d.installed ? 'ok' : 'warn'}>
              {d.installed ? t('common.installed') : t('common.notInstalled')}
            </StatusTag>
            {!d.installed && d.roles.length > 0 && (
              <StatusTag kind="warn">{t('skills.row.refWarn', { n: d.roles.length })}</StatusTag>
            )}
            <span className="spacer" />
            {view === 'detail' ? (
              <button type="button" className="tool-btn" onClick={() => setView('effective')}>
                {t('skills.effective.view')}
              </button>
            ) : (
              <button type="button" className="tool-btn" onClick={() => setView('detail')}>
                {t('skills.effective.back')}
              </button>
            )}
          </div>
        }
      >
        {view === 'effective' ? (
          <EffectiveSkills
            role={d.roles[0] ?? ''}
            roleOptions={d.roles.length > 0 ? d.roles : undefined}
            onOpenUsage={() => setView('detail')}
          />
        ) : (
          <SkillBody
            detail={d}
            skillsDir={skillsDir}
            dirMissing={dirMissing}
            busy={busy}
            feedback={feedback}
            externalRemovable={externalRemovable}
            categories={categoryNames ?? []}
            category={selectedCategory}
            onCategorize={(next) => void applyCategorize(d.name, next, 'modal')}
            onInstall={() => void install(d.name)}
            onAskUninstall={() => setPendingUninstall(d)}
            onAskDelete={() => setPendingDelete(d.name)}
          />
        )}
      </Pane>
    )

  return (
    <>
      {/* F3：`.page-fill` 吃满 `.page` 的**内容盒**（内容盒 = 视口 − 顶栏 − 页内边距，
          故不必写 `100vh − …` 的减法）；页头/计数条按内容占高、`.md` 吃剩余高度
          ⇒ 左右两栏各自在视口内滚动、整页不滚（见 styles.css 的 F3 段）。 */}
      <div className="page-fill">
        {/* B1：页标题走 `<PageHead>`（`--fs-600`/600）——手写 `<h1>` 是 UA 默认 28px/700。 */}
        <PageHead title={t('skills.title')} sub={t('skills.desc')} />

        {/* S1：页头计数 + 只看未装 + 过滤框。
            B7：三轴各两值此前是三条 `A n · B m` 独立计数行（第 5 种计数排法）→ 统一引线口径
            （`<CountLine>`）：一轴一列、每列两行，同列计数右对齐成一列（§2.9「可比的一列」）。
            F8 §3.4 #3：「内置 / 外部」列删除（该信息已由行内文字标记 S3 表达），剩两轴。 */}
        <div className="scope-head">
          <div className="scope-counts">
            <div className="scope-count-col">
              <CountLine label={t('common.installed')} count={counts.installed} />
              <CountLine label={t('common.notInstalled')} count={counts.missing} />
            </div>
            <div className="scope-count-col">
              <CountLine label={t('skills.counts.byRole')} count={counts.byRole} />
              <CountLine label={t('skills.counts.byTeam')} count={counts.byTeam} />
            </div>
          </div>
          <span className="spacer" />
          <label className="scope-check">
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
            {t('skills.onlyMissing')}
          </label>
          <input
            className="role-filter"
            placeholder={t('skills.filterPlaceholder')}
            aria-label={t('skills.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {dirMissing && <div className="banner small">{t('skills.dirMissing')}</div>}
        {/* R-6 Q2（按触发源就地）：安装/卸载的**唯一触发面是详情**（`onInstall`/`onAskUninstall` 只由
            SkillBody 发起），故反馈条只渲染在详情内（见 SkillBody），页头不再镜像一份同样的结果。
            F3ui 的**外部技能删除**是这条口径的例外：删除成功后被删技能已不存在，详情要收口回列表
            （否则停在一次 404 上），反馈没有可依附的触发点 ⇒ 落到**页级**提示条（人在列表上）。 */}
        {notice !== '' && <div className="banner small" role="status">{notice}</div>}

        <State loading={loading} error={error} empty={!loading && !error && rows.length === 0} emptyText={t('skills.empty')}>
          {/* W-5：详情迁入弹窗后主从网格**只剩列表** ⇒ 单列铺满（`.md.solo`，与团队页 W-4 同形；
              `.md` 基类的两列定义一字未动——它仍是「列表 ∥ 详情」同时在场时的口径）。 */}
          <div className="md solo">
            <div className="md-list">
              {/* S9：检索/过滤无结果走行内空态（唯一出口），不再与整页空态同屏 */}
              {shown.length === 0 && (
                <div className="pane" style={{ margin: 'var(--s-2)' }}>
                  <p className="muted small">{t('skills.filterNone')}</p>
                </div>
              )}
              {/* v12 F4（W-6）新建分类 = 列表顶部的**就地表单**（入口 + 名字输入）。
                  分类名是**用户数据 / 用户可见标识**，故这里的输入面是对的——团队域「展示面纯
                  id」那条口径管的是「id 才是唯一标识」，不适用于分类名。 */}
              <div className="skill-cat-manage">
                {adding ? (
                  <form
                    className="skill-cat-form"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void submitAdd()
                    }}
                  >
                    <input
                      className="skill-cat-input"
                      value={addName}
                      placeholder={t('skills.category.namePlaceholder')}
                      aria-label={t('skills.category.namePlaceholder')}
                      onChange={(e) => setAddName(e.target.value)}
                    />
                    <button type="submit" className="tool-btn" disabled={busy}>
                      {t('skills.category.create')}
                    </button>
                    <button
                      type="button"
                      className="tool-btn"
                      onClick={() => {
                        setAdding(false)
                        setAddName('')
                        setAddError('')
                      }}
                    >
                      {t('common.cancel')}
                    </button>
                    {addError !== '' && <span className="err-text">{addError}</span>}
                  </form>
                ) : (
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={() => {
                      setAdding(true)
                      setAddName('')
                      setAddError('')
                      setNotice('')
                    }}
                  >
                    {t('skills.category.add')}
                  </button>
                )}
              </div>
              {/* F7 分类分组（§3.5）：**层级载体是「组」本身**——折叠态下组头是唯一的可见结构
                  （列表的第一眼 = 组名 + 计数）；展开后组内每一行仍按技能三层排（分组**不改变**
                  行的层级，只把「同一屏里的行数」从全量降到一组）。组内行容器走 `.collapse`
                  （工作流阶段已在用的高度过渡），**默认全展开**。 */}
              {groups.map((group) => {
                const open = !collapsedGroups.has(group.category)
                const uncategorized = group.category === UNCATEGORIZED
                // 组序里的下标（未分类不在其中 ⇒ -1）。边界由它决定：首组不能上移、末组不能下移。
                const namedIndex = movableOrder.indexOf(group.category)
                return (
                  /* v12 F4（W-7）**整组 = 拖拽落点**（SPEC-4.6）：组头与卡片网格都在这个容器里，
                     故「两处都可落」是这一条 `onDragOver` 的自然结果（组内空白 / 空分类组的空态
                     也一并算，没有死区）。三件事：
                     1. `onDragOver` 才 `preventDefault`（可落），并按组键置高亮——`drag === null`
                        时（拖的不是技能卡，如宿主拖文件）不接管，免得平白高亮；
                     2. `onDragLeave` 用 `relatedTarget` 判「真离开」：在子节点间移动时它仍在组内，
                        若直接摘高亮会闪（happy-dom 无 relatedTarget ⇒ 视为离开，正好可测清理）；
                     3. `onDrop` 恒摘高亮（`dropOnGroup` 里先 `setDragOver(null)`），`dragend` 兜底。 */
                  <div
                    key={group.category}
                    className={`skill-group${dragOver === group.category ? ' drop-target' : ''}`}
                    onDragOver={(e) => {
                      if (drag === null) return
                      e.preventDefault()
                      if (dragOver !== group.category) setDragOver(group.category)
                    }}
                    onDragLeave={(e) => {
                      const next = e.relatedTarget as Node | null | undefined
                      if (next != null && e.currentTarget.contains(next)) return
                      setDragOver((cur) => (cur === group.category ? null : cur))
                    }}
                    onDrop={(e) => dropOnGroup(e, group.category)}
                  >
                    {/* v12 F4（W-6）：组头一行 = **折叠切换**（左，吃满剩余宽度）+ **分类管理动作**
                        （右）。⚠ 动作按钮是切换节点的**兄弟**而不是嵌进 `role="button"` 的组头里：
                        交互元素不得嵌套——嵌进去则「点改名」会顺带折叠一次，无障碍树上「按钮里还有
                        按钮」也说不清。未分类组**不可改名 / 不可删 / 不参与排序**，故不给动作位。 */}
                    <div className="skill-group-bar">
                      {/* 组头 = `CountLine size="section"`（组名 + 引线 + 计数）+ `.toc-chev`
                          （展开态旋转 90°，复用知识库目录树的既有类）。未分类组置**末尾**、
                          组头带 `CountLine` 的 `lamp`——`--warn` 是既有状态色，不是新增颜色。
                          `bare` 让引线吃满这一行的弹性宽度（`.pane-head` / `.row` 同款用法）。 */}
                      <div
                        className="skill-group-head"
                        role="button"
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => toggleGroup(group.category)}
                        onKeyDown={(e) => keyboardToggle(e, () => toggleGroup(group.category))}
                      >
                        <CountLine
                          size="section"
                          bare
                          label={uncategorized ? t('skills.uncategorized') : group.category}
                          count={group.skills.length}
                          lamp={uncategorized}
                        />
                        <span className={`toc-chev${open ? ' open' : ''}`}>▸</span>
                      </div>
                      {!uncategorized && (
                        <div className="skill-group-actions">
                          {/* SPEC-4.10 组排序：↑↓ 只改**已命名组**的生效序并存 localStorage
                              （`moveGroup` 越界原样返回，按钮在两端禁用，双击也只动一格）。 */}
                          <button
                            type="button"
                            className="tool-btn"
                            title={t('skills.category.moveUp')}
                            aria-label={t('skills.category.moveUp')}
                            disabled={busy || namedIndex <= 0}
                            onClick={() => reorder(group.category, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="tool-btn"
                            title={t('skills.category.moveDown')}
                            aria-label={t('skills.category.moveDown')}
                            disabled={busy || namedIndex === -1 || namedIndex >= movableOrder.length - 1}
                            onClick={() => reorder(group.category, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="tool-btn"
                            onClick={() => {
                              setRenameTarget(group.category)
                              setRenameName(group.category)
                              setRenameError('')
                              setNotice('')
                            }}
                          >
                            {t('skills.category.rename')}
                          </button>
                          <button
                            type="button"
                            className="tool-btn"
                            onClick={() => {
                              setPendingRemoveCategory(group.category)
                              setRemoveCategoryError('')
                              setNotice('')
                            }}
                          >
                            {t('skills.category.remove')}
                          </button>
                        </div>
                      )}
                    </div>
                    {/* 改名 = **就地表单**（在组头之下、组内容之上）：409 目标重名 / 404 源不存在
                        / 400 空名都在这里就地报错，成功走 `refreshAll()`（服务端级联为准）。 */}
                    {renameTarget === group.category && (
                      <form
                        className="skill-cat-form skill-group-rename"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void submitRename()
                        }}
                      >
                        <input
                          className="skill-cat-input"
                          value={renameName}
                          placeholder={t('skills.category.namePlaceholder')}
                          aria-label={t('skills.category.namePlaceholder')}
                          onChange={(e) => setRenameName(e.target.value)}
                        />
                        <button type="submit" className="tool-btn" disabled={busy}>
                          {t('common.save')}
                        </button>
                        <button
                          type="button"
                          className="tool-btn"
                          onClick={() => {
                            setRenameTarget(null)
                            setRenameName('')
                            setRenameError('')
                          }}
                        >
                          {t('common.cancel')}
                        </button>
                        {renameError !== '' && <span className="err-text">{renameError}</span>}
                      </form>
                    )}
                    {/* 收起不卸载（`.collapse` 的 `grid-template-rows: 0fr→1fr` 要求内容常驻
                        DOM，见 `collapse-dom.test.ts`）；折叠态由 `visibility: hidden` 挡出
                        Tab 序列与无障碍树。 */}
                    <div className={`collapse${open ? ' open' : ''}`}>
                      <div>
                        {/* v12 F4：组内是**卡片网格**（与角色页共用一条网格定义，见 styles.css
                            的 `.role-grid, .skill-grid`）。色点按**分类名**确定性取色（纯函数
                            `categoryColor`），未分类不渲染色点——「同一个分类一个色」是稳定判据。
                            W-6：**空分类组**（清单里有、0 条技能）照常出组头 + 计数 0，组内给一句
                            空态（不是空白网格，也不是连组头一起消失）。 */}
                        <div className="skill-grid">
                          {group.skills.length === 0 && (
                            <p className="muted small skill-group-empty">{t('skills.category.empty')}</p>
                          )}
                          {group.skills.map((row) => {
                            const dot = categoryColor(group.category)
                            return (
                              <NavRow
                                key={row.name}
                                variant="card"
                                href={hrefOf({ page: 'skills', sel: row.name })}
                                selected={key === row.name}
                                /* W-7：卡片 = 拖拽源（SPEC-4.6）。拖起的那张加 `.dragging`
                                   （只降透明度，不新造颜色）；`dragend` 恒清载荷与高亮。 */
                                draggable
                                className={drag?.name === row.name ? 'dragging' : undefined}
                                onDragStart={(e) => startDrag(e, row, group.category)}
                                onDragEnd={endDrag}
                              >
                                <div className="role-name mono">
                                  {dot !== undefined && <span className="role-dot" style={{ background: dot }} />}
                                  {row.name}
                                </div>
                                {/* F8 §3.4 #5 的口径不变：摘要收 **1 行 ≤32 字**（列表只留入口，
                                    全文进详情第一眼 `.skill-desc`）；截断由共用的 `.role-desc`
                                    （`-webkit-line-clamp: 1`）兜底，全文进 `title`（悬停可读）。 */}
                                {row.summary !== '' && (
                                  <div className="role-desc" title={row.summary}>
                                    {firstSentence(row.summary, 32)}
                                  </div>
                                )}
                                {/* S3：来源与宿主是**标记**不是标题，不参与第一眼的名字行；
                                    未装才给 lamp（既有 `--warn` 状态色）。F3ui 的引用警示仍走 warn 档。 */}
                                <div className="role-tags">
                                  <span className="tag">{row.builtin ? t('common.builtin') : t('common.external')}</span>
                                  <span className="tag">
                                    {row.installed ? t('common.installed') : t('common.notInstalled')}
                                    {!row.installed && <span className="scope-lamp" />}
                                  </span>
                                  {!row.installed && row.roles.length > 0 && (
                                    <StatusTag kind="warn">{t('skills.row.refWarn', { n: row.roles.length })}</StatusTag>
                                  )}
                                </div>
                              </NavRow>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </State>
      </div>

      {/* v12 F4（W-5）：详情 = **居中弹窗**（`.modal-lg`，宽度 = 与角色/团队同一条 CSS 变量
          `--modal-w`）。选中唯一真相仍是 hash（`#/skills/<name>`）：深链即开、关闭即
          `navigate({ page: 'skills' })` 回列表。未选中 ⇒ 弹窗根本不挂载（纯列表）。
          `swap-in` 的 `key` 仍含 `view`：换技能 / 换视图（详情 ⇄ 有效集）时内容重挂，
          「渲染 | 源码」档位回到默认档——P2 的旧语义一字未改，只是容器从右栏换成了弹窗。
          浮层顺序：详情弹窗在先，装卸 / 删除的 `ConfirmModal` 在后 ⇒ 后者是栈顶，
          一次 Esc 只关它（`overlay-esc.test.ts` 锁的机制未被本批触碰）。 */}
      {key !== '' && (
        <Modal
          size="lg"
          title={<span className="mono">{key}</span>}
          ariaLabel={key}
          onClose={() => navigate({ page: 'skills' })}
        >
          <div className="swap-in skill-detail" key={`${key}|${view}`}>
            {detailPane}
          </div>
        </Modal>
      )}

      {/* S5：卸载 = 统一确认模态（B5：Esc / 遮罩 / 滚动锁 / 焦点 / 危险色全站一套） */}
      {pendingUninstall !== null && (
        <ConfirmModal
          title={t('skills.uninstall.title', { name: pendingUninstall.name })}
          body={<p className="muted">{t('skills.uninstall.body')}</p>}
          busy={busy}
          confirmDisabled={skillsDir === ''}
          onConfirm={() => void uninstall()}
          onCancel={() => setPendingUninstall(null)}
        />
      )}

      {/* F3ui：外部技能删除 = 同一个确认零件（危险色 + 进回收站文案）。
          ⚠ 与上面的卸载模态**不共用** `confirmDisabled` 判据：删除口无 body、目录由服务端解析，
          本页读不到 `skills_dir` 时不该假装这条路走不通（少一个假禁用）。 */}
      {pendingDelete !== null && (
        <ConfirmModal
          title={t('skills.delete.title', { name: pendingDelete })}
          body={<p className="muted">{t('skills.delete.body')}</p>}
          busy={busy}
          error={deleteError}
          onConfirm={() => void removeExternal()}
          onCancel={() => {
            setPendingDelete(null)
            setDeleteError('')
          }}
        />
      )}

      {/* v12 F4（W-6）删除分类 = 同一个确认零件（危险色 + 「组内技能回未分类」文案）。
          删除是**破坏性**动作（分类名从清单消失、组内技能的 mapping 一并清掉），故走确认弹窗；
          界面上它是唯一一处会改分类清单的破坏口。 */}
      {pendingRemoveCategory !== null && (
        <ConfirmModal
          title={t('skills.category.removeTitle', { name: pendingRemoveCategory })}
          body={<p className="muted">{t('skills.category.removeBody')}</p>}
          busy={busy}
          error={removeCategoryError}
          onConfirm={() => void removeCategory()}
          onCancel={() => {
            setPendingRemoveCategory(null)
            setRemoveCategoryError('')
          }}
        />
      )}
    </>
  )
}

/**
 * 技能详情正文（F8 §3.1 三段带）：
 *
 * - **第一眼**：**弹窗**头的名（`h3.mono`，在 `SkillsPage` 的 `<Modal>` 里）+ 描述**直接作为正文**
 *   （`.skill-desc`，`--fs-300`/`--lh-ui`）——§3.4 #6 删「关于」段头：段头的语义是「这段是次要的」，
 *   给第一眼套段头等于把第一眼降级；（W-5：`Pane` 头里那个重复的技能名已删，面板头只留状态与动作位。）
 * - **常用**：未装时的 `.scope-callout`（安装命令 + 口径说明 + 安装按钮、`.cmd-row`）、
 *   宿主状态（`Pane` 头的 `StatusTag`）+ 引用范围（`ScopeLayerRows` 三行）——§3.4 #2 删掉原来的
 *   「引用计数」独立行，计数并入本段 `CountLine`；
 * - **深挖**：`<details class="skill-deep">` 默认折叠，装 SKILL.md 全文 + 安装路径（§3.4 #1/#4）。
 *   档位切换器（`.seg`）随之进折叠，但**行为不变**：`mode` 仍是本组件里那一个 `useState`，
 *   切换仍是原来的 `setMode`，跨技能重置仍由外层 `.swap-in` 的 `key` 决定（P2 旧语义），
 *   本轮只挪位置。（`skills-install-pending.test.ts` 只走安装按钮，未断言档位位置。）
 * - **F3ui 破坏性动作**：`externalRemovable` 时出「删除」（整目录进回收站），否则出既有的
 *   「卸载」——**二选一**，不是并排两个按钮：同一条目录上两者的语义互斥（卸载只清 Prism 产物，
 *   对外部技能恒 `kept`），并排只会让用户选错。
 * - **W-7 键盘替代（SPEC-4.7）**：第一眼描述之下一行「分类」下拉——选项 = 未分类（哨兵 `''`，
 *   值即清除档）+ **分类清单全集**（与列表分组的权威源同一条 `GET /api/skills/categories`）。
 *   选中即回调 `onCategorize(值)`（父层走与拖拽同一条 categorize 通道），成功后就地 `feedback`、
 *   失败也在此就地报错（页级提示条会被弹窗盖住）。无鼠标也能完成归类。
 */
function SkillBody({
  detail,
  skillsDir,
  dirMissing,
  busy,
  feedback,
  externalRemovable,
  categories,
  category,
  onCategorize,
  onInstall,
  onAskUninstall,
  onAskDelete,
}: {
  detail: SkillDetail
  skillsDir: string
  dirMissing: boolean
  busy: boolean
  feedback: { kind: string; lines: string[] } | null
  /** 外部可删态（来自 usage 行）：`true` 才把「卸载」换成「删除」。 */
  externalRemovable: boolean
  /** 分类清单全集（权威组集；未分类不在其中，由下拉自带的哨兵项表达）。 */
  categories: string[]
  /** 当前生效分类（未分类 = 哨兵 `''`）——下拉的受控值。 */
  category: string
  /** 选中新分类（未分类 = `''` = 清除）。 */
  onCategorize: (next: string) => void
  onInstall: () => void
  onAskUninstall: () => void
  onAskDelete: () => void
}) {
  const t = useT()
  const [mode, setMode] = useState<'render' | 'source'>('render')
  const parsed = useMemo(() => parseMarkdown(detail.content), [detail.content])
  /* F9-3：详情头描述先剥 frontmatter 块标量标记（`description: >-` 在服务端单行解析下
     会把 `>-` 当值）。剥完为空 ⇒ 与服务端没返回描述同一档，走既有空态文案（`common.unset`），
     而不是渲染一个内容为 `>-` 的伪描述。 */
  const desc = cleanSkillDescription(detail.description)

  return (
    <>
      {/* 第一眼②：描述即正文（不截断——左侧列表的 32 字摘要只是入口，全文落在这里）。 */}
      <div className="skill-desc">{desc !== '' ? desc : t('common.unset')}</div>

      {/* W-7（SPEC-4.7）：无鼠标归类的唯一入口。`<label>` 的 `htmlFor` 指向下拉 —— 点标签即聚焦，
          同时也给屏幕阅读器一个可见标签（不靠 `aria-label` 兜）。控件本身复用全站表单 token
          （`input, select, …` 那条基类规则），这里只补一个与 `.role-filter` 同值的宽度下限。 */}
      <div className="row" style={{ marginTop: 'var(--s-2)' }}>
        <label className="small muted" htmlFor="skill-category-select">
          {t('skills.category.label')}
        </label>
        <select
          id="skill-category-select"
          className="skill-cat-select"
          value={category}
          disabled={busy}
          onChange={(e) => onCategorize(e.target.value)}
        >
          {/* 值 = 哨兵 `''`：服务端「省略 / 空串 = 清除」档，与拖到未分类组同义。 */}
          <option value={UNCATEGORIZED}>{t('skills.uncategorized')}</option>
          {categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {/* S4：未装三件套 —— 可复制命令 + 口径说明 + 安装按钮（F8 §3.1「常用」：命令块放 `.scope-callout`）。 */}
      {!detail.installed && (
        <div className="scope-callout">
          <div className="small muted">{t('skills.install.notByPrism')}</div>
          <CopyCommand command={`prism skill install ${detail.name}`} label={t('skills.install.copy')} />
          <div className="row">
            <button
              type="button"
              className="tool-btn"
              disabled={busy || !skillsDir}
              aria-busy={busy}
              title={dirMissing ? t('skills.dirMissing') : undefined}
              onClick={onInstall}
            >
              {busy ? t('skills.install.busy') : t('skills.install.action')}
            </button>
          </div>
        </div>
      )}
      {dirMissing && <div className="small err-text">{t('skills.dirMissing')}</div>}

      {/* 常用④：宿主状态由 `Pane` 头的 `StatusTag` 表达（§3.1「一行 StatusTag + ScopeLayerRows」），
          原先「宿主」段的两行（状态行重复、计数行与三行同源）整段删除；计数并到这里（§3.4 #2）。 */}
      <CountLine
        label={t('skills.scope')}
        count={t('skills.counts.refs', { roles: detail.roles.length, teams: detail.teams.length })}
        size="section"
      />
      <ScopeLayerRows installed={detail.installed} teams={detail.teams} roles={detail.roles} />

      {/* 卸载是安装的对位动作，留在常用带可见处（不进深挖折叠）。
          F3ui：外部可删技能把这一格换成「删除」（同一位置、同一零件，语义换一条口）。 */}
      {detail.installed && (
        <div className="row" style={{ marginTop: 'var(--s-2)' }}>
          {externalRemovable ? (
            <button type="button" className="tool-btn" disabled={busy} onClick={onAskDelete}>
              {t('skills.delete.action')}
            </button>
          ) : (
            <button type="button" className="tool-btn" disabled={busy || skillsDir === ''} onClick={onAskUninstall}>
              {t('skills.uninstall.action')}
            </button>
          )}
        </div>
      )}

      {/* 深挖⑤（§0.1：默认折叠，summary 一行常驻）：路径（§3.4 #1）+ SKILL.md 全文（§3.4 #4）。 */}
      <details className="skill-deep">
        <summary>{t('skills.deepDive')}</summary>
        <div className="row">
          <span className="small muted">{t('skills.detail.path')}</span>
          <span className="mono small" style={{ wordBreak: 'break-all' }}>{detail.path}</span>
        </div>
        <div className="row" style={{ marginTop: 'var(--s-2)' }}>
          <div className="seg">
            <button type="button" className={mode === 'render' ? 'on' : ''} onClick={() => setMode('render')}>
              {t('skills.view.render')}
            </button>
            <button type="button" className={mode === 'source' ? 'on' : ''} onClick={() => setMode('source')}>
              {t('skills.view.source')}
            </button>
          </div>
        </div>
        {detail.content === '' ? (
          <div className="small muted">{t('skills.detail.bodyUnavailable')}</div>
        ) : mode === 'source' ? (
          <div className="md-source-wrap">
            <pre className="md-source">{detail.content}</pre>
          </div>
        ) : (
          /* S10：frontmatter 结构化 kv + 正文渲染（复用 Markdown） */
          <>
            {parsed.frontmatter !== undefined && (
              <table className="md-frontmatter">
                <tbody>
                  {Object.entries(parsed.frontmatter).map(([k, v]) => (
                    <tr key={k}>
                      <th className="mono">{k}</th>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="md-body md-read">
              <MarkdownBlocks blocks={parsed.blocks} />
            </div>
          </>
        )}
      </details>
      {feedback !== null && (
        <div className="banner small" style={{ marginTop: 'var(--s-2)' }}>
          {feedback.lines.map((line, i) => (
            <div key={i} className={i === 0 ? '' : 'small muted'}>{line}</div>
          ))}
        </div>
      )}
    </>
  )
}
