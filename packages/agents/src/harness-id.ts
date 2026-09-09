/**
 * 宿主适配器 id 常量（零依赖，供 dirs/harness 双方引用，避免循环导入）。
 */

/** ZCode 适配器 id。 */
export const ZCODE_HARNESS_ID = 'zcode'

/** 默认激活的适配器（当前唯一已编译实现）。 */
export const DEFAULT_HARNESS_ID = ZCODE_HARNESS_ID

/** 环境变量名（临时覆盖 prism.yaml 的 harness 键）。 */
export const HARNESS_ENV_VAR = 'PRISM_HARNESS'
