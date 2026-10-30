import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Download, FileUp, RefreshCw } from 'lucide-react'
import { apiRequest, useAuth } from './auth/AuthContext'
import InvestigationNetwork from './components/InvestigationNetwork'
import './workflows.css'

type CaseRow = { id: string; title: string; description: string; status: string; created_at: string; updated_at: string }
type Transaction = {
  id: string
  transaction_id: string
  sender_account: string
  receiver_account: string
  amount: number
  currency: string
  timestamp: string
  transaction_type: string
  description: string
}
type Finding = {
  id: string
  rule_name: string
  severity: string
  explanation: string
  supporting_transaction_ids: string[]
  account_ids: string[]
  threshold: string
  recommended_next_step: string
}
type CaseData = {
  investigation: CaseRow
  transactions: Transaction[]
  findings: Finding[]
  notes: { id: string; note: string; created_at: string }[]
}
type Preview = {
  headers: string[]
  totalRows: number
  validRows: unknown[]
  invalidRows: { rowNumber: number; reasons: string[] }[]
  duplicateRows: { rowNumber: number; reason: string }[]
  missingMappings?: string[]
}
type DownloadFormat = 'json' | 'pdf' | 'xlsx' | 'transactions' | 'findings'

const errorMessage = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback

function CaseFrame({ title, children }: { title: string; children: React.ReactNode }) {
  const { user } = useAuth()
  return (
    <main className="workflow-page">
      <header className="workflow-header">
        <Link className="workflow-brand" to="/app">Mule<span>Shield</span></Link>
        <nav aria-label="Workspace navigation">
          <Link to="/app">Overview</Link><Link to="/app/investigations">Manual Investigation</Link>
          <Link to="/app/monitoring">Live Monitoring</Link><Link to="/app/cases">Cases</Link>
          <Link to="/app/alerts">Alerts</Link><Link to="/app/reports">Reports</Link>
          {user?.role === 'ADMINISTRATOR' && <Link to="/app/admin">Admin</Link>}
          <Link to="/app/security">Security</Link>
        </nav>
      </header>
      <section className="workflow-content">
        <Link className="workflow-back" to="/app"><ArrowLeft size={14} /> Overview</Link>
        <div className="card-kicker">MULESHIELD · INVESTIGATION WORKSPACE</div>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  )
}

