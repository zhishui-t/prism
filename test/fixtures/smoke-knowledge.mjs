// T04：knowledge 包 dist 独立冒烟（不经单测）。
// 用法：node smoke-knowledge.mjs <临时home目录>
// 判定：① 同 id 两次 deposit version 1→2；② search("性能") 两字词命中；
//      ③ get(id,1) 取到 v1 且 superseded；④ stats/tree 与条目一致。退出码 0=全过。
// .agent-team 不在 workspace 内，按相对路径直接消费 knowledge 的 dist 产物
import { createKnowledgeService } from '../../packages/knowledge/dist/index.js'  // test/fixtures → 仓库根

const home = process.argv[2]
if (home === undefined) {
  console.error('用法: node smoke-knowledge.mjs <临时home>')
  process.exit(2)
}

const checks = []
const check = (name, cond, detail) => {
  checks.push({ name, pass: cond === true, detail })
  console.log(`${cond === true ? 'PASS' : 'FAIL'} ${name} :: ${detail}`)
}

const svc = createKnowledgeService({ home })
const input = {
  id: 'SMOKE-PERF-001',
  title: '冒烟：性能守则',
  type: 'rule',
  layer: 'global',
  book: 'smoke-book',
  module: 'perf',
  content: '遇到性能问题先量化再优化，禁止过早优化。',
  tags: ['性能'],
  deposited_by: { subject: 'tester' },
}

const d1 = await svc.deposit(input)
const d2 = await svc.deposit({ ...input, content: '遇到性能问题先量化再优化，禁止过早优化。补充：缓存命中率需监控。' })
check('V1 版本递增', d1.version === 1 && d2.version === 2, JSON.stringify({ d1: d1.version, d2: d2.version }))

const hits = await svc.search({ q: '性能' })
check('V2 两字词命中', hits.length >= 1 && hits.some((h) => h.id === 'SMOKE-PERF-001'), `hits=${hits.length} first=${hits[0]?.id}@v${hits[0]?.version}`)

const v1 = await svc.get('SMOKE-PERF-001', 1)
const latest = await svc.get('SMOKE-PERF-001')
check('V3 历史版可取', v1 !== null && v1.version === 1 && v1.status === 'superseded', `v1.status=${v1?.status} latest.v=${latest?.version} latest.superseded_by=${latest?.superseded_by}`)

const stats = await svc.stats()
const tree = await svc.tree()
check(
  'V4 统计与结构',
  stats.entries === 1 && stats.layers.global === 1 && tree.length === 1 && tree[0].book === 'smoke-book' && tree[0].modules.some((m) => m.name === 'perf' && m.count === 1),
  `stats=${JSON.stringify(stats)} tree=${JSON.stringify(tree)}`,
)

await svc.close()
const failed = checks.filter((c) => !c.pass)
console.log(`SMOKE RESULT: ${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
