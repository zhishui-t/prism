/**
 * Harness 适配器接口（harness-adapters.md §3）。
 *
 * **接口下沉到 core 的原因（design-v3 §2 P7 修订）**：skills 与 agents 两个包
 * 都要消费适配器约定（如 `skill.nativeDir` / `agent.globalDir`），而二者互不依赖、
 * 只共同依赖 core——故接口放 core，实现（ZCodeAdapter）留在 agents 包。
 *
 * 本文件只声明**接口与纯数据约定**，不引入 RoleDefinition / TeamDefinition 等
 * 上层类型（core 是依赖图最底层）；角色/团队类型通过泛型参数注入。
 */

/** agent 定义约定（字段级抽象，harness §3.2）。 */
export interface AgentConvention {
  /** 全局角色目录（如 ~/.zcode/agents）。 */
  globalDir: string
  /** 项目级覆盖目录（如 <repo>/.zcode/agents），不支持则 null。 */
  projectDir: string | null
  /** 角色文件名模式（如 '<role>.md'）。 */
  filePattern: string
  /** 团队定义目录（宿主根下独立于 agent 扫描路径，如 ~/.zcode/teams）。 */
  teamDir: string | null
  /** 该 harness 支持的 frontmatter 字段集；Prism 扩展不得越界（扩展一律放正文）。 */
  frontmatterFields: readonly string[]
  /** 正文约定首节标题（如 '## 核心契约'）。 */
  bodyConvention: string
  /** 激活时机：写入后何时生效。 */
  activation: 'session-start' | 'immediate' | 'restart' | 'unknown'
  /** 名字与文件名是否必须一致。 */
  nameMustMatchFile: boolean
}

/** 子 agent 派发约定（只读描述，Prism 不实现派发）。 */
export interface DispatchConvention {
  mechanism: string
  /** 兜底派发方式（如 'general-purpose + 契约粘入 prompt'）。 */
  fallback?: string
}

/** 模型声明约定（只读描述，Prism 不判断模型能力）。 */
export interface ModelConvention {
  declarable: boolean
  /** 内置角色模型覆盖配置的落点（无则 null）。 */
  overridePath: string | null
  format: 'vendor-id' | 'model-id' | 'alias'
  capabilitySource: 'host-config' | 'unknown'
}

/** Skill 约定（skills 包按 `nativeDir` 决定安装目录，不硬编码路径）。 */
export interface SkillConvention {
  /** Skill 安装目录（如 ~/.zcode/skills），不支持则 null。 */
  nativeDir: string | null
  /** 生态共享目录（如 ~/.agents/skills），可选。 */
  ecosystemDir: string | null
  /** Skill 文件格式（如 'SKILL.md'）。 */
  format: string
  /** 宿主是否支持 Skill（不支持则走上下文注入）。 */
  supported: boolean
}

/** 指令文件约定。 */
export interface InstructionsConvention {
  file: string
  projectFile: string
}

/** 宿主在位探测结果（只读：查配置目录，不调宿主）。 */
export type HarnessPresence =
  | { installed: true; configDir: string; version?: string }
  | { installed: false; reason: string }

/** 渲染产物：内容 + 目标路径 + 写入策略（harness §3.1）。 */
export interface RenderedFile {
  /** 目标绝对路径。 */
  path: string
  /** 文件内容。 */
  content: string
  format: 'markdown' | 'json' | 'toml' | 'jsonc'
  /** 写入策略：overwrite=可覆盖 / no-clobber=人写的不动 / merge=合并。 */
  writePolicy: 'overwrite' | 'no-clobber' | 'merge'
  /** 生成标记（用于识别 Prism 产物，安全覆盖）。 */
  marker: string
}

/** Skill 供给结果（harness §3.3）。 */
export type SkillProvisionResult =
  | { mode: 'installed'; path: string }
  | { mode: 'none'; fallback: 'mcp' | 'context-pack' }

/**
 * 宿主适配器：描述某个 harness 的原生约定（只读描述 + 渲染/解析行为）。
 *
 * @typeParam TRole  该 harness 的角色定义类型（agents 包注入 RoleDefinition）
 * @typeParam TTeam  该 harness 的团队定义类型（agents 包注入 TeamDefinition）
 * @typeParam TSkill 该 harness 的 Skill 类型（skills 包注入 PrismSkill 的结构子集）
 */
export interface HarnessAdapter<TRole = unknown, TTeam = unknown, TSkill = unknown> {
  readonly id: string
  readonly displayName: string

  /**
   * 本 harness 的默认根目录（如 ZCode 的 `~/.zcode`）。
   * 目录布局（角色/团队/Skill 落点）全部由适配器按此根推导——**上层不得硬编码**，
   * 这样新增 harness 只需实现适配器 + 注册，不动 dirs/CLI/server。
   */
  readonly defaultRoot: string

  /** 探测本机是否安装该 harness（只读：查配置目录，不调宿主）。 */
  detect(): Promise<HarnessPresence>

  /** agent 定义约定。 */
  readonly agent: AgentConvention

  /** 子 agent 派发约定；宿主无子 agent 机制则 null。 */
  readonly dispatch: DispatchConvention | null

  /** 模型声明约定；宿主不可声明模型则 null。 */
  readonly model: ModelConvention | null

  /** skill 约定（skills 包消费 `skill.nativeDir`）。 */
  readonly skill: SkillConvention

  /** 指令文件约定。 */
  readonly instructions: InstructionsConvention

  /** 把 Prism 角色定义渲染成该 harness 的原生文件内容。 */
  renderRole(role: TRole): RenderedFile

  /** 把该 harness 的原生文件解析回 Prism 角色定义（导入）。 */
  parseRole(content: string, filename: string): TRole

  /** 团队约定的注入方式（无注入机制则 null）。 */
  renderTeamInstructions(team: TTeam): RenderedFile | null

  /**
   * 把 Prism Skill 安装到本 harness 的 Skill 目录（可选）。
   * 本期 ZCode 的批量安装走 skills 包 `installSkills`（目标取 `skill.nativeDir`）；
   * 适配器级单 Skill 供给留给未来无 Skill 机制的宿主。
   */
  provisionSkill?(skill: TSkill): Promise<SkillProvisionResult>
}

/**
 * 适配器注册表：编译期登记全部适配器，运行期只激活一个（不做运行时多 harness 路由）。
 */
export interface HarnessRegistry {
  register(adapter: HarnessAdapter): void
  /** 运行时按配置选定唯一适配器。 */
  activate(id: string): HarnessAdapter
  /** 当前激活的适配器。 */
  active(): HarnessAdapter
  /** 已编译进来的全部适配器（供 harness list 展示）。 */
  list(): HarnessAdapter[]
}

/** 创建适配器注册表（初始为空）。 */
export function createHarnessRegistry(): HarnessRegistry {
  const adapters = new Map<string, HarnessAdapter>()
  let current: string | null = null
  return {
    register(adapter) {
      adapters.set(adapter.id, adapter)
    },
    activate(id) {
      const found = adapters.get(id)
      if (!found) throw new Error(`harness adapter not registered: ${id}`)
      current = id
      return found
    },
    active() {
      if (current === null) throw new Error('no harness adapter activated')
      return adapters.get(current)!
    },
    list() {
      return [...adapters.values()]
    },
  }
}
