import type { DatabaseSync } from 'node:sqlite'

import type { DatabaseSchema, DatabaseSchemaStatement } from './prism-database.js'

/** 各库基础结构版本（写入 PRAGMA user_version）。 */
export const DEFAULT_SCHEMA_VERSION = 1

/** tasks.db 版本：v3 起任务携带 write_scopes + revision/attempt_token。 */
export const TASKS_SCHEMA_VERSION = 3

/** core.db 版本：v2 起注册 team_bindings；v3 起 executor_children。 */
export const CORE_SCHEMA_VERSION = 3

/** knowledge.db 版本：v1 起含条目/边/工作请求等表；v2 补 owner 列；v3 补 origin；v4 补 source_hash；v5 补 kb_vectors（本地向量）；v6 补 kb_vectors.model（分档）。 */
export const KNOWLEDGE_SCHEMA_VERSION = 6

// ===== tasks.db =====

export const TASKS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    dag_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    description TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT '',
    dependencies TEXT DEFAULT '[]',
    write_scopes TEXT DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 0,
    attempt_token TEXT,
    assigned_agent TEXT,
    executor TEXT,
    status TEXT NOT NULL,
    revision_count INTEGER DEFAULT 0,
    max_revisions INTEGER DEFAULT 5,
    feedback_timeout_seconds INTEGER DEFAULT 1800,
    feedback_expires_at TEXT,
    skip_override INTEGER DEFAULT 0,
    skip_reason TEXT,
    fail_count INTEGER DEFAULT 0,
    result TEXT,
    error_type TEXT,
    created_at TEXT,
    updated_at TEXT
)`

export const TASKS_V3_ADD_WRITE_SCOPES: DatabaseSchemaStatement = {
  sql: "ALTER TABLE tasks ADD COLUMN write_scopes TEXT NOT NULL DEFAULT '[]'",
  when: (db: DatabaseSync): boolean => !taskColumns(db).includes('write_scopes'),
}

export const TASKS_V3_ADD_REVISION: DatabaseSchemaStatement = {
  sql: 'ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0',
  when: (db: DatabaseSync): boolean => !taskColumns(db).includes('revision'),
}

export const TASKS_V3_ADD_ATTEMPT_TOKEN: DatabaseSchemaStatement = {
  sql: 'ALTER TABLE tasks ADD COLUMN attempt_token TEXT',
  when: (db: DatabaseSync): boolean => !taskColumns(db).includes('attempt_token'),
}

function taskColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
    (column) => column.name,
  )
}

export const DAGS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS dags (
    dag_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`

export const EDGES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS edges (
    dag_id TEXT NOT NULL,
    from_task_id TEXT NOT NULL,
    to_task_id TEXT NOT NULL,
    PRIMARY KEY (dag_id, from_task_id, to_task_id)
)`

// ===== core.db =====

export const TASK_SEQUENCES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS task_sequences (
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    next_n INTEGER DEFAULT 1,
    PRIMARY KEY (project_id, version)
)`

export const BANS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS bans (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    reason TEXT,
    failed_count INTEGER DEFAULT 0,
    banned_at TEXT NOT NULL,
    expiry TEXT,
    cooldown_seconds INTEGER DEFAULT 0,
    state TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(scope, entity_key)
)`

export const FAILURE_COUNTERS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS failure_counters (
    entity_key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    updated_at TEXT
)`

