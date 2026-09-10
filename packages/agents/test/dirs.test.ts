import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  expandTildePath,
  loadPrismConfig,
  parsePrismConfig,
  resolveDirs,
  resolveDirsFromHome,
} from '../src/dirs.js'
import { DEFAULT_ZCODE_DIR } from '../src/adapters/zcode.js'

function makeTmp(): string {
  return join(tmpdir(), `prism-dirs-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

describe('prism.yaml 最小解析（三个标量键）', () => {
  it('解析 roles_dir/teams_dir/skills_dir；忽略注释/空行/未知键；引号与行尾注释剥除', () => {
    const config = parsePrismConfig(
      [
        '# Prism 目录配置',
        'roles_dir: ~/my-agents   # 行尾注释',
        'teams_dir: "D:/teamz"',
        "skills_dir: 'C:/skillz'",
        'unknown_key: ignored',
        '',
      ].join('\n'),
    )
    expect(config).toEqual({ roles_dir: '~/my-agents', teams_dir: 'D:/teamz', skills_dir: 'C:/skillz' })
  })

  it('空值键跳过；无冒号行忽略', () => {
    expect(parsePrismConfig('roles_dir:\n垃圾行\n')).toEqual({})
    expect(parsePrismConfig('')).toEqual({})
  })

  it('expandTildePath：~/ 与裸 ~ 展开；普通路径原样', () => {
    expect(expandTildePath('~')).toBe(homedir())
    expect(expandTildePath('~/agents')).toBe(join(homedir(), 'agents'))
    expect(expandTildePath('C:/x')).toBe('C:/x')
    expect(expandTildePath('rel/agents')).toBe('rel/agents')
  })
})

describe('resolveDirs（prism.yaml 覆盖适配器默认；无配置 → 默认回落）', () => {
  it('无配置（null）→ 适配器默认：harnessRoot 推导 agents/teams/skills（teams 不在 agents 内），source=default', () => {
    const dirs = resolveDirs(null, { harnessRoot: 'K:/tmp/zcode' })
    expect(dirs).toEqual({
      rolesDir: join('K:/tmp/zcode', 'agents'),
      teamsDir: join('K:/tmp/zcode', 'teams'),
      skillsDir: join('K:/tmp/zcode', 'skills'),
      source: 'default',
      harness: 'zcode',
      harnessRoot: 'K:/tmp/zcode',
      guard: { roles: true, teams: true, skills: true },
    })
    // 缺省 harnessRoot → ZCode 适配器默认根（仅路径推导，不触碰磁盘）
    expect(resolveDirs().harnessRoot).toBe(DEFAULT_ZCODE_DIR)
    // B6：默认链（未显式指定 harnessRoot）→ 全部需要写守卫
    expect(resolveDirs(null).guard).toEqual({ roles: true, teams: true, skills: true })
  })

  it('显式 harnessRoot → guard 全放行（B6：用户显式指定可直接写）', () => {
    expect(resolveDirs(null, { harnessRoot: 'K:/tmp/zcode', rootExplicit: true }).guard).toEqual({
      roles: false,
      teams: false,
      skills: false,
    })
  })

  it('配置覆盖生效（临时 roles_dir 等）；~ 与相对路径正确解释', () => {
    const dirs = resolveDirs(
      { roles_dir: '/tmp/custom-roles', skills_dir: '~/custom-skills' },
      { harnessRoot: 'K:/tmp/zcode' },
    )
    expect(dirs.rolesDir).toBe('/tmp/custom-roles') // 绝对路径直用
    expect(dirs.teamsDir).toBe(join('/tmp', 'teams')) // teams 未配置 → 跟随 roles_dir 的**同级** teams/（B7：不进 agents 扫描路径）
    expect(dirs.skillsDir).toBe(join(homedir(), 'custom-skills')) // ~ 展开
    expect(dirs.source).toBe('config')

    const relative = resolveDirs({ roles_dir: 'custom/agents' }, { harnessRoot: 'K:/tmp/zcode' })
    expect(relative.rolesDir).toBe(join('K:/tmp/zcode', 'custom/agents')) // 相对路径相对 ZCode 根
  })

  it('B6 guard 逐键判定：配置键放行；teams 缺省跟随已配置的 roles_dir 也放行', () => {
    const partial = resolveDirs({ roles_dir: '/tmp/custom-roles' }, { harnessRoot: 'K:/tmp/zcode' })
    expect(partial.guard).toEqual({ roles: false, teams: false, skills: true })
    // 落点必须与 guard 口径一致：teams 缺省时跟随 roles_dir 的同级（qa 快审实测：不一致会导致守卫放行却写默认宿主）
    expect(partial.teamsDir).toBe(join('/tmp', 'teams'))

    const all = resolveDirs({ roles_dir: '/r', teams_dir: '/t', skills_dir: '/s' }, { harnessRoot: 'K:/tmp/zcode' })
    expect(all.guard).toEqual({ roles: false, teams: false, skills: false })
    expect(all.teamsDir).toBe('/t') // teams_dir 显式时不被 roles_dir 联动覆盖
  })

  it('配置对象存在但无有效键 → 仍走默认值，source=config', () => {
    const dirs = resolveDirs({}, { harnessRoot: 'K:/tmp/zcode' })
    expect(dirs.rolesDir).toBe(join('K:/tmp/zcode', 'agents'))
    expect(dirs.source).toBe('config')
  })
})

describe('loadPrismConfig（<home>/prism.yaml 存在性）', () => {
  let home = ''
  beforeEach(() => {
    home = makeTmp()
    mkdirSync(home, { recursive: true })
  })
  afterEach(() => {
    /* 临时目录留给系统清理 */
  })

  it('prism.yaml 存在 → 解析配置；不存在 → null', () => {
    expect(loadPrismConfig(home)).toBeNull() // 无文件
    writeFileSync(join(home, 'prism.yaml'), 'roles_dir: /tmp/agents-x\n')
    expect(loadPrismConfig(home)).toEqual({ roles_dir: '/tmp/agents-x' })
  })

  it('resolveDirsFromHome：端到端组合（临时 home 的配置覆盖 harnessRoot 默认）', () => {
    writeFileSync(
      join(home, 'prism.yaml'),
      ['roles_dir: /tmp/roles-x', 'teams_dir: /tmp/teams-x', 'skills_dir: /tmp/skills-x'].join('\n'),
    )
    const dirs = resolveDirsFromHome(home, { harnessRoot: 'K:/tmp/zcode' })
    expect(dirs.rolesDir).toBe('/tmp/roles-x')
    expect(dirs.teamsDir).toBe('/tmp/teams-x')
    expect(dirs.skillsDir).toBe('/tmp/skills-x')
    expect(dirs.source).toBe('config')
  })
})
