import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  confirmRoiReport,
  downloadEntries,
  listEntries,
  moduleMeta,
  prepareRoiConfirmation,
  runAction as applyAction,
} from '@/api/local-service'
import { NO_BATCH, type ConfirmEvaluation } from '@/domain/roi-settlement'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('roi')
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses

function cellText(row: EntryRow, column: string): string | number {
  const value = row[column]
  if (value === undefined || value === null || value === '') {
    return '—'
  }
  return typeof value === 'boolean' ? String(value) : value
}

export default function RoiView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [infoMessage, setInfoMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [confirmView, setConfirmView] = useState<ConfirmEvaluation | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'ROI评估列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setInfoMessage('')
    if (action === '确认报告') {
      // 确认报告必须先打开确认页，核对活动周期与核算批次。
      setConfirmView(prepareRoiConfirmation(Number(row.id)))
      return
    }
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setInfoMessage(result.message)
    reload()
  }

  function closeConfirm() {
    setConfirmView(null)
  }

  function doConfirm() {
    if (!confirmView?.report) {
      return
    }
    const reportId = Number(confirmView.report.id)
    const result = confirmRoiReport(reportId)
    if (!result.ok) {
      // 确认被阻止：刷新核对结果，展示最新阻止原因，列表同步持久状态。
      setErrorMessage(result.message)
      setConfirmView(prepareRoiConfirmation(reportId))
      reload()
      return
    }
    setInfoMessage(result.message)
    setConfirmView(null)
    reload()
  }

  const statItems = [
    { label: 'ROI报告总数', value: rows.length },
    { label: '已确认报告', value: rows.filter((row) => String(row.status) === '已确认').length },
    { label: '计算中报告', value: rows.filter((row) => String(row.status) === '计算中').length },
  ]

  return (
    <section className="page" data-module="roi">
      <header className="page-head">
        <div>
          <h2>ROI评估管理</h2>
          <p className="page-desc">计算和评估各投放活动与渠道的投资回报率，跟踪CPC、CPM和收入指标。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('ROI报告登记入口尚未接入审批流')}>
            登记ROI报告
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出ROI评估清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {statItems.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{cellText(row, column)}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无ROI评估数据，可先登记ROI报告</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条ROI评估记录</span>
        {infoMessage && <span className="info-text">{infoMessage}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>

      {confirmView && (
        <div className="modal-mask" onClick={closeConfirm}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3 className="modal-title">
              报告确认 · {String(confirmView.report?.['报告编号'] ?? '未知报告')}
            </h3>

            <div className="confirm-grid">
              <section className="confirm-card" data-side="campaign">
                <h4>关联活动 {confirmView.campaign ? String(confirmView.campaign['活动编号']) : '（未找到）'}</h4>
                <dl>
                  <dt>开始日期</dt>
                  <dd>{confirmView.campaign ? String(confirmView.campaign['开始日期'] ?? '—') : '—'}</dd>
                  <dt>结束日期</dt>
                  <dd>{confirmView.campaign ? String(confirmView.campaign['结束日期'] ?? '—') : '—'}</dd>
                  <dt>活动状态</dt>
                  <dd>{confirmView.campaign ? String(confirmView.campaign.status) : '—'}</dd>
                  <dt>最近核算批次</dt>
                  <dd>{confirmView.campaign ? String(confirmView.campaign['最近核算批次'] ?? NO_BATCH) : '—'}</dd>
                </dl>
              </section>

              <section className="confirm-card" data-side="roi">
                <h4>ROI报告 {confirmView.report ? String(confirmView.report['报告编号']) : '（未找到）'}</h4>
                <dl>
                  <dt>投入金额</dt>
                  <dd>{confirmView.report ? cellText(confirmView.report, '投入金额') : '—'}</dd>
                  <dt>转化收入</dt>
                  <dd>{confirmView.report ? cellText(confirmView.report, '转化收入') : '—'}</dd>
                  <dt>评估周期</dt>
                  <dd>{confirmView.report ? cellText(confirmView.report, '评估周期') : '—'}</dd>
                  <dt>最近核算批次</dt>
                  <dd>{confirmView.report ? cellText(confirmView.report, '核算批次') : '—'}</dd>
                  <dt>核算断点</dt>
                  <dd>{confirmView.report ? cellText(confirmView.report, '核算断点') : '—'}</dd>
                </dl>
              </section>
            </div>

            <ul className="check-list">
              {confirmView.checks.map((check) => (
                <li key={check.label} className={check.ok ? 'ok' : 'fail'}>
                  {check.ok ? '✓' : '✗'} {check.label}：{check.message}
                </li>
              ))}
            </ul>

            <div className="conclusion-box">
              {confirmView.canConfirm ? (
                <p>
                  试算ROI（非正式结论）：<strong>{confirmView.trialRoi ?? '—'}</strong>
                  ，点击「确认报告」后生成正式ROI结论并冻结，后续活动改期不再覆盖。
                </p>
              ) : (
                <p className="error-text">正式ROI结论：暂不提供。{confirmView.blockReason}</p>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn primary" type="button" disabled={!confirmView.canConfirm} onClick={doConfirm}>
                确认报告
              </button>
              <button className="btn" type="button" onClick={closeConfirm}>返回</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
