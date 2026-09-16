import { beforeEach, describe, expect, it } from 'vitest'

import { setLang, t } from '../src/i18n.ts'
import { validateCreate } from '../src/pages/teams/form-logic.ts'
import {
  DEPOSIT_LAYER_KEYS,
  FIELD_ORDER,
  ID_RE,
  TEMPLATE_STAGES,
  modeLabel,
  type Template,
} from '../src/pages/teams/templates.ts'

beforeEach(() => setLang('zh'))

describe('FIELD_ORDER（字段定位顺序）', () => {
  it('顺序固定且完整：teamId 起手，六项不增不减', () => {
    expect(FIELD_ORDER).toEqual(['teamId', 'name', 'description', 'members', 'teamsDir', 'defaultLayer'])
  })

  it('validateCreate 产出的错误字段全部落在 FIELD_ORDER 内（查重落在 teamId）', () => {
    // 全字段踩雷：空 ID / 空名 / 超长描述 / 空成员（重复 ID 见下）
    const errors = validateCreate(
      t,
      {
        teamId: '',
        name: '',
        description: 'x'.repeat(201),
        counts: {},
        filter: '',
        template: 'minimal',
        depositEnabled: true,
        defaultLayer: '',
        defaultType: 'rule',
        priority: 'medium',
        requireNote: false,
        teamsDir: '',
      },
      [],
      [],
      [],
    )
    for (const key of Object.keys(errors)) {
      expect(FIELD_ORDER).toContain(key)
    }
    expect(errors.teamId).toBeTruthy() // 定位键必须与 FIELD_ORDER 的成员同名

    // 查重（id 已存在）也挂在 teamId 上
    const dup = validateCreate(t, { ...baseValues(), teamId: 'core-dev' }, baseMembers(), baseRoles(), ['core-dev'])
    expect(dup.teamId).toBe(t('teams.v.idTaken', { id: 'core-dev' }))
  })
})

describe('ID_RE（与服务端 KEBAB_CASE_RE 同口径）', () => {
  it('合法：小写字母/数字，连字符只作分段', () => {
    for (const ok of ['core-dev', 'a', '9', 'core-dev-2', 'a1-b2-c3']) {
      expect(ID_RE.test(ok), ok).toBe(true)
    }
  })

  it('非法：大写/空格/下划线/首尾与连续连字符/空串', () => {
    for (const bad of ['', 'Core Dev', 'Core-Dev', 'core_dev', '-core', 'core-', 'core--dev', 'core dev', '核心']) {
      expect(ID_RE.test(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('ID_RE 本身不管长度：40 上限由 validateCreate 拦截', () => {
    const long = 'a'.repeat(41)
    expect(ID_RE.test(long)).toBe(true)
    const errors = validateCreate(t, { ...baseValues(), teamId: long }, baseMembers(), baseRoles(), [])
    expect(errors.teamId).toBe(t('teams.v.idLong'))
  })
})

describe('TEMPLATE_STAGES（照抄服务端模板）', () => {
  const templates: Template[] = ['minimal', 'core-dev', 'custom']

  it('每个模板序列非空，且每个阶段都是字典里真实存在的 DictKey', () => {
    for (const name of templates) {
      const stages = TEMPLATE_STAGES[name]
      expect(stages.length, name).toBeGreaterThan(0)
      for (const key of stages) {
        // t() 命中不到键时会回落为键名本身
        expect(t(key), key).not.toBe(key)
      }
    }
  })

  it('阶段数与真实模板一致（minimal 3 / core-dev 7，custom 用 minimal 骨架）', () => {
    expect(TEMPLATE_STAGES.minimal).toHaveLength(3)
    expect(TEMPLATE_STAGES['core-dev']).toHaveLength(7)
    expect(TEMPLATE_STAGES.custom).toEqual(TEMPLATE_STAGES.minimal)
    expect(TEMPLATE_STAGES['core-dev'][0]).toBe('teams.tpl.stage.explore')
    expect(TEMPLATE_STAGES['core-dev'][6]).toBe('teams.tpl.stage.delivery')
  })
})

describe('modeLabel（宿主数据 → 界面文案）', () => {
  it('中文原值、英文别名都映射到同一个字典键', () => {
    expect(modeLabel(t, '\u4e32\u884c')).toBe(t('teams.mode.serial'))
    expect(modeLabel(t, 'serial')).toBe(t('teams.mode.serial'))
    expect(modeLabel(t, '\u5e76\u884c')).toBe(t('teams.mode.parallel'))
    expect(modeLabel(t, 'parallel')).toBe(t('teams.mode.parallel'))
  })

  it('认不出的模式原样返回（不静默改写成别的模式）', () => {
    expect(modeLabel(t, 'pipeline')).toBe('pipeline')
    expect(modeLabel(t, '')).toBe('')
  })
})

describe('DEPOSIT_LAYER_KEYS', () => {
  it('三个层值与字典键齐备', () => {
    expect(DEPOSIT_LAYER_KEYS.map((l) => l.value)).toEqual(['global', 'project', 'role'])
    for (const l of DEPOSIT_LAYER_KEYS) expect(t(l.label)).not.toBe(l.label)
  })
})

function baseValues() {
  return {
    teamId: 'core-dev',
    name: 'Core Dev',
    description: '',
    counts: {},
    filter: '',
    template: 'minimal' as const,
    depositEnabled: false,
    defaultLayer: '',
    defaultType: 'rule',
    priority: 'medium',
    requireNote: false,
    teamsDir: '/tmp/prism-teams',
  }
}

function baseMembers() {
  return [{ role: 'dev-1', count: 2 }]
}

function baseRoles() {
  return [{ name: 'dev-1' } as Parameters<typeof validateCreate>[3][number]]
}
