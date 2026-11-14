import { normalizeStore } from '../domain/roi-settlement'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'data-product-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function persist(store: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = normalizeStore(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 旧数据补齐新增字段（核算批次、核算断点等），并把已确认报告的批次对齐到活动侧。
    const merged = normalizeStore({ ...fallback, ...parsed })
    persist(merged)
    return merged
  } catch {
    persist(fallback)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(next)
}

/**
 * 跨模块事务：在整库草稿上执行 mutator，返回 true 才一次性写盘；
 * mutator 返回 false 或写盘失败时整体退回，内存与 localStorage 都保持原状。
 * 报告与活动状态必须同事务写入，任何一步失败都不留半截结果。
 */
export function transact(mutator: (draft: Record<string, EntryRow[]>) => boolean): boolean {
  const before = allRows()
  const draft = clone(before)
  if (!mutator(draft)) {
    return false
  }
  cache = draft
  try {
    persist(draft)
  } catch (error) {
    cache = before
    throw error
  }
  return true
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
