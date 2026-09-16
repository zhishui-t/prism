/**
 * 团队页（T5 拆分）：左列表 + 过滤 + 提示条 + 右侧详情挂载 + 表单抽屉。
 *
 * 选中**只有一个真相**：hash `#/teams/<id>`（`sel`），列表高亮由它派生。
 * 注意：**抽屉的 create/edit 意图是另一件事**（`formIntent`），与 `sel` 无关——
 * 选中某团队时点「+ 新建团队」仍是新建（R-8-4）。
 * 列表行是 `<NavRow>`（`<a href>`，B6）——键盘 / 中键 / 复制深链都通，不再靠改 hash 的按钮；
 * `onSelect` 因此只剩两件**程序化**的事：深链失效时清空（`''`）、创建成功后落选中（`pendingSelect`）。
 * 抽屉的**关闭**只有 `closeForm()` 一个出口（Esc / 遮罩 / 头部关闭钮 / 表单取消钮都走到它），
 * 冲刷 `pendingSelect` 就在那里——见其上的注记（M3）。
 */

import { useEffect, useState } from 'react'

import { teamApi } from '../../api-team.ts'
import { NavRow } from '../../components/NavRow.tsx'
import { State } from '../../components/State.tsx'
import { useAsync } from '../../components/useAsync.ts'
import { Drawer, PageHead, Pane, StatusTag, firstSentence } from '../../components/ui.tsx'
import { useT } from '../../i18n.ts'
import { hrefOf } from '../../route.ts'
import { TeamDetail } from './TeamDetail.tsx'
import { TeamForm } from './TeamForm.tsx'

