/**
 * 用真实数据库验证门控行为：模拟不同用户请求，看会激活哪些领域、
 * 以及最终会注入哪些条目（不含 DB 写入，只读）。
 */
import { openEngramStore } from 'C:/Users/Administrator/Documents/dsh-engram-memory/src/store/sqlite.ts'
import { gateDomains, renderDomainIndex } from 'C:/Users/Administrator/Documents/dsh-engram-memory/src/domain-gate.ts'
import { loadDomainRegistry, mergeDomainDescriptors } from 'C:/Users/Administrator/Documents/dsh-engram-memory/src/domain-registry.ts'

const DB_DIR = 'C:/Users/Administrator/.dsh/engram'

const registry = await loadDomainRegistry(DB_DIR)
const store = await openEngramStore(DB_DIR + '/user.db')
const counts = await store.domainCounts()
const descriptors = mergeDomainDescriptors(registry, counts)

console.log('=== 领域注册表（实库统计合并后）===')
for (const d of descriptors) {
  console.log(`  ${d.name.padEnd(12)} ${String(d.count ?? 0).padStart(3)} 条  ` +
    `triggers=${(d.triggers ?? []).length}  mission=${(d.mission ?? '').slice(0, 20)}`)
}

const cases = [
  '帮我配置 UE5 的 Python 远程执行通道',
  '查一下 DSH 插件怎么装',
  '今天天气怎么样',
  '我在找更好的记忆系统',
  '随便聊聊',
]

for (const req of cases) {
  console.log('\n' + '─'.repeat(60))
  console.log(`请求: "${req}"`)
  const gate = gateDomains(req, descriptors, true)
  console.log(`  激活领域: ${gate.active.length ? gate.active.join(', ') : '(无)'}`)
  if (Object.keys(gate.reasons).length) {
    for (const [d, hits] of Object.entries(gate.reasons)) {
      console.log(`    依据 ${d}: ${hits.join(' / ')}`)
    }
  }
  const top = gate.active.length === 0
    ? await store.topActive('user', 8)
    : await store.topActiveByDomain('user', 8, gate.active)
  console.log(`  将注入 ${top.length} 条:`)
  for (const r of top) {
    console.log(`    [${(r.domain ?? 'general').padEnd(12)}] ${r.kind.padEnd(10)} ${r.content.slice(0, 40)}`)
  }
}

console.log('\n' + '═'.repeat(60))
console.log('L1 目录行（每次会话都注入，仅目录不注入内容）:')
console.log(renderDomainIndex(descriptors, 'zh'))

await store.close()
