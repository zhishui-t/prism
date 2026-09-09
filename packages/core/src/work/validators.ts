/**
 * 工作结果校验器（work-queue.md §5）。
 *
 * 约定：返回 `null` 表示通过，返回字符串表示失败原因。
 * Prism 只做**结构与数值合法性**校验，不判断内容质量（那要 LLM，Prism 不调）。
 */
import type { WorkKind, WorkResultValidator } from './work-queue.js'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** embed：`{ vector: number[] }`，维度正确、数值有限。 */
export const validateEmbed: WorkResultValidator = (_payload, result) => {
  if (!isRecord(result)) return '结果必须是对象'
  const vector = result['vector']
  if (!Array.isArray(vector)) return '缺少 vector 数组'
  if (vector.length === 0) return 'vector 不能为空'
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `vector[${i}] 不是有限数值`
    }
  }
  const dim = _payload !== null && isRecord(_payload) ? _payload['dim'] : undefined
  if (typeof dim === 'number' && dim > 0 && vector.length !== dim) {
    return `vector 维度不符：期望 ${dim}，实际 ${vector.length}`
  }
  return null
}

/** summarize：`{ summary: string }`，非空。 */
export const validateSummarize: WorkResultValidator = (_payload, result) => {
  if (!isRecord(result)) return '结果必须是对象'
  const summary = result['summary']
  if (typeof summary !== 'string' || summary.trim() === '') return '缺少非空 summary'
  return null
}

/** classify：`{ labels: string[] }`，非空字符串数组。 */
export const validateClassify: WorkResultValidator = (_payload, result) => {
  if (!isRecord(result)) return '结果必须是对象'
  const labels = result['labels']
  if (!Array.isArray(labels)) return '缺少 labels 数组'
  for (const label of labels) {
    if (typeof label !== 'string' || label.trim() === '') return 'labels 元素必须是非空字符串'
  }
  return null
}

/** extract_entities：`{ entities: [{id,type,label?}], relations?: [{from,to,relation}] }`。 */
export const validateExtractEntities: WorkResultValidator = (_payload, result) => {
  if (!isRecord(result)) return '结果必须是对象'
  const entities = result['entities']
  if (!Array.isArray(entities)) return '缺少 entities 数组'
  for (const entity of entities) {
    if (!isRecord(entity)) return 'entities 元素必须是对象'
    if (typeof entity['id'] !== 'string' || entity['id'].trim() === '') return 'entity.id 必填'
    if (typeof entity['type'] !== 'string' || entity['type'].trim() === '') return 'entity.type 必填'
  }
  const relations = result['relations']
  if (relations !== undefined) {
    if (!Array.isArray(relations)) return 'relations 必须是数组'
    for (const rel of relations) {
      if (!isRecord(rel)) return 'relations 元素必须是对象'
      if (typeof rel['from'] !== 'string' || rel['from'].trim() === '') return 'relation.from 必填'
      if (typeof rel['to'] !== 'string' || rel['to'].trim() === '') return 'relation.to 必填'
      if (typeof rel['relation'] !== 'string' || rel['relation'].trim() === '') {
        return 'relation.relation 必填'
      }
    }
  }
  return null
}

/** diagram_ir：`{ diagram_type, ...结构数组 }`（Archify IR 最小结构；完整校验交给 archify validate）。 */
export const validateDiagramIr: WorkResultValidator = (_payload, result) => {
  if (!isRecord(result)) return '结果必须是对象'
  const type = result['diagram_type']
  const allowed = ['architecture', 'sequence', 'lifecycle', 'dataflow', 'workflow']
  if (typeof type !== 'string' || !allowed.includes(type)) {
    return `diagram_type 必须为 ${allowed.join('/')}`
  }
  const meta = result['meta']
  if (!isRecord(meta) || typeof meta['title'] !== 'string' || meta['title'].trim() === '') {
    return 'meta.title 必填'
  }
  return null
}

/** 内置校验器表（WorkQueue 构造后按 kind 注册）。 */
export const BUILTIN_VALIDATORS: Record<WorkKind, WorkResultValidator> = {
  embed: validateEmbed,
  summarize: validateSummarize,
  classify: validateClassify,
  extract_entities: validateExtractEntities,
  diagram_ir: validateDiagramIr,
}
