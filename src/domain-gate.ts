/**
 * 领域门控（domain gating）：决定「本次会话该激活哪些知识方向」。
 * @module @kenz1117/dsh-engram/domain-gate
 *
 * 设计要点（为何不把领域内容常驻注入）：
 * 每个会话都为不相干方向付 token，且长上下文中注意力会被稀释——Mem0 论文与
 * LongMemEval 都把「无关历史挤占上下文」列为准确率下降的主因。因此领域内容的
 * 正确姿态是「检索时进上下文」，而不是「注入时进上下文」。
 *
 * 三级门控：
 * 1. L0 常驻：general 领域条目（用户工作方式、跨域铁律）——始终注入，规模小。
 * 2. L1 目录：各领域 INDEX（mission + 触发词）——只注入一行，告知「有这些方向」。
 * 3. L2 内容：命中领域的条目——只有触发词命中时才注入。
 *
 * 门控判定刻意做成确定性关键词匹配（可预测、零额外 LLM 调用）。模糊匹配失败时
 * 保守回退到 general-only，并允许 agent 用 engram_search 的 domains 参数显式拉取。
 */

import type { EngramDomain } from './types.ts'

/** 一个领域的注册信息：由 domains/index 与现有条目聚合而来。 */
export interface DomainDescriptor {
  /** 领域 id（ue5 / datamining / ml …）。 */
  readonly name: EngramDomain
  /** 一句话使命：这个方向是关于什么的（决定何时该激活）。 */
  readonly mission?: string
  /** 触发词：会话请求里出现任一即激活该领域。 */
  readonly triggers?: readonly string[]
  /** 该领域 active 条目数（聚合统计，用于目录行展示）。 */
  readonly count?: number
}

/** 门控判定结果。 */
export interface GateResult {
  /** 本次会话激活的领域（不含 general）。 */
  readonly active: readonly EngramDomain[]
  /** 激活依据（命中的触发词），用于可解释性与调试。 */
  readonly reasons: Readonly<Record<string, readonly string[]>>
}

/**
 * 从请求文本里提取命中词。
 *
 * 匹配规则（刻意简单，可预测）：
 * - 大小写不敏感；
 * - 触发词按「词边界或子串」匹配——中文没有词边界，用子串；英文用前缀边界避免
 *   "ml" 命中 "html" 这类误报。
 * - 触发词长度 < 3 的英文词（如 "ml"、"ue"）要求独立成词，降低误报。
 */
function matchTriggers(text: string, triggers: readonly string[]): string[] {
  const lower = text.toLowerCase()
  const hits: string[] = []
  for (const raw of triggers) {
    const trigger = raw.trim().toLowerCase()
    if (trigger === '') continue
    // 全 ASCII 且很短的触发词：要求独立词边界（ue/ml/c++ 之外的短词误报率高）
    const isAscii = /^[\x20-\x7e]+$/.test(trigger)
    if (isAscii && trigger.length < 3) {
      const re = new RegExp(`(^|[^a-z0-9])${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
      if (re.test(lower)) hits.push(raw)
      continue
    }
    if (lower.includes(trigger)) hits.push(raw)
  }
  return hits
}

/**
 * 判定本次会话应激活哪些领域。
 *
 * @param requestText - 当前用户请求文本（首轮）；空串时返回无激活（只注入 general）。
 * @param domains - 已注册领域描述符（来自 domains/index）。
 * @param enabled - 门控开关；false 时返回空激活集（行为等同升级前：全量注入）。
 * @returns 激活的领域 id 与命中依据。
 */
export function gateDomains(
  requestText: string,
  domains: readonly DomainDescriptor[],
  enabled: boolean,
): GateResult {
  if (!enabled || requestText.trim() === '') return { active: [], reasons: {} }
  const active: EngramDomain[] = []
  const reasons: Record<string, readonly string[]> = {}
  for (const domain of domains) {
    if (domain.triggers === undefined || domain.triggers.length === 0) continue
    const hits = matchTriggers(requestText, domain.triggers)
    if (hits.length > 0) {
      active.push(domain.name)
      reasons[domain.name] = hits
    }
  }
  return { active, reasons }
}

/**
 * 渲染 L1 目录行：告知模型「存在这些方向」而不注入其内容。
 * 无领域时返回空串（调用方据此跳过）。
 * @param domains - 领域描述符（含 count）。
 * @param language - 输出语言。
 */
export function renderDomainIndex(domains: readonly DomainDescriptor[], language: 'zh' | 'en' | 'ru'): string {
  const known = domains.filter(d => d.name !== 'general' && (d.count ?? 0) > 0)
  if (known.length === 0) return ''
  const header = language === 'zh'
    ? '知识方向目录（仅目录，需要时用 engram_search 的 domains 参数深入）：'
    : language === 'ru'
      ? 'Каталог направлений знаний (только каталог; для углубления используйте domains в engram_search):'
      : 'Knowledge domain index (index only; pass domains to engram_search to go deeper):'
  const lines = known.map((d) => {
    const mission = d.mission === undefined || d.mission === '' ? '' : ` — ${d.mission}`
    return `- ${d.name} (${d.count ?? 0})${mission}`
  })
  return [header, ...lines].join('\n')
}
