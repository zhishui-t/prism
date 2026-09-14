/**
 * archify IR 的**公共类型**（生成器之间共享，避免各写一份）。
 *
 * 只覆盖生成器实际用到的部分：五类图的 IR 结构差异很大，这里只放
 * 跨类型复用的枚举与元信息，具体结构由各自生成器定义（并由 `arch schema`
 * 打印的 JSON Schema 作为唯一权威契约）。
 */

/**
 * archify `common.schema.json#/$defs/componentType` 的 7 值枚举。
 * `workflow` / `architecture` / `sequence` / `dataflow` 四类图共用。
 */
export type ArchifyComponentType =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'cloud'
  | 'security'
  | 'messagebus'
  | 'external'

/** 所有图共有的 `meta`（schema 对 `meta` 是 `additionalProperties: false`，加不了自定义键）。 */
export interface ArchifyMeta {
  title: string
  subtitle?: string
}
