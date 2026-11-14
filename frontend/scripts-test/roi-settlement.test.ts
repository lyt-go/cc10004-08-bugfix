/**
 * 准入链逻辑自测：直接用项目里的 tsc 编译后跑 node，不进应用包。
 * 编译：npx tsc scripts-test/roi-settlement.test.ts --outDir /tmp/roi-test-out --module commonjs --target ES2020 --moduleResolution node --strict --skipLibCheck --esModuleInterop
 * 运行：node /tmp/roi-test-out/scripts-test/roi-settlement.test.js
 */
import { allRows, resetRows, transact } from '../src/data/local-store'
import { SEED_ROWS } from '../src/data/seed'
import {
  applyArchiveReport,
  applyCampaignTransition,
  applyConfirmReport,
  applySubmitCalculation,
  evaluateRoiConfirmation,
  normalizeStore,
  type StoreDraft,
} from '../src/domain/roi-settlement'
import type { EntryRow } from '../src/data/types'

const TODAY = '2026-11-14'
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

function freshStore(): StoreDraft {
  return normalizeStore(JSON.parse(JSON.stringify(SEED_ROWS)))
}

function roiOf(store: StoreDraft, id: number): EntryRow {
  return (store.roi ?? []).find((row) => Number(row.id) === id) as EntryRow
}

function campOf(store: StoreDraft, id: number): EntryRow {
  return (store.campaign ?? []).find((row) => Number(row.id) === id) as EntryRow
}

console.log('— 验收场景：CAMP-0002 审批中 + ROI-0002 计算中 —')
{
  const store = freshStore()
  const view = evaluateRoiConfirmation(store, 2)
  check('确认被阻止', !view.canConfirm)
  check('阻止原因显示活动周期未结束', view.blockReason.includes('活动周期未结束'), view.blockReason)
  check('活动侧并列数据齐全（开始/结束/状态）',
    view.campaign?.['开始日期'] === '2026-11-12' &&
    view.campaign?.['结束日期'] === '2026-11-25' &&
    view.campaign?.status === '活动审批中')
  check('报告侧并列数据齐全（投入/评估周期/批次）',
    view.report?.['投入金额'] === 25 &&
    view.report?.['评估周期'] === '2026-11-12~2026-11-25' &&
    view.report?.['核算批次'] === 'ACCT-0002-01')
  const result = applyConfirmReport(store, 2, TODAY)
  check('直接确认同样被阻止', !result.ok && result.message.includes('活动周期未结束'), result.message)
  check('阻止后报告仍是计算中', roiOf(store, 2).status === '计算中')
}

console.log('— CAMP-0003 / ROI-0003 不受影响 —')
{
  const store = freshStore()
  check('ROI-0003 保持已确认', roiOf(store, 3).status === '已确认')
  check('ROI-0003 正式ROI数值保持 3', roiOf(store, 3)['ROI数值'] === 3)
  check('活动与报告批次对得上', campOf(store, 3)['最近核算批次'] === roiOf(store, 3)['核算批次'])
  check('CAMP-0003 保持投放中', campOf(store, 3).status === '投放中')
  const again = applyConfirmReport(store, 3, TODAY)
  check('已确认报告不能重复确认', !again.ok && again.message.includes('不能重复确认'), again.message)
  const archive = applyArchiveReport(store, 3)
  check('已确认报告可归档', archive.ok && roiOf(store, 3).status === '已归档')
}

console.log('— 状态链：只能按 草稿→计算中→已确认→已归档 推进 —')
{
  const store = freshStore()
  check('计算中不能提交计算', !applySubmitCalculation(store, 2, TODAY).ok)
  check('计算中不能归档', !applyArchiveReport(store, 2).ok)
  check('草稿不能确认', !applyConfirmReport(store, 1, TODAY).ok)
  check('草稿不能归档', !applyArchiveReport(store, 1).ok)
}

console.log('— 提交计算准入：活动未投放不能归集投入 —')
{
  const store = freshStore()
  const result = applySubmitCalculation(store, 1, TODAY)
  check('CAMP-0001 草稿时提交计算被阻止', !result.ok && result.message.includes('尚未开始投放'), result.message)
}

console.log('— 完整结算链路（CAMP-0001 / ROI-0001）—')
{
  const store = freshStore()
  check('活动越级开始投放被阻止', !applyCampaignTransition(store, 1, '开始投放').ok)
  check('提交活动审批', applyCampaignTransition(store, 1, '提交活动审批').ok)
  check('开始投放', applyCampaignTransition(store, 1, '开始投放').ok)
  const submit = applySubmitCalculation(store, 1, TODAY)
  check('投放中提交计算成功', submit.ok, submit.message)
  check('生成核算批次 ACCT-0001-01', roiOf(store, 1)['核算批次'] === 'ACCT-0001-01')
  check('投入金额按批次归集 5×5=25', roiOf(store, 1)['投入金额'] === 25, roiOf(store, 1)['投入金额'])
  check('活动侧批次同步', campOf(store, 1)['最近核算批次'] === 'ACCT-0001-01')
  check('活动未结束时确认被阻止', !applyConfirmReport(store, 1, TODAY).ok)

  const pause = applyCampaignTransition(store, 1, '暂停投放')
  check('暂停投放成功', pause.ok)
  check('暂停后未完成计算退回草稿', roiOf(store, 1).status === '草稿')
  check('保留可继续位置（核算断点）', String(roiOf(store, 1)['核算断点']).includes('ACCT-0001-01'), roiOf(store, 1)['核算断点'])

  check('暂停中可结束投放', applyCampaignTransition(store, 1, '结束投放').ok)
  const resume = applySubmitCalculation(store, 1, TODAY)
  check('结束后从断点重新提交计算', resume.ok, resume.message)
  check('生成新批次 ACCT-0001-02', roiOf(store, 1)['核算批次'] === 'ACCT-0001-02')
  check('断点已接续清除', roiOf(store, 1)['核算断点'] === '')

  const confirm = applyConfirmReport(store, 1, TODAY)
  check('活动已结束后确认成功', confirm.ok, confirm.message)
  check('正式ROI = (100-25)/25 = 3', roiOf(store, 1)['ROI数值'] === 3, roiOf(store, 1)['ROI数值'])
  check('确认后活动侧批次对齐', campOf(store, 1)['最近核算批次'] === 'ACCT-0001-02')
  check('重复确认被阻止', !applyConfirmReport(store, 1, TODAY).ok)

  const before = String(roiOf(store, 1)['ROI数值'])
  check('已确认数值不被改期类动作覆盖', !applyCampaignTransition(store, 1, '开始投放').ok)
  check('已确认ROI数值未变', String(roiOf(store, 1)['ROI数值']) === before)
  check('确认后可归档', applyArchiveReport(store, 1).ok && roiOf(store, 1).status === '已归档')
}

