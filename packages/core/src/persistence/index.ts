export { SingleWriterQueue } from './single-writer-queue.js'
export {
  PrismDatabase,
  type DatabaseSchema,
  type DatabaseSchemaStatement,
  type PrismDatabaseOptions,
  type TableColumnInfo,
} from './prism-database.js'
export {
  DEFAULT_SCHEMAS,
  DEFAULT_SCHEMA_VERSION,
  CORE_SCHEMA_VERSION,
  KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_ENTRIES_TABLE_DDL,
  KNOWLEDGE_EDGES_TABLE_DDL,
  KNOWLEDGE_V2_ADD_OWNER,
  BOOK_STRUCTURES_TABLE_DDL,
  KNOWLEDGE_CONFLICTS_TABLE_DDL,
} from './schemas.js'
export {
  PrismPersistence,
  openPersistence,
  type PersistenceOptions,
} from './persistence.js'
