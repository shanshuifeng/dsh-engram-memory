/**
 * 领域注册表：每个知识方向的 mission 与触发词，落盘为 `<dbDir>/domains.json`。
 * @module @kenz1117/dsh-engram/domain-registry
 *
 * 为什么是独立 JSON 而不进 SQLite：
 * 注册表是人类可编辑的配置（改触发词不该开数据库），且体积极小；同时它天然
 * 可被 git 管理、可随记忆库一起备份转移——与「记忆应方便迁移」的目标一致。
 *
 * 文件缺失或损坏时不阻断运行：返回空注册表，门控退化为「只有 general」，
 * 并保留各领域目录行（靠 domainCounts 聚合），功能降级但不失效。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { DomainDescriptor } from './domain-gate.ts'

/** 注册表文件在 dbDir 下的固定文件名。 */
export const DOMAIN_REGISTRY_FILE = 'domains.json'

/** 注册表磁盘结构。 */
interface DomainRegistryFile {
  /** 结构版本，便于将来演进。 */
  version: 1
  domains: { name: string; mission?: string; triggers?: string[] }[]
}

/** 读取领域注册表；文件缺失/损坏返回空数组（不抛错）。 */
export async function loadDomainRegistry(dbDir: string): Promise<DomainDescriptor[]> {
  const path = join(dbDir, DOMAIN_REGISTRY_FILE)
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DomainRegistryFile>
    if (!Array.isArray(parsed.domains)) return []
    const out: DomainDescriptor[] = []
    for (const item of parsed.domains) {
      if (typeof item?.name !== 'string' || item.name.trim() === '') continue
      out.push({
        name: item.name.trim(),
        ...(typeof item.mission === 'string' && item.mission !== '' ? { mission: item.mission } : {}),
        ...(Array.isArray(item.triggers)
          ? { triggers: item.triggers.filter((t): t is string => typeof t === 'string' && t.trim() !== '') }
          : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

/** 写入领域注册表（覆盖式；调用方负责传完整列表）。 */
export async function saveDomainRegistry(dbDir: string, domains: readonly DomainDescriptor[]): Promise<string> {
  const path = join(dbDir, DOMAIN_REGISTRY_FILE)
  mkdirSync(dirname(path), { recursive: true })
  const file: DomainRegistryFile = {
    version: 1,
    domains: domains.map(d => ({
      name: d.name,
      ...(d.mission === undefined ? {} : { mission: d.mission }),
      ...(d.triggers === undefined ? {} : { triggers: [...d.triggers] }),
    })),
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  return path
}

/**
 * 合并注册表与实库统计：注册表提供 mission/触发词，实库提供真实条目数。
 * 只在实库出现但注册表未登记的领域也会列出（count>0、无触发词 → 不参与门控，
 * 但仍出现在目录行里，提示用户去补触发词）。
 */
export function mergeDomainDescriptors(
  registry: readonly DomainDescriptor[],
  counts: Readonly<Record<string, number>>,
): DomainDescriptor[] {
  const byName = new Map<string, DomainDescriptor>()
  for (const d of registry) {
    byName.set(d.name, { ...d, count: counts[d.name] ?? 0 })
  }
  for (const [name, count] of Object.entries(counts)) {
    if (name === 'general') continue
    if (!byName.has(name)) byName.set(name, { name, count })
  }
  // general 也纳入（curated/profile 语义一致），排在最前便于阅读。
  // 注意：counts 里才有的 general 也要补进来，否则未登记方向时会漏掉它。
  const general = byName.get('general') ?? (counts['general'] === undefined ? undefined : { name: 'general' as const })
  byName.delete('general')
  const rest = [...byName.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
  return general === undefined ? rest : [{ ...general, count: counts['general'] ?? general.count ?? 0 }, ...rest]
}