console.log('— 并发生成报告：同一活动只接受一份完整结果 —')
{
  const store = freshStore()
  // 给 CAMP-0001 加一份并列报告
  ;(store.roi as EntryRow[]).push({
    id: 11, status: '草稿', pending: true, abnormal: false,
    报告编号: 'ROI-0011', 关联活动: 'CAMP-0001', 投入金额: 0, 转化收入: 0,
    ROI数值: '—', CPC成本: '—', CPM成本: '—', 评估周期: '', 核算批次: '—', 核算断点: '',
  })
  applyCampaignTransition(store, 1, '提交活动审批')
  applyCampaignTransition(store, 1, '开始投放')
  check('第一份提交计算成功', applySubmitCalculation(store, 1, TODAY).ok)
  const second = applySubmitCalculation(store, 11, TODAY)
  check('并发的第二份被阻止', !second.ok && second.message.includes('只接受一份完整结果'), second.message)
  applyCampaignTransition(store, 1, '结束投放')
  applySubmitCalculation(store, 1, TODAY)
  check('第一份确认成功', applyConfirmReport(store, 1, TODAY).ok)
  const late = applySubmitCalculation(store, 11, TODAY)
  check('已确认后新核算被阻止（需先归档）', !late.ok && late.message.includes('已确认'), late.message)
}

console.log('— 批次不一致：投入金额必须来自同一核算批次 —')
{
  const store = freshStore()
  applyCampaignTransition(store, 1, '提交活动审批')
  applyCampaignTransition(store, 1, '开始投放')
  applySubmitCalculation(store, 1, TODAY)
  applyCampaignTransition(store, 1, '结束投放')
  applySubmitCalculation(store, 1, TODAY) // 结束后重新提交，报告回到计算中
  // 模拟活动侧批次被后续核算推进，报告快照过期
  campOf(store, 1)['最近核算批次'] = 'ACCT-0001-99'
  const view = evaluateRoiConfirmation(store, 1)
  check('批次不一致时确认被阻止', !view.canConfirm && view.blockReason.includes('核算批次'), view.blockReason)
}

console.log('— 事务：写入失败整体退回 —')
{
  resetRows('campaign')
  resetRows('roi')
  const before = JSON.stringify(allRows())
  const committed = transact((draft) => {
    applyCampaignTransition(draft, 1, '提交活动审批')
    return false // 模拟后续写入失败：整体退回
  })
  check('事务未提交', !committed)
  check('内存状态整体退回', JSON.stringify(allRows()) === before)
  const okCommit = transact((draft) => applyCampaignTransition(draft, 1, '提交活动审批').ok)
  check('事务正常提交', okCommit && allRows().campaign?.[0]?.status === '活动审批中')
}

console.log('— 旧数据迁移：关联与批次对齐 —')
{
  const legacy: StoreDraft = {
    campaign: [
      { id: 2, status: '活动审批中', pending: true, abnormal: true, 活动编号: 'CAMP-0002', 开始日期: '2026-09-02', 结束日期: '2026-09-02' },
      { id: 3, status: '投放中', pending: false, abnormal: false, 活动编号: 'CAMP-0003', 开始日期: '2026-09-03', 结束日期: '2026-09-03' },
    ],
    roi: [
      { id: 2, status: '计算中', pending: true, abnormal: true, 报告编号: 'ROI-0002', 关联活动: 'ROI评估样例2', 投入金额: 25 },
      { id: 3, status: '已确认', pending: false, abnormal: false, 报告编号: 'ROI-0003', 关联活动: 'ROI评估样例3', 投入金额: 37.5 },
    ],
  }
  const merged = normalizeStore(legacy)
  check('旧关联活动按编号对齐', merged.roi[0]['关联活动'] === 'CAMP-0002' && merged.roi[1]['关联活动'] === 'CAMP-0003')
  check('计算中报告补齐批次并与活动一致',
    merged.roi[0]['核算批次'] === 'ACCT-0002-01' && merged.campaign[0]['最近核算批次'] === 'ACCT-0002-01')
  check('已确认报告批次对齐活动侧（两处对得上）',
    merged.roi[1]['核算批次'] === 'ACCT-0003-01' && merged.campaign[1]['最近核算批次'] === 'ACCT-0003-01')
  const view = evaluateRoiConfirmation(merged, 2)
  check('迁移后 CAMP-0002 确认仍被阻止（活动周期未结束）',
    !view.canConfirm && view.blockReason.includes('活动周期未结束'), view.blockReason)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
