import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, transact } from '@/data/local-store'
import {
  applyArchiveReport,
  applyCampaignTransition,
  applyConfirmReport,
  applySubmitCalculation,
  evaluateRoiConfirmation,
  todayText,
  type ConfirmEvaluation,
  type StoreDraft,
} from '@/domain/roi-settlement'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 跨模块事务执行器：mutator 在整库草稿上校验并改写，
 * 返回 ok=false 或写盘异常时整体退回，不留半截状态。
 */
function transactAction(mutator: (draft: StoreDraft) => ActionResult): ActionResult {
  let result: ActionResult = { ok: false, message: '操作未执行' }
  try {
    transact((draft) => {
      result = mutator(draft)
      return result.ok
    })
  } catch (error) {
    return {
      ok: false,
      message: `写入失败，已整体退回：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return result
}

/** 报告确认页数据：并列展示活动侧与报告侧，以及逐项准入核对结果。 */
export function prepareRoiConfirmation(id: number): ConfirmEvaluation {
  return evaluateRoiConfirmation(allRows(), id)
}

/** 确认报告：核对活动可结算、批次一致后才写入，报告与活动状态同事务提交。 */
export function confirmRoiReport(id: number): ActionResult {
  return transactAction((draft) => applyConfirmReport(draft, id, todayText()))
}

function runRoiAction(id: number, action: string): ActionResult {
  if (action === '提交计算') {
    return transactAction((draft) => applySubmitCalculation(draft, id, todayText()))
  }
  if (action === '确认报告') {
    return confirmRoiReport(id)
  }
  if (action === '归档报告') {
    return transactAction((draft) => applyArchiveReport(draft, id))
  }
  return { ok: false, message: `ROI报告没有登记「${action}」这个动作` }
}

function runCampaignAction(id: number, action: string): ActionResult {
  return transactAction((draft) => applyCampaignTransition(draft, id, action))
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 投放活动与ROI报告走准入链：只能按登记的状态链推进，且跨模块写入同事务完成。
  if (key === 'campaign') {
    return runCampaignAction(id, action)
  }
  if (key === 'roi') {
    return runRoiAction(id, action)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
