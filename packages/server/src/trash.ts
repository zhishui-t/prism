/**
 * 回收站装配点（v9 F3）。
 *
 * 三入口（MCP / HTTP / CLI）删除角色、团队、Skill 时共用本函数构造 `TrashStore`——
 * 单一真相源，避免三处各自拼 `<home>/trash` 与审计目录（v9.1 I-2/I-3）。
 *
 * **归属纪律**：`trashDir` 与 `AuditLog` 一律由调用方给出的 `home` 推导。
 * `home` 在 CLI 是 `ctx.home`（`--home`）、在 server 是 `AppOptions.home`/`McpDeps.home`，
 * 测试传临时目录——绝不落默认 `~/.prism`（红线 R5/R6；审计口径同 `cli/commands/audit.ts`）。
 */
import { AuditLog, TrashStore, prismPaths } from '@prism/core'

/** 按 `home` 构造回收站（搬移 + 审计单点）。 */
export function trashStoreFor(home: string): TrashStore {
  const paths = prismPaths(home)
  return new TrashStore({
    trashDir: paths.trashDir,
    audit: new AuditLog({ dir: paths.auditDir }),
  })
}
