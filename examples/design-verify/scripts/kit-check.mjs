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
 *   必需  —— 缺了 design-verify 本体跑不起来：Node、技能文件、锚点核查脚本。仅此三项。
 *   可选  —— 语义层与工具面：reviewer 角色或 spec-vs-impl-checker 只是语义层的「推荐载具」，
 *            缺省用通用子代理 + 内联契约兜底（references/evidence-anchors.md §4 的陷阱清单
 *            贴进 prompt 即可）——把推荐载具判成硬门禁是假门禁；spec-verify（第 2 步可手工
 *            对账）、spec-writer（写规格才用）、agent-team（编排外壳）、prism（图优先，缺则
 *            降级 grep）同理。
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
// 队长手册两种形态：独立 agent-team 技能，或 prism 技能内嵌 references/agent-team.md（2026-10 起宿主形态）
const handbookOk = hasSkill('agent-team') || Boolean(findIn('prism/references/agent-team.md'));

const checks = [
  { need: '必需', item: `Node >= 20（当前 ${process.versions.node}）`, ok: nodeMajor >= 20, where: '' },
  { need: '必需', item: 'design-verify 技能（SKILL.md）', ok: hasSkill('design-verify'), where: findIn('design-verify/SKILL.md') || '' },
  { need: '必需', item: '锚点核查脚本（check-anchors.mjs）', ok: Boolean(findIn('design-verify/scripts/check-anchors.mjs')), where: findIn('design-verify/scripts/check-anchors.mjs') || '' },
  { need: '可选', item: '语义层推荐载具（reviewer 角色 或 spec-vs-impl-checker 至少其一；缺省用通用子代理+内联契约兜底）', ok: semanticOk, where: reviewerOk ? join(rolesDir, 'reviewer.md') : (specVsImplOk ? findIn('spec-vs-impl-checker/SKILL.md') : '') },
  { need: '可选', item: 'reviewer 角色契约（语义层/红队默认实例）', ok: reviewerOk, where: join(rolesDir, 'reviewer.md') },
  { need: '可选', item: 'spec-vs-impl-checker 技能（正反向对账）', ok: specVsImplOk, where: findIn('spec-vs-impl-checker/SKILL.md') || '' },
  { need: '可选', item: 'spec-verify 技能（验收标准→测试；第 2 步可手工对账）', ok: hasSkill('spec-verify'), where: findIn('spec-verify/SKILL.md') || '' },
  { need: '可选', item: 'spec-writer 技能（写规格时用，非验证必需）', ok: hasSkill('spec-writer'), where: findIn('spec-writer/SKILL.md') || '' },
  { need: '可选', item: 'agent-team 队长手册（独立技能或 prism 技能内嵌 references/agent-team.md）', ok: handbookOk, where: hasSkill('agent-team') ? findIn('agent-team/SKILL.md') : findIn('prism/references/agent-team.md') || '' },
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
