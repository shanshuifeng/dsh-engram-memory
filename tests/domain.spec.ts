/**
 * 领域维度（schema v14）与门控（domain gating）的行为测试。
 *
 * 覆盖四个契约：
 * 1. 写入带 domain → 读回一致；不写 → 缺省（按 general 处理）。
 * 2. 门控判定：触发词命中才激活；短英文词要求词边界；英文短词不误伤中文/无关词。
 * 3. 检索与入库的领域收窄：指定 domains 时 general 条目仍可见（关键语义）。
 * 4. 注册表：落盘 / 读回 / 与实库统计合并；损坏文件不致命。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { asMemoryId } from '../src/types.ts'
import { openEngramStore } from '../src/store/sqlite.ts'
import type { EngramStore } from '../src/store/interface.ts'
import { gateDomains, renderDomainIndex } from '../src/domain-gate.ts'
import { loadDomainRegistry, mergeDomainDescriptors, saveDomainRegistry } from '../src/domain-registry.ts'

let dir: string
let store: EngramStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'engram-domain-'))
  store = await openEngramStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('领域写入与读回', () => {
  it('带 domain 写入后能读回同值', async () => {
    const rec = await store.write({ scope: 'user', kind: 'skill', content: 'UE5 远程执行配置', domain: 'ue5' })
    expect(rec.domain).toBe('ue5')
    const again = await store.get(asMemoryId(rec.id))
    expect(again?.domain).toBe('ue5')
  })

  it('不写 domain 时缺省为空（按 general 处理）', async () => {
    const rec = await store.write({ scope: 'user', kind: 'preference', content: '回答要简洁' })
    expect(rec.domain).toBeUndefined()
  })

  it('update 不传 domain 时继承旧领域', async () => {
    const rec = await store.write({ scope: 'user', kind: 'skill', content: '旧内容', domain: 'ue5' })
    const updated = await store.update({
      id: asMemoryId(rec.id),
      scope: 'user',
      kind: 'skill',
      content: '新内容',
    })
    expect(updated.domain).toBe('ue5')
  })

  it('setDomain 可改领域，也可改回 general', async () => {
    const rec = await store.write({ scope: 'user', kind: 'skill', content: 'x', domain: 'ue5' })
    expect((await store.setDomain(asMemoryId(rec.id), 'ml')).domain).toBe('ml')
    expect((await store.setDomain(asMemoryId(rec.id), null)).domain).toBeUndefined()
  })

  it('domainCounts 把未分类归入 general', async () => {
    await store.write({ scope: 'user', kind: 'skill', content: 'a', domain: 'ue5' })
    await store.write({ scope: 'user', kind: 'skill', content: 'b', domain: 'ue5' })
    await store.write({ scope: 'user', kind: 'fact', content: 'c' })
    const counts = await store.domainCounts()
    expect(counts['ue5']).toBe(2)
    expect(counts['general']).toBe(1)
  })
})

describe('门控判定', () => {
  const domains = [
    { name: 'ue5', mission: '虚幻引擎', triggers: ['ue5', '虚幻', '蓝图'] },
    { name: 'datamining', mission: '数据挖掘', triggers: ['数据挖掘', '爬虫'] },
  ]

  it('命中触发词即激活', () => {
    const gate = gateDomains('帮我配置 UE5 的 Python 通道', domains, true)
    expect(gate.active).toContain('ue5')
    expect(gate.reasons['ue5']).toContain('ue5')
  })

  it('未命中时不激活', () => {
    const gate = gateDomains('今天天气怎么样', domains, true)
    expect(gate.active).toEqual([])
  })

  it('可同时激活多个领域', () => {
    const gate = gateDomains('用 UE5 做数据挖掘可视化', domains, true)
    expect(gate.active).toEqual(expect.arrayContaining(['ue5', 'datamining']))
  })

  it('门控关闭时永不激活（行为等同升级前）', () => {
    const gate = gateDomains('帮我配置 UE5 的 Python 通道', domains, false)
    expect(gate.active).toEqual([])
  })

  it('短英文触发词要求词边界，不误伤更长的词', () => {
    const short = [{ name: 'ml', triggers: ['ml'] }]
    // "html" 包含 "ml" 子串，但不应命中
    expect(gateDomains('write some html here', short, true).active).toEqual([])
    // 独立成词才命中
    expect(gateDomains('use ml for this', short, true).active).toEqual(['ml'])
  })

  it('中文触发词按子串匹配（无词边界）', () => {
    expect(gateDomains('我在查虚幻引擎的资料', [{ name: 'ue5', triggers: ['虚幻'] }], true).active).toEqual(['ue5'])
  })

  it('空请求不激活', () => {
    expect(gateDomains('   ', domains, true).active).toEqual([])
  })

  it('目录行只列有条目的领域，不含 general', () => {
    const text = renderDomainIndex([
      { name: 'general', count: 5 },
      { name: 'ue5', count: 3, mission: '虚幻引擎' },
      { name: 'empty', count: 0 },
    ], 'zh')
    expect(text).toContain('ue5')
    expect(text).toContain('3')
    expect(text).not.toContain('empty')
    expect(text).not.toContain('- general')
  })

  it('无有效领域时目录行为空', () => {
    expect(renderDomainIndex([{ name: 'general', count: 3 }], 'zh')).toBe('')
  })
})

describe('领域收窄检索', () => {
  it('指定 domains 时命中该领域，general 条目也返回', async () => {
    await store.write({ scope: 'user', kind: 'skill', content: '虚幻引擎配置流程', domain: 'ue5' })
    await store.write({ scope: 'user', kind: 'preference', content: '回答要简洁' })
    const result = await store.search(
      { text: '配置 简洁', scopes: ['user'], limit: 10, domains: ['ue5'] },
      undefined,
    )
    const contents = result.hits.map(hit => hit.record.content)
    expect(contents.some(c => c.includes('虚幻引擎'))).toBe(true)
    // general 条目必须仍然可见：它是跨域通用知识
    expect(contents.some(c => c.includes('回答要简洁'))).toBe(true)
  })

  it('未指定 domains 时不做收窄', async () => {
    await store.write({ scope: 'user', kind: 'skill', content: '数据挖掘流程', domain: 'datamining' })
    const result = await store.search({ text: '数据挖掘', scopes: ['user'], limit: 10 }, undefined)
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('topActiveByDomain 只取命中领域与 general', async () => {
    await store.write({ scope: 'user', kind: 'skill', content: 'ue5 内容', domain: 'ue5', importance: 0.9 })
    await store.write({ scope: 'user', kind: 'skill', content: 'ml 内容', domain: 'ml', importance: 0.9 })
    await store.write({ scope: 'user', kind: 'preference', content: '通用偏好', importance: 0.9 })
    const rows = await store.topActiveByDomain('user', 10, ['ue5'])
    const contents = rows.map(r => r.content)
    expect(contents).toContain('ue5 内容')
    expect(contents).toContain('通用偏好')
    expect(contents).not.toContain('ml 内容')
  })
})

describe('领域注册表', () => {
  it('写入后可读回 mission 与触发词', async () => {
    await saveDomainRegistry(dir, [{ name: 'ue5', mission: '虚幻引擎', triggers: ['ue5', '虚幻'] }])
    const loaded = await loadDomainRegistry(dir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.name).toBe('ue5')
    expect(loaded[0]!.mission).toBe('虚幻引擎')
    expect(loaded[0]!.triggers).toEqual(['ue5', '虚幻'])
  })

  it('文件缺失返回空数组而不抛错', async () => {
    expect(await loadDomainRegistry(join(dir, 'nope'))).toEqual([])
  })

  it('文件损坏返回空数组而不抛错', async () => {
    writeFileSync(join(dir, 'domains.json'), '{ this is not json', 'utf8')
    expect(await loadDomainRegistry(dir)).toEqual([])
  })

  it('合并时注册表提供触发词、实库提供计数，未登记领域也会列出', () => {
    const merged = mergeDomainDescriptors(
      [{ name: 'ue5', mission: '虚幻引擎', triggers: ['ue5'] }],
      { ue5: 3, ml: 2, general: 5 },
    )
    const ue5 = merged.find(d => d.name === 'ue5')
    expect(ue5?.count).toBe(3)
    expect(ue5?.triggers).toEqual(['ue5'])
    expect(merged.find(d => d.name === 'ml')?.count).toBe(2)
    // general 排在最前
    expect(merged[0]!.name).toBe('general')
  })
})
