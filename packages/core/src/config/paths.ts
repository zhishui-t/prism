import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Prism 本地状态根目录。所有持久化数据默认落在 ~/.prism 之下，
 * 全部可通过环境变量 PRISM_HOME 覆盖（便于测试隔离与多实例部署）。
 */
export const DEFAULT_PRISM_HOME = join(homedir(), '.prism')

/** 解析 Prism 主目录（环境变量优先）。 */
export function prismHome(): string {
  return process.env.PRISM_HOME ?? DEFAULT_PRISM_HOME
}

export interface PrismPaths {
  home: string
  stateDir: string
  auditDir: string
  knowledgeDir: string
  teamsDir: string
  skillsDir: string
  graphDir: string
}

/** 解析全部子目录路径（均位于 home 之下，可整体迁移）。 */
export function prismPaths(home: string = prismHome()): PrismPaths {
  return {
    home,
    stateDir: join(home, 'state'),
    auditDir: join(home, 'audit'),
    knowledgeDir: join(home, 'knowledge'),
    teamsDir: join(home, 'teams'),
    skillsDir: join(home, 'skills'),
    graphDir: join(home, 'graph'),
  }
}
