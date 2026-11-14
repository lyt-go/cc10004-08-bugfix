/**
 * 服务层自测：模拟浏览器 localStorage，走 local-service 全链路（含持久化核对）。
 * 构建：npx esbuild scripts-test/service.test.ts --bundle --platform=node --format=cjs --alias:@=./src --outfile=/tmp/service-test.cjs
 * 运行：node /tmp/service-test.cjs
 */

// 先装好浏览器环境，再引服务层（local-store 读 window.localStorage）。
const persisted: Record<string, string> = {}
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => (key in persisted ? persisted[key] : null),
    setItem: (key: string, value: string) => {
      persisted[key] = String(value)
    },
    removeItem: (key: string) => {
      delete persisted[key]
    },
  },
}

import { confirmRoiReport, listEntries, prepareRoiConfirmation, runAction } from '../src/api/local-service'
import { allRows, storageKey } from '../src/data/local-store'
import type { EntryRow } from '../src/data/types'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`, extra === undefined ? '' : JSON.stringify(extra))
  }
}

function persistedRow(module: string, id: number): EntryRow {
  const store = JSON.parse(persisted[storageKey()]) as Record<string, EntryRow[]>
  return (store[module] ?? []).find((row) => Number(row.id) === id) as EntryRow
}

console.log('— 服务层验收：CAMP-0002 审批中 + ROI-0002 计算中 —')
{
  const view = prepareRoiConfirmation(2)
  check('确认页核对不通过', !view.canConfirm)
  check('显示活动周期未结束', view.blockReason.includes('活动周期未结束'), view.blockReason)
  check('确认页并列活动侧：开始/结束/状态',
    view.campaign?.['开始日期'] === '2026-11-12' &&
    view.campaign?.['结束日期'] === '2026-11-25' &&
    view.campaign?.status === '活动审批中')
  check('确认页并列报告侧：投入/评估周期/最近核算批次',
    view.report?.['投入金额'] === 25 &&
    view.report?.['评估周期'] === '2026-11-12~2026-11-25' &&
    view.report?.['核算批次'] === 'ACCT-0002-01')
  const result = confirmRoiReport(2)
  check('确认被阻止并提示活动周期未结束', !result.ok && result.message.includes('活动周期未结束'), result.message)
  check('持久化里 ROI-0002 仍是计算中（未留半截状态）', persistedRow('roi', 2).status === '计算中')
  check('持久化里 CAMP-0002 仍是活动审批中', persistedRow('campaign', 2).status === '活动审批中')
  check('列表 ROI数值 仍为非正式（—）', persistedRow('roi', 2)['ROI数值'] === '—')
}

console.log('— CAMP-0003 / ROI-0003 不影响 —')
{
  check('ROI-0003 已确认且 ROI=3', persistedRow('roi', 3).status === '已确认' && persistedRow('roi', 3)['ROI数值'] === 3)
  check('CAMP-0003 投放中且批次对得上',
    persistedRow('campaign', 3).status === '投放中' &&
    persistedRow('campaign', 3)['最近核算批次'] === persistedRow('roi', 3)['核算批次'])
}

console.log('— 服务层全链路 + 刷新后持久一致 —')
{
  check('活动越级被阻止', !runAction('campaign', 1, '开始投放').ok)
  check('提交活动审批', runAction('campaign', 1, '提交活动审批').ok)
  check('开始投放', runAction('campaign', 1, '开始投放').ok)
  check('提交计算', runAction('roi', 1, '提交计算').ok)
  check('计算中确认被阻止（活动未结束）', !confirmRoiReport(1).ok)
  const stop = runAction('campaign', 1, '结束投放')
  check('结束投放并停止未完成计算', stop.ok && stop.message.includes('保留可继续位置'), stop.message)
  check('报告退回草稿且断点持久化',
    persistedRow('roi', 1).status === '草稿' && String(persistedRow('roi', 1)['核算断点']).includes('ACCT-0001-01'))
  check('从断点重新提交计算', runAction('roi', 1, '提交计算').ok)
  const confirm = confirmRoiReport(1)
  check('确认报告成功', confirm.ok, confirm.message)
  check('正式ROI持久化 = 3', persistedRow('roi', 1)['ROI数值'] === 3)
  check('活动侧批次同步持久化（两处对得上）',
    persistedRow('campaign', 1)['最近核算批次'] === persistedRow('roi', 1)['核算批次'])
  check('重复确认被阻止', !confirmRoiReport(1).ok)
  check('归档报告', runAction('roi', 1, '归档报告').ok && persistedRow('roi', 1).status === '已归档')
  // 模拟刷新：内存态与持久化必须一致
  check('内存与 localStorage 一致', JSON.stringify(allRows()) === persisted[storageKey()])
  const list = listEntries('roi')
  check('列表读取与持久化一致', list.items.every((row) => {
    const stored = persistedRow('roi', Number(row.id))
    return stored.status === row.status && stored['核算批次'] === row['核算批次']
  }))
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