export const TEAM_BINDINGS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS team_bindings (
    session_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`

export const EXECUTOR_CHILDREN_TABLE_DDL = `CREATE TABLE IF NOT EXISTS executor_children (
    session_key TEXT PRIMARY KEY,
    executor TEXT NOT NULL,
    child_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`

// ===== knowledge.db（Prism 知识库核心）=====

/**
 * 知识条目元数据。
 * 正文落磁盘 Markdown（文件为真相）；本表是索引与状态（数据库为器）。
 * 版次制：同一 (id) 可有多行，以 (id, version) 唯一，is_latest 标记最新版。
 */
export const KNOWLEDGE_ENTRIES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS knowledge_entries (
    id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_latest INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    layer TEXT NOT NULL,
    owner TEXT,
    book TEXT NOT NULL,
    module TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'low',
    confidence REAL NOT NULL DEFAULT 0.5,
    freshness REAL NOT NULL DEFAULT 1.0,
    visibility TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    overrides TEXT NOT NULL DEFAULT '[]',
    supersedes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
)`

/**
 * v2 存量库补 owner 列（Z1）：owner 原为「路径段反解」的隐式约定，路径一变即失准；
 * 落为显式列后读取优先取列，`ownerFromPath` 仅作老库/兜底。
 */
/**
 * 知识条目向量（变更 2：Prism 内置 embedding；分档见 embedding-models.ts）。
 * entry_id + version 主键：新版次覆盖旧向量；vec 为 little-endian float32 BLOB。
 * `model` 记录产出该向量的模型 id——**不同模型的向量不可比**（即便同维），
 * 检索只比同模型向量，换档后旧向量自然被排除、由 reindex 重算。
 * 检索为混合排序（BM25 + 余弦 RRF 融合），条目量数千级全表扫足够（更大规模再上 sqlite-vec）。
 */
export const KB_VECTORS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS kb_vectors (
    entry_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT 'bge-m3-q8',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, version)
)`

/**
 * v6 补 `model` 列：历史向量都是 BGE-M3 产出，DEFAULT 即把它们正确归类，
 * 无需清库、无感迁移。
 */
export const KB_VECTORS_V6_ADD_MODEL: DatabaseSchemaStatement = {
  sql: "ALTER TABLE kb_vectors ADD COLUMN model TEXT NOT NULL DEFAULT 'bge-m3-q8'",
  when: (db: DatabaseSync): boolean => !kbVectorColumns(db).includes('model'),
}

function kbVectorColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(kb_vectors)').all() as Array<{ name: string }>).map(
    (r) => r.name,
  )
}

export const KNOWLEDGE_V2_ADD_OWNER: DatabaseSchemaStatement = {
  sql: 'ALTER TABLE knowledge_entries ADD COLUMN owner TEXT',
  when: (db: DatabaseSync): boolean => !knowledgeEntryColumns(db).includes('owner'),
}

/**
 * v3 补 `origin` 列（design-knowledge-model-v1 §2）：区分两类知识。
 * - `owned`（默认）：宿主抽取/人工落库，**Prism 落盘是真相**，走版次制；
 * - `indexed`：项目里的文档（md/docx/pdf…），**项目文件是真相**，Prism 只存索引，
 *   不写副本、不递增版次，`path` 指向项目原件。
 * 存量行补默认值 `owned`（老数据全是自有型）。
 */
export const KNOWLEDGE_V3_ADD_ORIGIN: DatabaseSchemaStatement = {
  sql: "ALTER TABLE knowledge_entries ADD COLUMN origin TEXT NOT NULL DEFAULT 'owned'",
  when: (db: DatabaseSync): boolean => !knowledgeEntryColumns(db).includes('origin'),
}

/**
 * v4 补 `source_hash` 列（design-knowledge-model-v1 §5-4）：引用型条目记录**源文件**
 * 的内容哈希，用于漂移检测（源变了 → 标 stale 并重新入队）。自有型为空。
 */
export const KNOWLEDGE_V4_ADD_SOURCE_HASH: DatabaseSchemaStatement = {
  sql: 'ALTER TABLE knowledge_entries ADD COLUMN source_hash TEXT',
  when: (db: DatabaseSync): boolean => !knowledgeEntryColumns(db).includes('source_hash'),
}

function knowledgeEntryColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(knowledge_entries)').all() as Array<{ name: string }>).map(
    (column) => column.name,
  )
}

/** 全局唯一关系边表（图书馆公理：单一边表 + 多视图）。 */
export const KNOWLEDGE_EDGES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS knowledge_edges (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'EXTRACTED',
    weight REAL NOT NULL DEFAULT 1.0,
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, relation)
)`

/** 授权记录已废弃——Prism 不做审核（需求 v0.4 D3/D6）。保留占位说明，不再建表。 */

/** 书/模块结构固化（D2：自动建议 + 人工固化）。 */
export const BOOK_STRUCTURES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS book_structures (
    layer TEXT NOT NULL,
    book TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    modules TEXT NOT NULL DEFAULT '[]',
    suggested TEXT NOT NULL DEFAULT '[]',
    frozen_at TEXT,
    confirmed_by TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (layer, book)
)`

/** 导入任务（控制台/agent 导入管线）。 */
export const IMPORT_JOBS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS import_jobs (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploaded',
    markdown_path TEXT,
    converted_title TEXT,
    converted_body TEXT,
    target_layer TEXT NOT NULL,
    target_book TEXT NOT NULL,
    target_module TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL,
    candidate_id TEXT,
    error_message TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`

/** 冲突检测结果（层间冲突：就近覆盖 + 显式 overrides）。 */
export const KNOWLEDGE_CONFLICTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS knowledge_conflicts (
    id TEXT PRIMARY KEY,
    high_id TEXT NOT NULL,
    low_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    detected_at TEXT NOT NULL
)`

/** 全部表 DDL 索引：表名 → 建表语句。 */
export const CORE_TABLE_DDL: Record<string, string> = {
  tasks: TASKS_TABLE_DDL,
  dags: DAGS_TABLE_DDL,
  edges: EDGES_TABLE_DDL,
  task_sequences: TASK_SEQUENCES_TABLE_DDL,
  bans: BANS_TABLE_DDL,
  failure_counters: FAILURE_COUNTERS_TABLE_DDL,
  team_bindings: TEAM_BINDINGS_TABLE_DDL,
  executor_children: EXECUTOR_CHILDREN_TABLE_DDL,
  knowledge_entries: KNOWLEDGE_ENTRIES_TABLE_DDL,
  knowledge_edges: KNOWLEDGE_EDGES_TABLE_DDL,
  book_structures: BOOK_STRUCTURES_TABLE_DDL,
  import_jobs: IMPORT_JOBS_TABLE_DDL,
  knowledge_conflicts: KNOWLEDGE_CONFLICTS_TABLE_DDL,
}

/**
 * 按域拆分到 3 个库文件：
 * tasks.db（任务与 DAG）/ core.db（团队、熔断、序号）/ knowledge.db（知识库与工作队列）
 */
export const DEFAULT_SCHEMAS: Record<'tasks' | 'core' | 'knowledge', DatabaseSchema> = {
  tasks: {
    version: TASKS_SCHEMA_VERSION,
    statements: [
      TASKS_TABLE_DDL,
      DAGS_TABLE_DDL,
      EDGES_TABLE_DDL,
      TASKS_V3_ADD_WRITE_SCOPES,
      TASKS_V3_ADD_REVISION,
      TASKS_V3_ADD_ATTEMPT_TOKEN,
    ],
  },
  core: {
    version: CORE_SCHEMA_VERSION,
    statements: [
      TASK_SEQUENCES_TABLE_DDL,
      BANS_TABLE_DDL,
      FAILURE_COUNTERS_TABLE_DDL,
      TEAM_BINDINGS_TABLE_DDL,
      EXECUTOR_CHILDREN_TABLE_DDL,
    ],
  },
  knowledge: {
    version: KNOWLEDGE_SCHEMA_VERSION,
    statements: [
      KNOWLEDGE_ENTRIES_TABLE_DDL,
      KNOWLEDGE_EDGES_TABLE_DDL,
      BOOK_STRUCTURES_TABLE_DDL,
      IMPORT_JOBS_TABLE_DDL,
      KNOWLEDGE_CONFLICTS_TABLE_DDL,
      KNOWLEDGE_V2_ADD_OWNER,
      KNOWLEDGE_V3_ADD_ORIGIN,
      KNOWLEDGE_V4_ADD_SOURCE_HASH,
      KB_VECTORS_TABLE_DDL,
      KB_VECTORS_V6_ADD_MODEL,
    ],
  },
}