export function InvestigationDetailPage() {
  const { id = '' } = useParams()
  const [data, setData] = useState<CaseData | null>(null)
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [noteBusy, setNoteBusy] = useState(false)
  const [exporting, setExporting] = useState<DownloadFormat | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await apiRequest<CaseData>(`/api/investigations/${id}`))
      setError('')
    } catch (reason) {
      setError(errorMessage(reason, 'Case unavailable.'))
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  async function selectFile(file?: File) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv') || file.size > 4194304) {
      setError('Choose a CSV no larger than 4 MB.')
      return
    }
    setCsv(await file.text())
    setPreview(null)
    setError('')
  }

  async function previewCsv(event: FormEvent) {
    event.preventDefault()
    setError('')
    setNotice('')
    setImportBusy(true)
    try {
      const result = await apiRequest<Preview>(`/api/investigations/${id}/csv/preview`, { csv, mapping })
      setPreview(result)
      const defaults: Record<string, string> = {}
      for (const field of ['transaction_id', 'sender_account', 'receiver_account', 'amount', 'timestamp']) {
        if (result.headers.includes(field)) defaults[field] = field
      }
      setMapping((old) => ({ ...defaults, ...old }))
    } catch (reason) {
      setError(errorMessage(reason, 'Preview failed.'))
    } finally {
      setImportBusy(false)
    }
  }

  async function importCsv() {
    setError('')
    setNotice('')
    setImportBusy(true)
    try {
      const result = await apiRequest<{ imported: number }>(`/api/investigations/${id}/csv/import`, { csv, mapping, confirm: true })
      setNotice(`${result.imported} valid records imported; invalid and duplicate records were excluded.`)
      setCsv('')
      setPreview(null)
      await load()
    } catch (reason) {
      setError(errorMessage(reason, 'Import failed.'))
    } finally {
      setImportBusy(false)
    }
  }

  async function analyze() {
    setError('')
    setNotice('')
    setAnalysisBusy(true)
    try {
      const result = await apiRequest<{ findings: Finding[]; createdCount: number; updatedCount: number }>(
        `/api/investigations/${id}/analyze`,
        {},
      )
      setNotice(`Analysis completed: ${result.createdCount} finding${result.createdCount === 1 ? '' : 's'} created, ${result.updatedCount} updated. Findings are deterministic rule-based review signals, not proof of fraud.`)
      await load()
    } catch (reason) {
      setError(errorMessage(reason, 'Analysis failed.'))
    } finally {
      setAnalysisBusy(false)
    }
  }

  async function saveNote(event: FormEvent) {
    event.preventDefault()
    setError('')
    setNotice('')
    setNoteBusy(true)
    try {
      await apiRequest(`/api/investigations/${id}/notes`, { note })
      setNote('')
      setNotice('Investigation note saved. Saved notes are included in reports.')
      await load()
    } catch (reason) {
      setError(errorMessage(reason, 'The note could not be saved.'))
    } finally {
      setNoteBusy(false)
    }
  }

  async function downloadReport(format: DownloadFormat) {
    setError('')
    setNotice('')
    setExporting(format)
    try {
      const path = format === 'json'
        ? `/api/investigations/${id}/report`
        : `/api/investigations/${id}/report/${format === 'transactions' || format === 'findings' ? 'csv' : format}${format === 'findings' ? '?type=findings' : ''}`
      const response = await fetch(path, { credentials: 'include' })
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(result.error || 'The report could not be downloaded.')
      }
      const blob = format === 'json'
        ? new Blob([JSON.stringify((await response.json()).report, null, 2)], { type: 'application/json' })
        : await response.blob()
      if (!blob.size) throw new Error('The server returned an empty report.')
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      const suffix = format === 'transactions' ? 'Transactions' : format === 'findings' ? 'Findings' : 'Report'
      const extension = format === 'transactions' || format === 'findings' ? 'csv' : format
      anchor.download = `MuleShield_${id}_${suffix}.${extension}`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(`${suffix} download is ready.`)
    } catch (reason) {
      setError(errorMessage(reason, 'The report could not be downloaded.'))
    } finally {
      setExporting(null)
    }
  }

  const accounts = [...new Set(data?.transactions.flatMap((transaction) => [transaction.sender_account, transaction.receiver_account]) || [])]
  const findingsBySeverity = data?.findings.reduce<Record<string, number>>((counts, finding) => {
    const severity = finding.severity.toUpperCase()
    counts[severity] = (counts[severity] || 0) + 1
    return counts
  }, {}) || {}
  const severityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']
  const severityRows = Object.entries(findingsBySeverity).sort(([left], [right]) => {
    const leftIndex = severityOrder.indexOf(left)
    const rightIndex = severityOrder.indexOf(right)
    return (leftIndex < 0 ? severityOrder.length : leftIndex) - (rightIndex < 0 ? severityOrder.length : rightIndex) || left.localeCompare(right)
  })
  const findingsByRule = data?.findings.reduce<Map<string, number>>((counts, finding) => {
    counts.set(finding.rule_name, (counts.get(finding.rule_name) || 0) + 1)
    return counts
  }, new Map()) || new Map<string, number>()
  const multiFindingAccounts = (() => {
    const counts = new Map<string, number>()
    for (const finding of data?.findings || []) {
      for (const account of new Set(finding.account_ids || [])) counts.set(account, (counts.get(account) || 0) + 1)
    }
    return [...counts].filter(([, count]) => count > 1).sort(([, left], [, right]) => right - left)
  })()
  if (!data) {
    return <CaseFrame title="Investigation">{error ? <div className="workflow-error" role="alert">{error}</div> : <p>Loading case…</p>}</CaseFrame>
  }

  return (
    <CaseFrame title={data.investigation.title}>
      {error && <div className="workflow-error" role="alert">{error}</div>}
      {notice && <div className="workflow-notice" role="status" aria-live="polite">{notice}</div>}
      <p>{data.investigation.description}</p>
      <div className="workflow-toolbar">
        <span>Status: {data.investigation.status}</span>
        <select
          aria-label="Case status"
          value={data.investigation.status}
          onChange={async (event) => {
            setError('')
            setNotice('')
            try {
              await apiRequest(`/api/investigations/${id}`, { status: event.target.value }, 'PATCH')
              await load()
              setNotice('Case status updated.')
            } catch (reason) {
              setError(errorMessage(reason, 'Case status could not be updated.'))
            }
          }}
        >
          <option>OPEN</option><option>IN_REVIEW</option><option>CLOSED</option>
        </select>
        <button className="button-secondary" type="button" onClick={() => void load()} aria-label="Refresh case data">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      <div className="workflow-stats">
        <div><strong>{data.transactions.length}</strong><span>Transactions</span></div>
        <div><strong>{accounts.length}</strong><span>Accounts</span></div>
        <div><strong>{data.findings.length}</strong><span>Findings</span></div>
      </div>
      <section className="workflow-panel risk-overview" aria-labelledby="risk-overview-title">
        <div className="risk-overview-heading">
          <div><h2 id="risk-overview-title">Risk overview</h2><p>Counts summarize saved rule-based findings; no numerical score or transaction-level risk classification is calculated.</p></div>
          <span className="risk-signal-label">REVIEW SIGNALS · NOT PROOF OF FRAUD</span>
        </div>
        <div className="risk-overview-grid">
          <div className="risk-chart" role="img" aria-label={`Findings by severity: ${severityRows.map(([severity, count]) => `${severity} ${count}`).join(', ') || 'no findings'}`}>
            <h3>Findings by severity</h3>
            {severityRows.length === 0
              ? <p>No saved findings to summarize.</p>
              : severityRows.map(([severity, count]) => (
                <div className="risk-severity-row" key={severity}>
                  <span>{severity}</span><div className="risk-bar-track"><div className={`risk-bar-fill severity-${severity.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`} style={{ width: `${Math.max(4, count / Math.max(...severityRows.map(([, value]) => value)) * 100)}%` }} /></div><strong>{count}</strong>
                </div>
              ))}
          </div>
          <div className="risk-indicators">
            <h3>Available indicators</h3>
            {findingsByRule.size === 0
              ? <p>No rule-based indicators are recorded.</p>
              : [...findingsByRule].map(([rule, count]) => <div className="risk-indicator-row" key={rule}><span>{rule}</span><strong>{count}</strong></div>)}
            <h3>Accounts in multiple findings</h3>
            {multiFindingAccounts.length === 0
              ? <p>No account appears in more than one saved finding.</p>
              : <ul className="risk-account-list">{multiFindingAccounts.slice(0, 6).map(([account, count]) => <li key={account}><span>{account}</span><strong>{count} findings</strong></li>)}</ul>}
          </div>
        </div>
      </section>
      <div className="workflow-two-col">
        <section className="workflow-panel">
          <h2>CSV import</h2>
          <p>Max 4 MB / 25,000 rows. Required fields: transaction_id, sender_account, receiver_account, amount, timestamp.</p>
          <input aria-label="Choose transaction CSV file" type="file" accept=".csv,text/csv" onChange={(event) => void selectFile(event.target.files?.[0])} />
          {csv && <form onSubmit={previewCsv}><button className="button-primary" disabled={importBusy}><FileUp size={14} /> Preview and validate</button></form>}
          {preview && (
            <div className="preview-summary">
              <strong>{preview.totalRows} rows · valid {preview.validRows.length} · invalid {preview.invalidRows.length} · duplicates {preview.duplicateRows.length}</strong>
              {preview.missingMappings?.length
                ? <p>Missing mappings: {preview.missingMappings.join(', ')}</p>
                : <div className="mapping-grid">{['transaction_id', 'sender_account', 'receiver_account', 'amount', 'timestamp'].map((field) => (
                  <label key={field}>{field}<select value={mapping[field] || ''} onChange={(event) => setMapping({ ...mapping, [field]: event.target.value })}>
                    <option value="">Select column</option>{preview.headers.map((header) => <option key={header}>{header}</option>)}
                  </select></label>
                ))}</div>}
              {preview.invalidRows.map((row) => <small className="invalid-row" key={row.rowNumber}>Row {row.rowNumber}: {row.reasons.join('; ')}</small>)}
              {preview.duplicateRows.map((row) => <small className="invalid-row" key={row.rowNumber}>Row {row.rowNumber}: {row.reason}</small>)}
              <button className="button-primary" type="button" disabled={importBusy || Boolean(preview.missingMappings?.length) || preview.validRows.length === 0} onClick={() => void importCsv()}>
                {importBusy ? 'Importing…' : 'Confirm import valid rows'}
              </button>
            </div>
          )}
        </section>
        <section className="workflow-panel">
          <h2>Deterministic analysis</h2>
          <p>Review signals are produced by deterministic rules applied to saved case transactions. They are not proof of fraud.</p>
          <button className="button-primary" type="button" disabled={analysisBusy || importBusy || data.transactions.length === 0} onClick={() => void analyze()} aria-busy={analysisBusy}>
            {analysisBusy ? 'Analysis running…' : 'Run analysis'} {analysisBusy ? <RefreshCw size={14} className="spin" /> : <ArrowRight size={14} />}
          </button>
          <p>Velocity · destination splitting · multiple incoming counterparties</p>
        </section>
      </div>
      <InvestigationNetwork transactions={data.transactions} findings={data.findings} />
      <div className="workflow-two-col">
        <section className="workflow-panel">
          <h2>Findings</h2>
          {data.findings.length === 0 && <p>No findings have been saved for this case.</p>}
          {data.findings.map((finding) => <article className="finding-row" key={finding.id}>
            <strong>{finding.severity} · {finding.rule_name}</strong>
            <p>{finding.explanation}</p>
            <small>{finding.threshold}. Supporting: {finding.supporting_transaction_ids.join(', ')}</small>
          </article>)}
          <p>Findings are rule-based review signals, not proof of fraud.</p>
        </section>
        <section className="workflow-panel">
          <h2>Report and notes</h2>
          <div className="report-controls" aria-label="Download case reports">
            <button className="button-secondary" type="button" disabled={exporting !== null} onClick={() => void downloadReport('json')} aria-label="Generate JSON report">
              {exporting === 'json' ? 'Preparing JSON…' : 'Generate JSON report'} <Download size={14} />
            </button>
            <button className="button-secondary" type="button" disabled={exporting !== null} onClick={() => void downloadReport('pdf')} aria-label="Download PDF report">
              {exporting === 'pdf' ? 'Preparing PDF…' : 'Download PDF'}
            </button>
            <button className="button-secondary" type="button" disabled={exporting !== null} onClick={() => void downloadReport('xlsx')} aria-label="Download Excel workbook">
              {exporting === 'xlsx' ? 'Preparing Excel…' : 'Download Excel (.xlsx)'}
            </button>
            <button className="button-secondary" type="button" disabled={exporting !== null} onClick={() => void downloadReport('transactions')} aria-label="Download transactions CSV">
              {exporting === 'transactions' ? 'Preparing CSV…' : 'Download transactions CSV'}
            </button>
            <button className="button-secondary" type="button" disabled={exporting !== null} onClick={() => void downloadReport('findings')} aria-label="Download findings CSV">
              {exporting === 'findings' ? 'Preparing CSV…' : 'Download findings CSV'}
            </button>
          </div>
          <form className="note-form" onSubmit={saveNote}>
            <textarea aria-label="Investigation note" value={note} onChange={(event) => setNote(event.target.value)} required maxLength={4000} rows={3} placeholder="Investigation note" />
            <button className="button-secondary" disabled={noteBusy || !note.trim()} aria-busy={noteBusy}>
              {noteBusy ? 'Saving note…' : 'Save note'}
            </button>
          </form>
          {data.notes.map((item) => <p className="saved-note" key={item.id}>{new Date(item.created_at).toLocaleString()} · {item.note}</p>)}
        </section>
      </div>
      <section className="workflow-panel">
        <h2>Transactions</h2>
        {data.transactions.length === 0
          ? <p>No transactions are saved for this case.</p>
          : <div className="table-scroll"><table><thead><tr><th>ID</th><th>From</th><th>To</th><th>Amount</th><th>Time</th></tr></thead>
            <tbody>{data.transactions.map((transaction) => <tr key={transaction.id}>
              <td>{transaction.transaction_id}</td><td>{transaction.sender_account}</td><td>{transaction.receiver_account}</td>
              <td>{transaction.amount} {transaction.currency}</td><td>{new Date(transaction.timestamp).toLocaleString()}</td>
            </tr>)}</tbody></table></div>}
      </section>
    </CaseFrame>
  )
}