export function TeamsPage({
  sel,
  onSelect,
  onOpenUsageSkills,
}: {
  /** 当前展开的团队（来自 hash 深链） */
  sel?: string
  onSelect?: (id: string) => void
  /** 跳到技能页看反向视图（页级导航） */
  onOpenUsageSkills?: () => void
} = {}) {
  const t = useT()
  const teams = useAsync(() => teamApi.teams(), [])
  const [filter, setFilter] = useState('')
  /**
   * 抽屉**意图**（R-8-4）：`create` / `edit` 分状态，`null` = 抽屉关闭。
   *
   * 此前是一个 `formOpen` 布尔被两个入口共用，抽屉里该开哪种表单只能猜「当前有没有选中」
   * ——于是选中某团队（`#/teams/<id>`）时点页头「+ 新建团队」，开出的是**编辑表单**。
   * 意图与选中是两件事：新建不因「恰好选中了某团队」而变成编辑。
   */
  const [formIntent, setFormIntent] = useState<null | 'create' | 'edit'>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** R-6 Q1：创建成功后**先不切选中**（否则抽屉会从「新建」翻成「编辑」，就地反馈被顶掉），
   *  记下 id，等抽屉关闭再落选中。**写入只有 `onCreated`、消费只有 `closeForm()`，消费即清。** */
  const [pendingSelect, setPendingSelect] = useState('')

  const selected = sel ?? ''
  const detail = useAsync(
    () => (selected !== '' ? teamApi.team(selected) : Promise.resolve(undefined)),
    [selected],
  )

  // T8：角色库**首屏就拉**——列表页要在角色库缺失/失败时显式提示（原先只在打开表单时拉）
  const roleIndex = useAsync(() => teamApi.roles(), [])
  const rolesMissing =
    roleIndex.data !== undefined && roleIndex.data.roles.length === 0 && !roleIndex.loading
  const rolesBroken = roleIndex.error !== undefined

  const list = teams.data?.teams ?? []
  const teamsDir = teams.data?.teamsDir

  /**
   * 写操作统一出口（**非表单类**：删除 / 详情页动作）——反馈落列表提示条。
   * R-6 Q1：表单的保存/失败反馈**不再走这里**（改由 TeamForm 就地渲染，见下）。
   */
  const afterWrite = (kind: 'ok' | 'err', text: string, opts: { close?: boolean } = {}) => {
    setBanner({ kind, text })
    teams.reload()
    detail.reload()
    if (opts.close === true) onSelect?.('')
  }

  /**
   * 关闭表单抽屉的**唯一出口**：意图复位 + 冲刷 `pendingSelect`。
   *
   * R-6 Q1 的既有语义（「意图 ≠ 选中」）保持不变：创建成功后**先不切选中**（否则抽屉会从
   * 「新建」翻成「编辑」，就地反馈被顶掉），id 记在 `pendingSelect`，等抽屉关闭再落选中。
   *
   * 收敛成一处的原因（M3）：此前冲刷只挂在 `Drawer.onClose` 上，而 `TeamForm` 自带取消钮
   * 直接 `setFormIntent(null)`——① 走那条路就**丢选中**；② 且 `pendingSelect` 残留不消费，
   * 之后任何一次无关关闭（如 Esc）会突然跳到上次创建的 id。所以：
   * **任何关闭路径都必须走这里，别处不得再直接 `setFormIntent(null)`**；
   * `pendingSelect` 的写入点只有一处（`onCreated`）、消费点也只有这一处（消费即清）。
   */
  const closeForm = () => {
    setFormIntent(null)
    if (pendingSelect !== '') {
      onSelect?.(pendingSelect)
      setPendingSelect('')
    }
  }

  useEffect(() => {
    // 列表刷新后，深链指向的团队已不存在 → 收起详情（不留空壳）。
    // ⚠ 再加 `!teams.loading`（M3 断裂③）：`reload()` 在途时 `teams.data` 还是**旧列表**
    // （刚创建的团队尚未出现），此时不得拿旧列表把刚落下的选中清掉；数据落定后本 effect
    // 会随 `teams.data` 重跑，届时列表已含新 id，自然不清。
    // ⚠ 再加 `teams.error === undefined`（复检 MINOR-①）：reload **失败**时 `teams.data`
    // 停在旧列表（useAsync 出错只 setError、不 setData），同样会把刚落的选中误清——
    // 失败不是「深链失效」的证据，选中保持不动，等下一次成功 reload 再判定。
    if (
      !teams.loading &&
      teams.error === undefined &&
      selected !== '' &&
      teams.data !== undefined &&
      !list.some((x) => x.team_id === selected)
    ) {
      onSelect?.('')
    }
  }, [teams.data, teams.loading, teams.error, selected, list, onSelect])

  const keyword = filter.trim().toLowerCase()
  const shown =
    keyword === ''
      ? list
      : list.filter(
          (x) =>
            x.name.toLowerCase().includes(keyword) ||
            x.team_id.toLowerCase().includes(keyword) ||
            x.description.toLowerCase().includes(keyword),
        )

  return (
    <>
      <PageHead title={t('teams.title')} sub={t('teams.desc')}>
        <button
          className="primary"
          onClick={() => {
            setFormIntent('create')
            setBanner(null)
          }}
        >
          {t('teams.new')}
        </button>
      </PageHead>

      {banner !== null && (
        <div className="banner">
          <StatusTag kind={banner.kind === 'ok' ? 'ok' : 'err'}>
            {banner.kind === 'ok' ? t('common.save') : t('status.failed')}
          </StatusTag>
          <span className="small">{banner.text}</span>
        </div>
      )}

      {/* T8：角色库缺失/失败 → 列表页级 lamp 提示条 + 重试（与表单内重试共用同一状态源 roleIndex） */}
      {(rolesBroken || rolesMissing) && (
        <div className="banner lamp">
          <span className="scope-lamp" />
          <span className="small">
            {rolesBroken ? t('teams.rolesFailed', { msg: roleIndex.error ?? '' }) : t('teams.rolesEmpty')}
          </span>
          <button className="rel-link" onClick={roleIndex.reload}>
            {t('common.retry')}
          </button>
        </div>
      )}

      <State
        loading={teams.loading}
        error={teams.error}
        empty={!teams.loading && !teams.error && list.length === 0}
        emptyText={t('teams.empty')}
      >
        <div className="md">
          <div className="md-list">
            <div style={{ padding: 'var(--s-1) var(--s-1) var(--s-2)' }}>
              <input
                style={{ width: '100%' }}
                placeholder={t('teams.filterPlaceholder')}
                aria-label={t('teams.filterPlaceholder')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {shown.length === 0 && (
              <div className="small muted" style={{ padding: 'var(--s-2)' }}>
                {t('common.empty')}
              </div>
            )}
            {shown.map((team) => (
              <NavRow
                key={team.team_id}
                href={hrefOf({ page: 'teams', sel: team.team_id })}
                selected={selected === team.team_id}
                /* 导航靠 href（键盘 / 中键 / 复制深链都通）；onClick 只清上一次的写操作提示条 */
                onClick={() => setBanner(null)}
              >
                <span className="t">
                  {team.name}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {team.team_id}
                  </span>
                </span>
                {team.description !== '' && <span className="s">{firstSentence(team.description, 76)}</span>}
                <span className="tags">
                  {team.default && <StatusTag kind="ok">{t('teams.default')}</StatusTag>}
                  <StatusTag kind="info">{t('teams.membersCount', { n: team.members.length })}</StatusTag>
                  <StatusTag kind="info">{t('teams.stages', { n: team.workflow.length })}</StatusTag>
                </span>
              </NavRow>
            ))}
          </div>

          {/* v7.1 P2：换团队时右栏**轻过渡**（纯 opacity，`key` 让动画随换选中重放）。 */}
          <div className="md-detail">
            <div className="swap-in" key={selected}>
              {selected === '' ? (
                <Pane>
                  <div className="small muted">{t('teams.selectHint')}</div>
                </Pane>
              ) : (
                <TeamDetail
                  key={selected}
                  id={selected}
                  detail={detail.data}
                  loading={detail.loading}
                  error={detail.error}
                  teamsDir={teamsDir}
                  onOpenUsage={onOpenUsageSkills}
                  onEdit={() => setFormIntent('edit')}
                  onDeleted={(text) => afterWrite('ok', text, { close: true })}
                />
              )}
            </div>
          </div>
        </div>
      </State>

      {formIntent !== null && (
        <Drawer
          title={formIntent === 'edit' ? `${t('teams.form.edit')} › ${selected}` : t('teams.form.new')}
          onClose={closeForm}
        >
          {formIntent === 'edit' &&
            (detail.data === undefined ? (
              // R-8-4：编辑意图下详情尚未就绪 → **显式占位**。绝不静默落进 create 分支
              // （那正是本 bug 的镜像面：编辑意图被悄悄换成空的新建表单，用户以为在改、其实在建）。
              <State loading />
            ) : (
              <TeamForm
                mode="edit"
                team={detail.data}
                roles={roleIndex.data?.roles ?? []}
                rolesLoading={roleIndex.loading}
                rolesError={roleIndex.error}
                onReloadRoles={roleIndex.reload}
                rolesDir={roleIndex.data?.rolesDir}
                defaultTeamsDir={teamsDir}
                onCancel={closeForm}
                onSaved={() => {
                  // R-6 Q1：保存成功**不关抽屉**——文案与 warning 由 TeamForm 就地渲染，只刷新数据
                  teams.reload()
                  detail.reload()
                }}
              />
            ))}
          {formIntent === 'create' && (
            <TeamForm
              mode="create"
              roles={roleIndex.data?.roles ?? []}
              rolesLoading={roleIndex.loading}
              rolesError={roleIndex.error}
              onReloadRoles={roleIndex.reload}
              existingIds={list.map((x) => x.team_id)}
              defaultTeamsDir={teamsDir}
              onCancel={closeForm}
              onCreated={(id) => {
                // R-6 Q1：结果就地留在抽屉内 → 不关抽屉、不立刻切选中（见 pendingSelect）
                teams.reload()
                setPendingSelect(id)
              }}
            />
          )}
        </Drawer>
      )}
    </>
  )
}
