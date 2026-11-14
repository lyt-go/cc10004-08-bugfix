import type { ActionResult, EntryRow } from '../data/types'

/**
 * 活动与 ROI 报告的准入链（结算口径，纯函数，不直接碰存储）。
 *
 * 口径约定（先后次序由这里统一定义）：
 * - 活动周期口径：活动只有走到「已结束」才进入可结算状态；
 *   「草稿 / 活动审批中 / 投放中 / 已暂停」一律视为活动周期未结束。
 * - 投入口径：投入金额按核算批次归集。每次「提交计算」为活动生成一个新的
 *   核算批次（ACCT-<活动序号>-<两位序号>），批次投入金额 = 日预算 × 已投放天数
 *   （开始日期 → min(结束日期, 今天)，未开始为 0）。报告快照该批次的投入金额，
 *   确认时报告批次必须与活动最近核算批次一致，否则视为投入金额口径过期。
 * - ROI 口径：ROI数值 = (转化收入 − 投入金额) / 投入金额，保留两位小数。
 *   确认前只有「试算」值，确认后才生成正式结论并冻结，之后任何活动改期、
 *   暂停、结束动作都不再改写已确认报告的数值。
 */

export type StoreDraft = Record<string, EntryRow[]>

export type ChainRule = { from: string[]; to: string }

/** 状态链：只能按登记的方向推进，不允许跨级、回退或重复。 */
export const TRANSITION_RULES: Record<string, Record<string, ChainRule>> = {
  campaign: {
    提交活动审批: { from: ['草稿'], to: '活动审批中' },
    开始投放: { from: ['活动审批中'], to: '投放中' },
    暂停投放: { from: ['投放中'], to: '已暂停' },
    结束投放: { from: ['投放中', '已暂停'], to: '已结束' },
  },
  roi: {
    提交计算: { from: ['草稿'], to: '计算中' },
    确认报告: { from: ['计算中'], to: '已确认' },
    归档报告: { from: ['已确认'], to: '已归档' },
  },
}

export const ROI_FLOW_TEXT = '草稿→计算中→已确认→已归档'
export const CAMPAIGN_FLOW_TEXT = '草稿→活动审批中→投放中→（已暂停）→已结束'

/** 活动处于这些状态时才允许归集投入、提交计算。 */
export const CALCULABLE_CAMPAIGN_STATUSES = ['投放中', '已暂停', '已结束']
/** 活动只有「已结束」才进入可结算状态。 */
export const SETTLEABLE_CAMPAIGN_STATUS = '已结束'

export const NO_BATCH = '—'

