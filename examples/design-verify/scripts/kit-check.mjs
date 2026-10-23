#!/usr/bin/env node
/**
 * kit-check.mjs — design-verify 工具箱自检
 *
 * 用法:
 *   node kit-check.mjs
 * 环境覆盖（其他宿主/目录时用）:
 *   SKILL_HOMES=<目录1;目录2>  技能目录列表（缺省 ~/.zcode/skills 与 ~/.agents/skills）
 *   ROLES_DIR=<目录>           角色目录（缺省 ~/.zcode/agents）
 *
 * 定级口径：
 *   必需  —— 缺了 design-verify 流程跑不起来。语义层要求「reviewer 角色」与
 *            「spec-vs-impl-checker 技能」至少其一（tooling.md：二者同门二选一）。
 *   可选  —— 缺了能跑但降级或需要时再补：spec-verify（第 2 步可手工对账）、
 *            spec-writer（只在写规格时需要）、agent-team（编排外壳）。
 *
 * 退出码: 0 = 必需项齐备；1 = 有必需项缺失
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const nodeMajor = Number(process.versions.node.split('.')[0]);
const homes = (process.env.SKILL_HOMES || [join(homedir(), '.zcode', 'skills'), join(homedir(), '.agents', 'skills')].join(';'))
  .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
const rolesDir = process.env.ROLES_DIR || join(homedir(), '.zcode', 'agents');

const findIn = (rel) => homes.find((h) => existsSync(join(h, rel)));
const hasSkill = (name) => Boolean(findIn(`${name}/SKILL.md`));
const hasRole = (name) => existsSync(join(rolesDir, `${name}.md`));

const reviewerOk = hasRole('reviewer');
const specVsImplOk = hasSkill('spec-vs-impl-checker');
const semanticOk = reviewerOk || specVsImplOk;

const checks = [
  { need: '必需', item: `Node >= 20（当前 ${process.versions.node}）`, ok: nodeMajor >= 20, where: '' },
  { need: '必需', item: 'design-verify 技能（SKILL.md）', ok: hasSkill('design-verify'), where: findIn('design-verify/SKILL.md') || '' },
  { need: '必需', item: '锚点核查脚本（check-anchors.mjs）', ok: Boolean(findIn('design-verify/scripts/check-anchors.mjs')), where: findIn('design-verify/scripts/check-anchors.mjs') || '' },
  {
    need: '必需',
    item: '语义层载体（reviewer 角色 或 spec-vs-impl-checker 至少其一）',
    ok: semanticOk,
    where: reviewerOk ? join(rolesDir, 'reviewer.md') : (specVsImplOk ? findIn('spec-vs-impl-checker/SKILL.md') : ''),
  },
  { need: '可选', item: 'reviewer 角色契约（语义层/红队默认实例）', ok: reviewerOk, where: join(rolesDir, 'reviewer.md') },
  { need: '可选', item: 'spec-vs-impl-checker 技能（正反向对账）', ok: specVsImplOk, where: findIn('spec-vs-impl-checker/SKILL.md') || '' },
  { need: '可选', item: 'spec-verify 技能（验收标准→测试；第 2 步可手工对账）', ok: hasSkill('spec-verify'), where: findIn('spec-verify/SKILL.md') || '' },
  { need: '可选', item: 'spec-writer 技能（写规格时用，非验证必需）', ok: hasSkill('spec-writer'), where: findIn('spec-writer/SKILL.md') || '' },
  { need: '可选', item: 'agent-team 技能（编排外壳，卡点③可挂本流程）', ok: hasSkill('agent-team'), where: findIn('agent-team/SKILL.md') || '' },
  { need: '可选', item: 'prism 技能 / CLI（代码图谱：图优先解析，缺则降级 grep）', ok: hasSkill('prism'), where: findIn('prism/SKILL.md') || '' },
];

console.log('design-verify 工具箱自检');
console.log(`- 技能目录: ${homes.join(' ; ')}`);
console.log(`- 角色目录: ${rolesDir}`);
console.log('');
console.log('| 档 | 组件 | 结果 | 位置 |');
console.log('| :-- | :-- | :-- | :-- |');
for (const c of checks) {
  const where = c.ok ? c.where : '';
  console.log(`| ${c.need} | ${c.item} | ${c.ok ? '✓' : '✗'} | ${where.replaceAll('|', '\\|')} |`);
}
const required = checks.filter((c) => c.need === '必需');
const missing = required.filter((c) => !c.ok);
const degraded = checks.filter((c) => c.need === '可选' && !c.ok);
console.log('');
console.log(`- 必需项: ${required.length - missing.length}/${required.length}${missing.length ? ' —— 缺: ' + missing.map((c) => c.item).join('; ') : '，齐备'}`);
if (degraded.length) console.log(`- 可选项缺省（流程可跑，按需再补）: ${degraded.map((c) => c.item).join('; ')}`);
console.log(missing.length ? '结论: 未齐备 —— 装齐必需项后再开跑' : '结论: 齐备 —— 文档到位即可从第 1 步开跑');
process.exit(missing.length ? 1 : 0);
