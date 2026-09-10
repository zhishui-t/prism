/**
 * 极简页内导航意图（本仓无路由库，也不引入）。
 *
 * Shell 持有「当前页 + 目标实体」；页面据此展开对应详情（有效集的正向/反向视图互链）。
 * 不写 URL、不做浏览器历史——故意保持最小。
 */

export type PageKey = 'knowledge' | 'graph' | 'projects' | 'roles' | 'teams' | 'skills' | 'tasks'

export interface NavTarget {
  page: PageKey
  /** 目标角色：roles 页展开该角色详情（有效集按角色计算） */
  role?: string
  /** 目标团队：teams 页展开该团队详情 */
  team?: string
}