export function todayText(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function isDateText(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
}

/** 下一个核算批次号：ACCT-0002-01 → ACCT-0002-02；还没有批次时从 01 开始。 */
export function nextBatchId(campaignCode: string, current: string): string {
  const seq = campaignCode.replace(/\D/g, '') || '0000'
  const matched = /^ACCT-\d+-(\d+)$/.exec(current)
  const next = matched ? Number(matched[1]) + 1 : 1
  return `ACCT-${seq}-${String(next).padStart(2, '0')}`
}

/** 已投放天数：开始日期 → min(结束日期, 今天)，未开始为 0。 */
export function accountedDays(start: string, end: string, today: string): number {
  if (!isDateText(start) || !isDateText(end) || !isDateText(today)) {
    return 0
  }
  const effectiveEnd = end < today ? end : today
  if (effectiveEnd < start) {
    return 0
  }
  return Math.floor((Date.parse(effectiveEnd) - Date.parse(start)) / 86400000) + 1
}

/** 批次投入金额 = 日预算 × 已投放天数。 */
export function accountedInvestment(campaign: EntryRow, today: string): number {
  const budget = Number(campaign['日预算'])
  if (!Number.isFinite(budget) || budget <= 0) {
    return 0
  }
  const days = accountedDays(String(campaign['开始日期'] ?? ''), String(campaign['结束日期'] ?? ''), today)
  return round2(budget * days)
}

/** ROI数值 = (转化收入 − 投入金额) / 投入金额，投入为 0 时无法核算。 */
export function roiValue(invest: number, revenue: number): number {
  if (!Number.isFinite(invest) || invest <= 0 || !Number.isFinite(revenue)) {
    return 0
  }
  return round2((revenue - invest) / invest)
}

export function findLinkedCampaign(draft: StoreDraft, report: EntryRow): EntryRow | undefined {
  const code = String(report['关联活动'] ?? '')
  return (draft.campaign ?? []).find((row) => String(row['活动编号']) === code)
}

export function siblingReports(draft: StoreDraft, report: EntryRow): EntryRow[] {
  const code = String(report['关联活动'] ?? '')
  return (draft.roi ?? []).filter(
    (row) => Number(row.id) !== Number(report.id) && String(row['关联活动']) === code,
  )
}

export type ConfirmCheck = { label: string; ok: boolean; message: string }

export type ConfirmEvaluation = {
  report: EntryRow | null
  campaign: EntryRow | null
  checks: ConfirmCheck[]
  canConfirm: boolean
  blockReason: string
  /** 试算 ROI（非正式结论），投入不完整时为 null。 */
  trialRoi: number | null
}

/** 确认前的准入核对：状态链、活动可结算、批次一致、投入完整、结果唯一。 */
export function evaluateRoiConfirmation(draft: StoreDraft, reportId: number): ConfirmEvaluation {
  const report = (draft.roi ?? []).find((row) => Number(row.id) === reportId) ?? null
  if (!report) {
    const checks: ConfirmCheck[] = [
      { label: '报告状态', ok: false, message: `没有找到编号为 ${reportId} 的ROI报告` },
    ]
    return { report: null, campaign: null, checks, canConfirm: false, blockReason: checks[0].message, trialRoi: null }
  }

  const checks: ConfirmCheck[] = []
  const status = String(report.status)
  if (status === '计算中') {
    checks.push({ label: '报告状态', ok: true, message: '报告处于「计算中」，可以提请确认' })
  } else {
    const repeated = status === '已确认' ? '，不能重复确认' : ''
    checks.push({
      label: '报告状态',
      ok: false,
      message: `报告当前状态为「${status}」，仅「计算中」可确认${repeated}；报告只能按 ${ROI_FLOW_TEXT} 推进`,
    })
  }

  const code = String(report['关联活动'] ?? '')
  const campaign = findLinkedCampaign(draft, report) ?? null
  checks.push(
    campaign
      ? { label: '关联活动', ok: true, message: `已关联活动「${code}」` }
      : { label: '关联活动', ok: false, message: `找不到关联活动「${code}」，不能确认` },
  )

  if (campaign) {
    const campaignStatus = String(campaign.status)
    checks.push(
      campaignStatus === SETTLEABLE_CAMPAIGN_STATUS
        ? { label: '活动周期', ok: true, message: '活动已结束，进入可结算状态' }
        : {
            label: '活动周期',
            ok: false,
            message: `活动周期未结束：当前状态为「${campaignStatus}」，仅「已结束」可结算确认`,
          },
    )

    const reportBatch = String(report['核算批次'] ?? NO_BATCH)
    const campaignBatch = String(campaign['最近核算批次'] ?? NO_BATCH)
    checks.push(
      reportBatch !== NO_BATCH && reportBatch === campaignBatch
        ? { label: '核算批次', ok: true, message: `投入金额来自同一核算批次「${reportBatch}」` }
        : {
            label: '核算批次',
            ok: false,
            message: `投入金额不是来自活动最近核算批次（报告「${reportBatch}」≠ 活动「${campaignBatch}」），请重新提交计算`,
          },
    )

    const invest = Number(report['投入金额'])
    checks.push(
      Number.isFinite(invest) && invest > 0
        ? { label: '投入金额', ok: true, message: `投入金额 ${invest} 已按批次完整归集` }
        : { label: '投入金额', ok: false, message: '投入金额为 0 或缺失，无法核算正式ROI' },
    )

    const confirmedSibling = siblingReports(draft, report).find((row) => String(row.status) === '已确认')
    checks.push(
      confirmedSibling
        ? {
            label: '唯一结果',
            ok: false,
            message: `活动「${code}」已存在已确认报告「${confirmedSibling['报告编号']}」，同一活动只接受一份完整结果`,
          }
        : { label: '唯一结果', ok: true, message: '同一活动暂无其他已确认报告' },
    )
  }

  const canConfirm = checks.every((check) => check.ok)
  const blockReason = canConfirm ? '' : checks.find((check) => !check.ok)?.message ?? '核对未通过'
  const invest = Number(report['投入金额'])
  const revenue = Number(report['转化收入'])
  const trialRoi = Number.isFinite(invest) && invest > 0 && Number.isFinite(revenue) ? roiValue(invest, revenue) : null
  return { report, campaign, checks, canConfirm, blockReason, trialRoi }
}

/** 提交计算：为活动生成新核算批次，报告快照同批次的投入金额。 */
export function applySubmitCalculation(draft: StoreDraft, reportId: number, today: string): ActionResult {
  const report = (draft.roi ?? []).find((row) => Number(row.id) === reportId)
  if (!report) {
    return { ok: false, message: `没有找到编号为 ${reportId} 的ROI报告` }
  }
  const status = String(report.status)
  if (status !== '草稿') {
    return { ok: false, message: `ROI报告只能按 ${ROI_FLOW_TEXT} 推进，当前「${status}」不能执行「提交计算」` }
  }
  const code = String(report['关联活动'] ?? '')
  const campaign = findLinkedCampaign(draft, report)
  if (!campaign) {
    return { ok: false, message: `报告关联的活动「${code}」不存在，不能提交计算` }
  }
  const campaignStatus = String(campaign.status)
  if (!CALCULABLE_CAMPAIGN_STATUSES.includes(campaignStatus)) {
    return {
      ok: false,
      message: `活动「${code}」当前为「${campaignStatus}」，尚未开始投放，投入金额未归集，不能提交计算`,
    }
  }
  const siblings = siblingReports(draft, report)
  if (siblings.some((row) => String(row.status) === '计算中')) {
    return { ok: false, message: `活动「${code}」已存在计算中的报告，并发生成报告时只接受一份完整结果` }
  }
  if (siblings.some((row) => String(row.status) === '已确认')) {
    return { ok: false, message: `活动「${code}」已存在已确认报告，需先归档后再发起新的核算` }
  }

  const batch = nextBatchId(code, String(campaign['最近核算批次'] ?? ''))
  const invest = accountedInvestment(campaign, today)
  campaign['最近核算批次'] = batch
  campaign['批次投入金额'] = invest
  report['核算批次'] = batch
  report['投入金额'] = invest
  report['评估周期'] = `${campaign['开始日期']}~${campaign['结束日期']}`
  report['核算断点'] = ''
  report['ROI数值'] = NO_BATCH
  report.status = '计算中'
  report.pending = true
  report.abnormal = false
  return { ok: true, message: `ROI报告已提交计算，核算批次「${batch}」，投入金额 ${invest}，当前状态「计算中」` }
}

/** 确认报告：核对通过后生成正式 ROI 并冻结，同事务把活动侧批次对齐。 */
export function applyConfirmReport(draft: StoreDraft, reportId: number, today: string): ActionResult {
  const evaluation = evaluateRoiConfirmation(draft, reportId)
  if (!evaluation.canConfirm || !evaluation.report || !evaluation.campaign) {
    return { ok: false, message: `确认被阻止：${evaluation.blockReason}` }
  }
  const report = evaluation.report
  const invest = Number(report['投入金额'])
  const revenue = Number(report['转化收入'])
  const formal = roiValue(invest, revenue)
  report['ROI数值'] = formal
  report['确认时间'] = today
  report.status = '已确认'
  report.pending = false
  report.abnormal = false
  // 同一事务把活动侧核算批次对齐到已确认报告，保证活动与报告两处对得上。
  evaluation.campaign['最近核算批次'] = String(report['核算批次'])
  evaluation.campaign['批次投入金额'] = invest
  return {
    ok: true,
    message: `ROI报告已确认：正式ROI ${formal}，核算批次「${String(report['核算批次'])}」已同步到活动侧`,
  }
}

/** 归档报告：只允许已确认 → 已归档。 */
export function applyArchiveReport(draft: StoreDraft, reportId: number): ActionResult {
  const report = (draft.roi ?? []).find((row) => Number(row.id) === reportId)
  if (!report) {
    return { ok: false, message: `没有找到编号为 ${reportId} 的ROI报告` }
  }
  const status = String(report.status)
  if (status !== '已确认') {
    return { ok: false, message: `ROI报告只能按 ${ROI_FLOW_TEXT} 推进，当前「${status}」不能执行「归档报告」` }
  }
  report.status = '已归档'
  report.pending = false
  return { ok: true, message: 'ROI报告已归档' }
}

/**
 * 活动状态流转：按链推进；活动暂停或结束时，未完成的计算停止并退回草稿，
 * 核算断点保留可继续位置；已确认/已归档的报告数值不被改期等动作覆盖。
 */
export function applyCampaignTransition(draft: StoreDraft, campaignId: number, action: string): ActionResult {
  const rule = TRANSITION_RULES.campaign[action]
  if (!rule) {
    return { ok: false, message: `投放活动没有登记「${action}」这个动作` }
  }
  const row = (draft.campaign ?? []).find((item) => Number(item.id) === campaignId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${campaignId} 的投放活动` }
  }
  const current = String(row.status)
  if (current === rule.to) {
    return { ok: false, message: `投放活动已经是「${rule.to}」，不用重复操作` }
  }
  if (!rule.from.includes(current)) {
    return {
      ok: false,
      message: `投放活动只能按 ${CAMPAIGN_FLOW_TEXT} 推进，当前「${current}」不能执行「${action}」`,
    }
  }
  row.status = rule.to
  row.pending = !['投放中', '已结束'].includes(rule.to)
  row.abnormal = false

  let stopped = 0
  if (rule.to === '已暂停' || rule.to === '已结束') {
    const code = String(row['活动编号'])
    for (const report of draft.roi ?? []) {
      if (String(report['关联活动']) === code && String(report.status) === '计算中') {
        report.status = '草稿'
        report.pending = true
        report['核算断点'] = `计算中断于批次 ${String(report['核算批次'])}（活动${rule.to}），重新提交计算可继续`
        stopped += 1
      }
    }
  }
  const suffix = stopped > 0 ? `；已停止 ${stopped} 份未完成的计算并保留可继续位置` : ''
  return { ok: true, message: `投放活动已${action}，当前状态「${rule.to}」${suffix}` }
}

/**
 * 旧数据迁移：补齐核算批次等新增字段，并把已确认报告的批次对齐到活动侧，
 * 修复「ROI列表显示已确认，活动侧却残留旧核算批次」的历史不一致。
 */
export function normalizeStore(store: StoreDraft): StoreDraft {
  const campaigns = store.campaign
  const reports = store.roi
  if (!campaigns || !reports) {
    return store
  }
  for (const campaign of campaigns) {
    if (typeof campaign['最近核算批次'] !== 'string' || campaign['最近核算批次'] === '') {
      campaign['最近核算批次'] = NO_BATCH
    }
    if (typeof campaign['批次投入金额'] !== 'number') {
      campaign['批次投入金额'] = 0
    }
  }
  for (const report of reports) {
    // 旧数据「关联活动」写的是样例文本，按报告编号对齐到同序号活动。
    let campaign = campaigns.find((row) => String(row['活动编号']) === String(report['关联活动'] ?? ''))
    if (!campaign) {
      const matched = /^ROI-(\d+)$/.exec(String(report['报告编号'] ?? ''))
      if (matched) {
        campaign = campaigns.find((row) => String(row['活动编号']) === `CAMP-${matched[1]}`)
        if (campaign) {
          report['关联活动'] = campaign['活动编号']
        }
      }
    }
    if (typeof report['核算断点'] !== 'string') {
      report['核算断点'] = ''
    }
    const status = String(report.status)
    if (typeof report['核算批次'] !== 'string' || report['核算批次'] === '') {
      if (status === '草稿') {
        report['核算批次'] = NO_BATCH
      } else if (campaign) {
        if (campaign['最近核算批次'] === NO_BATCH) {
          campaign['最近核算批次'] = nextBatchId(String(campaign['活动编号']), '')
          campaign['批次投入金额'] = Number(report['投入金额']) || 0
        }
        report['核算批次'] = campaign['最近核算批次']
      } else {
        report['核算批次'] = NO_BATCH
      }
    }
    // 已确认/已归档的报告是结算事实：活动侧批次以报告为准，保证两处对得上。
    if ((status === '已确认' || status === '已归档') && campaign && report['核算批次'] !== NO_BATCH) {
      campaign['最近核算批次'] = report['核算批次']
    }
  }
  return store
}
