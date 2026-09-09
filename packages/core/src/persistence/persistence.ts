import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { prismPaths } from '../config/paths.js'
import { PrismDatabase } from './prism-database.js'
import { SingleWriterQueue } from './single-writer-queue.js'
import { DEFAULT_SCHEMAS } from './schemas.js'

export interface PersistenceOptions {
  /** Prism 主目录；不传取 PRISM_HOME 或 ~/.prism */
  home?: string
  /** state 子目录；不传取 <home>/state */
  stateDir?: string
  /** true 时所有库使用 ':memory:'，不做任何落盘（测试隔离） */
  inMemory?: boolean
}

/**
 * PrismPersistence — 按域管理 3 个 SQLite 库：
 * tasks.db / core.db / knowledge.db，全部开启 WAL 并通过同一个
 * SingleWriterQueue 串行化写操作。
 */
export class PrismPersistence {
  readonly stateDir: string
  readonly inMemory: boolean
  /** 全局单写者：所有库的写操作共享同一队列串行化 */
  readonly queue = new SingleWriterQueue()

  readonly tasks: PrismDatabase
  readonly core: PrismDatabase
  readonly knowledge: PrismDatabase

  constructor(options: PersistenceOptions = {}) {
    this.inMemory = options.inMemory ?? false
    this.stateDir = this.inMemory ? ':memory:' : (options.stateDir ?? prismPaths(options.home).stateDir)
    if (!this.inMemory) {
      mkdirSync(this.stateDir, { recursive: true })
    }

    const pathFor = (file: string): string =>
      this.inMemory ? ':memory:' : join(this.stateDir, file)

    const dbOptions = { queue: this.queue }
    this.tasks = new PrismDatabase({
      ...dbOptions,
      path: pathFor('tasks.db'),
      schema: DEFAULT_SCHEMAS.tasks,
    })
    this.core = new PrismDatabase({
      ...dbOptions,
      path: pathFor('core.db'),
      schema: DEFAULT_SCHEMAS.core,
    })
    this.knowledge = new PrismDatabase({
      ...dbOptions,
      path: pathFor('knowledge.db'),
      schema: DEFAULT_SCHEMAS.knowledge,
    })
  }

  get dbs(): PrismDatabase[] {
    return [this.tasks, this.core, this.knowledge]
  }

  close(): void {
    for (const db of this.dbs) {
      db.close()
    }
  }
}

/** 便捷入口：openPersistence({ home }) / openPersistence({ inMemory: true }) */
export const openPersistence = (options?: PersistenceOptions): PrismPersistence =>
  new PrismPersistence(options)
