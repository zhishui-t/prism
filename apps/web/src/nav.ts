/**
 * 页面枚举（本仓无路由库，也不引入）。
 *
 * 只列「一级页」；哪些页支持 `#/<page>/<sel>` 深链由 `route.ts` 的 `WITH_SEL` 决定。
 * 任务中心（tasks）已随本轮重设计整体移除，不再是一级页。
 */

export type PageKey = 'knowledge' | 'graph' | 'projects' | 'roles' | 'teams' | 'skills'
