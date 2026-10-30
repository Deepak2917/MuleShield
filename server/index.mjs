import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import ExcelJS from 'exceljs'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { Secret, TOTP } from 'otpauth'
import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
const isProduction = process.env.NODE_ENV === 'production'
const sessionHours = Number(process.env.SESSION_HOURS || 8)
const encryptionKeyHex = process.env.MULESHIELD_ENCRYPTION_KEY || ''
if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
  console.error('MULESHIELD_ENCRYPTION_KEY must be a 32-byte hex value. See .env.example.')
  process.exit(1)
}
const encryptionKey = Buffer.from(encryptionKeyHex, 'hex')

const dbPath = process.env.MULESHIELD_DB_PATH || path.join(__dirname, '..', 'data', 'muleshield.sqlite')
await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(dbPath), { recursive: true }))
const db = new DatabaseSync(dbPath)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('ANALYST', 'ADMINISTRATOR')),
    enabled INTEGER NOT NULL DEFAULT 1, mfa_enabled INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT, pending_totp_secret TEXT, last_totp_step INTEGER,
    recovery_hashes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mfa_challenges (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS mfa_enrollment_challenges (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY, event_type TEXT NOT NULL, timestamp TEXT NOT NULL,
    actor_id TEXT, object_id TEXT, success INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS investigations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    reported_amount REAL, currency TEXT NOT NULL DEFAULT 'USD', date_from TEXT, date_to TEXT,
    known_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'OPEN',
    owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL, sender_account TEXT NOT NULL, receiver_account TEXT NOT NULL,
    amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', timestamp TEXT NOT NULL,
    transaction_type TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    UNIQUE(investigation_id, transaction_id)
  );
  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    rule_name TEXT NOT NULL, severity TEXT NOT NULL, explanation TEXT NOT NULL,
    supporting_transaction_ids TEXT NOT NULL, account_ids TEXT NOT NULL, timestamps TEXT NOT NULL,
    amounts TEXT NOT NULL, threshold TEXT NOT NULL, recommended_next_step TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS investigation_notes (
    id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id), note TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS monitoring_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), status TEXT NOT NULL DEFAULT 'STOPPED',
    events_processed INTEGER NOT NULL DEFAULT 0, started_at TEXT, updated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO monitoring_state(singleton,status,updated_at) VALUES (1,'STOPPED',CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS audit_timestamp_idx ON audit_events(timestamp);
  CREATE INDEX IF NOT EXISTS investigations_owner_idx ON investigations(owner_id,updated_at);
  CREATE INDEX IF NOT EXISTS transactions_case_idx ON transactions(investigation_id,timestamp);
  CREATE INDEX IF NOT EXISTS findings_case_idx ON findings(investigation_id,created_at);
`)

const nowIso = () => new Date().toISOString()
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex')
const safeEqual = (a, b) => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')
}
function encryptSecret(secret) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv)
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`
}
function decryptSecret(value) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'hex'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
function audit(eventType, { actorId = null, objectId = null, success = true, metadata = {} } = {}) {
  db.prepare('INSERT INTO audit_events (id,event_type,timestamp,actor_id,object_id,success,metadata) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), eventType, nowIso(), actorId, objectId, success ? 1 : 0, JSON.stringify(metadata))
}
function cookieOptions(maxAge) {
  return { httpOnly: true, secure: isProduction, sameSite: 'strict', path: '/', maxAge }
}
function clearCookie(res, name) {
  res.clearCookie(name, { httpOnly: true, secure: isProduction, sameSite: 'strict', path: '/' })
}

app.disable('x-powered-by')
app.use(express.json({ limit: '5mb' }))
app.use((req, _res, next) => {
  req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const separator = part.indexOf('=')
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]
  }))
  next()
})
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const origin = req.get('origin')
    const allowed = new Set((isProduction ? [process.env.APP_ORIGIN] : ['http://localhost:5173', 'http://127.0.0.1:5173', process.env.APP_ORIGIN]).filter(Boolean))
    if (!origin || !allowed.has(origin)) return res.status(403).json({ error: 'Request origin is not allowed.' })
  }
  next()
})
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many authentication attempts. Try again later.' } })
const mfaLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many verification attempts. Try again later.' } })

function authenticated(req, res, next) {
  const token = req.cookies?.ms_session || req.get('x-muleshield-session')
  if (!token) return res.status(401).json({ error: 'Authentication required.' })
  const session = db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.enabled=1 AND users.mfa_enabled=1`)
    .get(hashToken(token), nowIso())
  if (!session) return res.status(401).json({ error: 'Session expired. Sign in again.' })
  req.user = session
  next()
}
function enrollmentChallenge(req, res, next) {
  const token = req.cookies?.ms_mfa_enroll
  if (!token) return res.status(401).json({ error: 'MFA enrollment is required. Sign in again to continue.' })
  const challenge = db.prepare(`SELECT mfa_enrollment_challenges.*, users.* FROM mfa_enrollment_challenges JOIN users ON users.id=mfa_enrollment_challenges.user_id WHERE token_hash=? AND expires_at>?`)
    .get(hashToken(token), nowIso())
  if (!challenge || challenge.attempts >= 5 || !challenge.enabled || challenge.mfa_enabled) {
    clearCookie(res, 'ms_mfa_enroll')
    return res.status(401).json({ error: 'Invalid or expired enrollment challenge. Sign in again.' })
  }
  req.enrollmentChallenge = challenge
  next()
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'ADMINISTRATOR') return res.status(403).json({ error: 'Administrator permission required.' })
  next()
}
function safeUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, mfaEnabled: Boolean(user.mfa_enabled), createdAt: user.created_at }
}
function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url')
  const created = new Date()
  const expires = new Date(created.getTime() + sessionHours * 3600000)
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(hashToken(token), userId, created.toISOString(), expires.toISOString())
  res.cookie('ms_session', token, cookieOptions(sessionHours * 3600000))
}
function createTotp(user, secret) {
  return new TOTP({ issuer: 'MuleShield', label: user.email, algorithm: 'SHA1', digits: 6, period: 30, secret })
}
function generateRecoveryCodes() {
  return Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase())
}
function caseAccess(req, res, investigationId) {
  const record = db.prepare('SELECT * FROM investigations WHERE id=?').get(investigationId)
  if (!record) { res.status(404).json({ error: 'Investigation not found.' }); return null }
  if (record.owner_id !== req.user.id && req.user.role !== 'ADMINISTRATOR') { res.status(404).json({ error: 'Investigation not found.' }); return null }
  return record
}
function parseCsv(input) {
  const rows = []
  let row = []; let cell = ''; let quoted = false
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quoted && char === '"' && input[i + 1] === '"') { cell += '"'; i += 1 }
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i += 1
      row.push(cell); cell = ''
      if (row.some((value) => value.trim() !== '')) rows.push(row)
      row = []
    } else cell += char
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.')
  row.push(cell)
  if (row.some((value) => value.trim() !== '')) rows.push(row)
  if (rows.length === 0) return { headers: [], records: [] }
  const headers = rows[0].map((value) => value.trim().replace(/^\uFEFF/, ''))
  if (new Set(headers).size !== headers.length) throw new Error('CSV column names must be unique.')
  return { headers, records: rows.slice(1).map((cells, index) => ({ rowNumber: index + 2, cells })) }
}
function validateCsvText(csv, mapping = {}) {
  const { headers, records } = parseCsv(csv)
  if (headers.length === 0) return { headers, totalRows: 0, validRows: [], invalidRows: [], duplicateRows: [] }
  const fields = ['transaction_id', 'sender_account', 'receiver_account', 'amount', 'timestamp']
  const resolved = Object.fromEntries(fields.map((field) => [field, mapping[field] || (headers.includes(field) ? field : '')]))
  const missingMappings = fields.filter((field) => !headers.includes(resolved[field]))
  if (missingMappings.length) return { headers, totalRows: records.length, validRows: [], invalidRows: [], duplicateRows: [], missingMappings }
  const ids = new Set()
  const validRows = []; const invalidRows = []; const duplicateRows = []
  for (const record of records) {
    const value = (field) => record.cells[headers.indexOf(resolved[field])] ?? ''
    const transactionId = value('transaction_id').trim()
    const sender = value('sender_account').trim()
    const receiver = value('receiver_account').trim()
    const amountText = value('amount').trim()
    const timestamp = value('timestamp').trim()
    const amount = Number(amountText)
    const reasons = []
    if (!transactionId) reasons.push('Missing transaction_id')
    if (!sender) reasons.push('Missing sender_account')
    if (!receiver) reasons.push('Missing receiver_account')
    if (!amountText || !Number.isFinite(amount) || amount <= 0) reasons.push('amount must be a positive number')
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) reasons.push('timestamp must be a valid date/time')
    if (transactionId && ids.has(transactionId)) { duplicateRows.push({ rowNumber: record.rowNumber, transactionId, reason: 'Duplicate ID within upload' }); continue }
    if (transactionId) ids.add(transactionId)
    if (reasons.length) invalidRows.push({ rowNumber: record.rowNumber, reasons })
    else validRows.push({ rowNumber: record.rowNumber, transaction_id: transactionId, sender_account: sender, receiver_account: receiver, amount, timestamp: new Date(timestamp).toISOString(), currency: (record.cells[headers.indexOf(mapping.currency || 'currency')] || 'USD').trim().toUpperCase() || 'USD', transaction_type: (record.cells[headers.indexOf(mapping.transaction_type || 'transaction_type')] || '').trim(), description: (record.cells[headers.indexOf(mapping.description || 'description')] || '').trim() })
  }
  return { headers, totalRows: records.length, validRows, invalidRows, duplicateRows, missingMappings: [] }
}
function findingsFor(investigationId, transactions) {
  const findings = []
  const outbound = new Map()
  for (const transaction of transactions) {
    const current = outbound.get(transaction.sender_account) || []
    current.push(transaction)
    outbound.set(transaction.sender_account, current)
  }
  for (const [account, sent] of outbound) {
    const ordered = [...sent].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    if (ordered.length >= 3) findings.push({ rule_name: 'High transaction velocity', severity: 'MEDIUM', explanation: `Account ${account} sent ${ordered.length} transactions in the imported dataset. This is a review signal, not a fraud conclusion.`, supporting_transaction_ids: ordered.map((item) => item.transaction_id), account_ids: [account, ...ordered.map((item) => item.receiver_account)], timestamps: ordered.map((item) => item.timestamp), amounts: ordered.map((item) => ({ amount: item.amount, currency: item.currency })), threshold: '3 or more outgoing transactions in the imported dataset', recommended_next_step: 'Review the supporting transactions and compare activity with authorized account context.' })
    const destinations = new Set(sent.map((item) => item.receiver_account))
    if (destinations.size >= 3) findings.push({ rule_name: 'Fund splitting across destinations', severity: 'MEDIUM', explanation: `Account ${account} sent funds to ${destinations.size} distinct destinations in the imported dataset.`, supporting_transaction_ids: sent.map((item) => item.transaction_id), account_ids: [account, ...destinations], timestamps: sent.map((item) => item.timestamp), amounts: sent.map((item) => ({ amount: item.amount, currency: item.currency })), threshold: '3 or more distinct destinations', recommended_next_step: 'Review destination relationships and the applicable case context.' })
  }
  const incoming = new Map()
  for (const transaction of transactions) {
    const senders = incoming.get(transaction.receiver_account) || new Set()
    senders.add(transaction.sender_account); incoming.set(transaction.receiver_account, senders)
  }
  for (const [account, senders] of incoming) if (senders.size >= 3) {
    const supporting = transactions.filter((item) => item.receiver_account === account)
    findings.push({ rule_name: 'Multiple incoming counterparties', severity: 'LOW', explanation: `Account ${account} received transfers from ${senders.size} distinct accounts in the imported dataset.`, supporting_transaction_ids: supporting.map((item) => item.transaction_id), account_ids: [account, ...senders], timestamps: supporting.map((item) => item.timestamp), amounts: supporting.map((item) => ({ amount: item.amount, currency: item.currency })), threshold: '3 or more distinct senders', recommended_next_step: 'Review the incoming transfers and verify the underlying source records.' })
  }
  const existing = db.prepare('SELECT id,rule_name,account_ids FROM findings WHERE investigation_id=? ORDER BY created_at').all(investigationId)
  const existingByRuleAndAccount = new Map()
  for (const row of existing) {
    const key = `${row.rule_name}\u0000${JSON.parse(row.account_ids)[0] || ''}`
    if (!existingByRuleAndAccount.has(key)) existingByRuleAndAccount.set(key, row.id)
  }
  const insert = db.prepare(`INSERT INTO findings(id,investigation_id,rule_name,severity,explanation,supporting_transaction_ids,account_ids,timestamps,amounts,threshold,recommended_next_step,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  const update = db.prepare(`UPDATE findings SET severity=?,explanation=?,supporting_transaction_ids=?,account_ids=?,timestamps=?,amounts=?,threshold=?,recommended_next_step=? WHERE id=?`)
  let createdCount = 0
  let updatedCount = 0
  const savedFindings = findings.map((finding) => {
    const key = `${finding.rule_name}\u0000${finding.account_ids[0] || ''}`
    const id = existingByRuleAndAccount.get(key)
    if (id) {
      update.run(finding.severity, finding.explanation, JSON.stringify(finding.supporting_transaction_ids), JSON.stringify(finding.account_ids), JSON.stringify(finding.timestamps), JSON.stringify(finding.amounts), finding.threshold, finding.recommended_next_step, id)
      updatedCount += 1
      return { id, ...finding }
    }
    const newId = crypto.randomUUID()
    insert.run(newId, investigationId, finding.rule_name, finding.severity, finding.explanation, JSON.stringify(finding.supporting_transaction_ids), JSON.stringify(finding.account_ids), JSON.stringify(finding.timestamps), JSON.stringify(finding.amounts), finding.threshold, finding.recommended_next_step, nowIso())
    createdCount += 1
    return { id: newId, ...finding }
  })
  return { findings: savedFindings, createdCount, updatedCount }
}

function caseReportFor(investigation) {
  const transactions = db.prepare('SELECT * FROM transactions WHERE investigation_id=? ORDER BY timestamp').all(investigation.id)
  const findings = db.prepare('SELECT rule_name,severity,explanation,supporting_transaction_ids,account_ids,timestamps,amounts,threshold,recommended_next_step FROM findings WHERE investigation_id=? ORDER BY created_at').all(investigation.id)
    .map((item) => ({ ...item, supporting_transaction_ids: JSON.parse(item.supporting_transaction_ids), account_ids: JSON.parse(item.account_ids), timestamps: JSON.parse(item.timestamps), amounts: JSON.parse(item.amounts) }))
  const notes = db.prepare('SELECT id,note,created_at FROM investigation_notes WHERE investigation_id=? ORDER BY created_at DESC').all(investigation.id)
  const accounts = [...new Set(transactions.flatMap((item) => [item.sender_account, item.receiver_account]))]
    .map((id) => ({
      id,
      sentCount: transactions.filter((item) => item.sender_account === id).length,
      receivedCount: transactions.filter((item) => item.receiver_account === id).length,
    }))
  return {
    investigationId: investigation.id,
    caseSummary: { title: investigation.title, description: investigation.description, status: investigation.status },
    datasetSource: 'CSV records imported by an authorized analyst',
    datasetCoverage: { transactionCount: transactions.length, observedAccountCount: accounts.length, from: transactions[0]?.timestamp ?? null, to: transactions.at(-1)?.timestamp ?? null },
    detectionRules: ['High transaction velocity', 'Fund splitting across destinations', 'Multiple incoming counterparties'],
    findings,
    supportingTransactions: transactions,
    accounts,
    riskOverview: riskOverviewFor(findings),
    notes,
    limitations: ['Findings are deterministic review signals, not proof of fraud.', 'Only accepted records from the uploaded dataset are represented.', 'No account ownership, KYC, balances, or unobserved transfers are inferred.'],
    recommendedNextSteps: findings.map((item) => item.recommended_next_step),
    generatedAt: nowIso(),
    environment: 'Imported case data; source provenance is per case upload.',
  }
}

function spreadsheetText(value) {
  const text = value == null ? '' : String(value)
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text
}

function csvCell(value) {
  const text = typeof value === 'string' ? spreadsheetText(value) : value == null ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

function reportCsv(headers, rows) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

function riskOverviewFor(findings) {
  const findingsBySeverity = new Map()
  const findingsByRule = new Map()
  const findingsByAccount = new Map()
  for (const finding of findings) {
    const severity = String(finding.severity || 'UNKNOWN').toUpperCase()
    findingsBySeverity.set(severity, (findingsBySeverity.get(severity) || 0) + 1)
    findingsByRule.set(finding.rule_name, (findingsByRule.get(finding.rule_name) || 0) + 1)
    for (const accountId of new Set(finding.account_ids)) {
      findingsByAccount.set(accountId, (findingsByAccount.get(accountId) || 0) + 1)
    }
  }
  const severityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN']
  return {
    findingsBySeverity: [...findingsBySeverity].sort(([left], [right]) => {
      const leftIndex = severityOrder.indexOf(left)
      const rightIndex = severityOrder.indexOf(right)
      return (leftIndex < 0 ? severityOrder.length : leftIndex) - (rightIndex < 0 ? severityOrder.length : rightIndex) || left.localeCompare(right)
    }).map(([severity, count]) => ({ severity, count })),
    findingsByRule: [...findingsByRule].sort(([left], [right]) => left.localeCompare(right)).map(([rule, count]) => ({ rule, count })),
    accountsWithMultipleFindings: [...findingsByAccount]
      .filter(([, count]) => count > 1)
      .sort(([, leftCount], [, rightCount]) => rightCount - leftCount)
      .map(([accountId, findingCount]) => ({ accountId, findingCount })),
  }
}

async function reportPdf(report) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true, compress: false })
    const chunks = []
    document.on('data', (chunk) => chunks.push(chunk))
    document.on('error', reject)
    document.on('end', () => resolve(Buffer.concat(chunks)))
    const pageWidth = document.page.width
    document.rect(0, 0, pageWidth, 100).fill('#0b171b')
    document.fillColor('#72dfd1').fontSize(13).font('Helvetica-Bold').text('MULESHIELD', 44, 27)
    document.fillColor('#ffffff').fontSize(21).text('Investigation Report', 44, 48)
    document.fillColor('#b2c4c6').fontSize(8).font('Helvetica').text(`Generated ${report.generatedAt}`, 44, 78)
    document.y = 119
    const ensureSpace = (height = 30) => {
      if (document.y + height > document.page.height - document.page.margins.bottom) document.addPage()
    }
    const section = (title) => {
      ensureSpace(28)
      document.moveDown(0.35).fillColor('#12665e').font('Helvetica-Bold').fontSize(12).text(title)
      document.moveDown(0.25).fillColor('#26363b').font('Helvetica').fontSize(9)
    }
    section('Case summary')
    document.text(`Case ID: ${report.investigationId}`)
    document.text(`Title: ${report.caseSummary.title}`)
    document.text(`Status: ${report.caseSummary.status}`)
    document.text(`Transactions: ${report.datasetCoverage.transactionCount}    Accounts: ${report.datasetCoverage.observedAccountCount}    Findings: ${report.findings.length}`)
    if (report.caseSummary.description) document.text(`Description: ${report.caseSummary.description}`)
    document.addPage()
    document.y = 48
    document.fillColor('#12665e').font('Helvetica-Bold').fontSize(16).text('Risk overview', 44, document.y)
    document.fillColor('#536267').font('Helvetica').fontSize(8).text('Counts are derived from saved rule findings; no numerical score or transaction-level risk classification is calculated.', 44, document.y + 8, { width: pageWidth - 88 })
    let chartY = document.y + 38
    const severityColors = { CRITICAL: '#a63636', HIGH: '#bd5b3e', MEDIUM: '#c28a30', LOW: '#397f71', INFO: '#48769b', UNKNOWN: '#69777b' }
    const maxSeverityCount = Math.max(1, ...report.riskOverview.findingsBySeverity.map((item) => item.count))
    for (const item of report.riskOverview.findingsBySeverity) {
      document.fillColor('#26363b').font('Helvetica').fontSize(9).text(`${item.severity} (${item.count})`, 44, chartY, { width: 110 })
      const barWidth = 250 * item.count / maxSeverityCount
      document.roundedRect(160, chartY + 1, 250, 10, 4).fill('#e8eeed')
      document.roundedRect(160, chartY + 1, Math.max(5, barWidth), 10, 4).fill(severityColors[item.severity] || '#69777b')
      chartY += 19
    }
    if (!report.riskOverview.findingsBySeverity.length) {
      document.fillColor('#536267').font('Helvetica').fontSize(9).text('No saved findings to summarize.', 44, chartY)
      chartY += 20
    }
    document.fillColor('#12665e').font('Helvetica-Bold').fontSize(10).text('Available indicators', 44, chartY + 5)
    chartY += 20
    if (!report.riskOverview.findingsByRule.length) {
      document.fillColor('#536267').font('Helvetica').fontSize(8).text('No rule-based indicators are recorded.', 44, chartY)
      chartY += 14
    } else {
      for (const item of report.riskOverview.findingsByRule) {
        document.fillColor('#26363b').font('Helvetica').fontSize(8).text(`${item.rule} — ${item.count} finding${item.count === 1 ? '' : 's'}`, 44, chartY, { width: pageWidth - 88 })
        chartY += 13
      }
    }
    if (report.riskOverview.accountsWithMultipleFindings.length) {
      document.fillColor('#12665e').font('Helvetica-Bold').fontSize(10).text('Accounts associated with multiple findings', 44, chartY + 5)
      chartY += 21
      for (const item of report.riskOverview.accountsWithMultipleFindings.slice(0, 8)) {
        document.fillColor('#26363b').font('Helvetica').fontSize(8).text(`${item.accountId} — ${item.findingCount} findings`, 44, chartY)
        chartY += 13
      }
    }
    document.addPage()
    document.y = 48
    document.fillColor('#12665e').font('Helvetica-Bold').fontSize(16).text('Transaction network graph', 44, document.y)
    document.fillColor('#536267').font('Helvetica').fontSize(8).text('Observed sender-to-receiver relationships from this case only. Amber nodes are associated with saved findings.', 44, document.y + 8, { width: pageWidth - 88 })
    const graphAccounts = report.accounts.slice(0, 14)
    const graphAccountIds = new Set(graphAccounts.map((item) => item.id))
    const graphTransactions = report.supportingTransactions
      .filter((item) => graphAccountIds.has(item.sender_account) && graphAccountIds.has(item.receiver_account))
      .slice(0, 28)
    const graphFindingAccounts = new Set(report.findings.flatMap((item) => item.account_ids))
    const graphCenterX = pageWidth / 2
    const graphCenterY = 300
    const graphRadius = 150
    const graphPositions = new Map(graphAccounts.map((account, index) => {
      const angle = 2 * Math.PI * index / Math.max(1, graphAccounts.length) - Math.PI / 2
      return [account.id, { x: graphCenterX + graphRadius * Math.cos(angle), y: graphCenterY + graphRadius * Math.sin(angle) }]
    }))
    for (const transaction of graphTransactions) {
      const from = graphPositions.get(transaction.sender_account)
      const to = graphPositions.get(transaction.receiver_account)
      document.save().strokeColor('#70aaa2').lineWidth(0.7).moveTo(from.x, from.y).lineTo(to.x, to.y).stroke().restore()
    }
    for (const account of graphAccounts) {
      const position = graphPositions.get(account.id)
      const flagged = graphFindingAccounts.has(account.id)
      document.circle(position.x, position.y, 13).fillAndStroke(flagged ? '#c28a30' : '#2b8175', '#ffffff')
      document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7).text(account.id.slice(0, 15), position.x - 34, position.y - 3, { width: 68, align: 'center', lineBreak: false })
    }
    document.fillColor('#536267').font('Helvetica').fontSize(8)
    document.text(`Displayed ${graphAccounts.length} of ${report.accounts.length} observed accounts and ${graphTransactions.length} of ${report.supportingTransactions.length} transactions.`, 44, 500, { width: pageWidth - 88 })
    if (report.accounts.length > graphAccounts.length || graphTransactions.length < report.supportingTransactions.length) {
      document.text('The graph is a compact visualization; the complete transaction list follows in this report and in the spreadsheet/CSV exports.', 44, 514, { width: pageWidth - 88 })
    }
    section('Findings')
    if (!report.findings.length) document.text('No findings are saved for this case.')
    for (const finding of report.findings) {
      ensureSpace(62)
      document.fillColor('#173f3b').font('Helvetica-Bold').fontSize(10).text(`${finding.severity} — ${finding.rule_name}`)
      document.fillColor('#26363b').font('Helvetica').fontSize(9).text(finding.explanation, { width: pageWidth - 88 })
      document.text(`Supporting transaction IDs: ${finding.supporting_transaction_ids.join(', ') || 'None'}`, { width: pageWidth - 88 })
      document.moveDown(0.45)
    }
    section('Recommended review actions')
    if (!report.recommendedNextSteps.length) document.text('No recommendation is available because this case has no saved findings.')
    for (const [index, action] of report.recommendedNextSteps.entries()) {
      ensureSpace(28)
      document.text(`${index + 1}. ${action}`, { width: pageWidth - 88 })
      document.moveDown(0.3)
    }
    section('Transaction summary')
    if (!report.supportingTransactions.length) document.text('No transactions are saved for this case.')
    for (const transaction of report.supportingTransactions) {
      ensureSpace(42)
      document.fillColor('#173f3b').font('Helvetica-Bold').fontSize(8).text(transaction.transaction_id, { width: pageWidth - 88 })
      document.fillColor('#26363b').font('Helvetica').fontSize(8).text(`${transaction.sender_account}  →  ${transaction.receiver_account}  |  ${transaction.amount} ${transaction.currency}  |  ${transaction.timestamp}`, { width: pageWidth - 88 })
      document.moveDown(0.35)
    }
    section('Investigation notes')
    if (!report.notes.length) document.text('No investigation notes are saved for this case.')
    for (const note of report.notes) {
      ensureSpace(36)
      document.fillColor('#627276').fontSize(8).text(note.created_at)
      document.fillColor('#26363b').fontSize(9).text(note.note, { width: pageWidth - 88 })
      document.moveDown(0.3)
    }
    ensureSpace(40)
    document.moveDown(0.5).fillColor('#72552a').font('Helvetica-Bold').fontSize(9).text('Disclaimer')
    document.fillColor('#4b5150').font('Helvetica').fontSize(8).text('Automated findings are deterministic rule-based review signals, not proof of fraud. Verify all signals against source records and case context.')
    document.end()
  })
}

async function reportWorkbook(report) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'MuleShield'
  workbook.created = new Date(report.generatedAt)
  const summary = workbook.addWorksheet('Case Summary')
  summary.addRows([
    ['Field', 'Value'],
    ['Case ID', spreadsheetText(report.investigationId)],
    ['Title', spreadsheetText(report.caseSummary.title)],
    ['Status', spreadsheetText(report.caseSummary.status)],
    ['Description', spreadsheetText(report.caseSummary.description)],
    ['Generated at', report.generatedAt],
    ['Transaction count', report.datasetCoverage.transactionCount],
    ['Account count', report.datasetCoverage.observedAccountCount],
    ['Findings count', report.findings.length],
    ['Disclaimer', 'Automated findings are review signals, not proof of fraud.'],
    ...report.notes.map((note) => ['Investigation note', spreadsheetText(`${note.created_at} — ${note.note}`)]),
  ])
  const transactions = workbook.addWorksheet('Transactions')
  transactions.addRow(['Transaction ID', 'Sender account', 'Receiver account', 'Amount', 'Currency', 'Timestamp', 'Transaction type', 'Description'])
  for (const item of report.supportingTransactions) transactions.addRow([
    spreadsheetText(item.transaction_id), spreadsheetText(item.sender_account), spreadsheetText(item.receiver_account),
    item.amount, spreadsheetText(item.currency), spreadsheetText(item.timestamp), spreadsheetText(item.transaction_type), spreadsheetText(item.description),
  ])
  const findings = workbook.addWorksheet('Findings')
  findings.addRow(['Severity', 'Title', 'Explanation', 'Supporting transaction IDs', 'Accounts', 'Threshold', 'Recommended next step'])
  for (const item of report.findings) findings.addRow([
    spreadsheetText(item.severity), spreadsheetText(item.rule_name), spreadsheetText(item.explanation),
    spreadsheetText(item.supporting_transaction_ids.join(', ')), spreadsheetText(item.account_ids.join(', ')),
    spreadsheetText(item.threshold), spreadsheetText(item.recommended_next_step),
  ])
  if (report.accounts.length) {
    const accounts = workbook.addWorksheet('Accounts')
    accounts.addRow(['Account ID', 'Transactions sent', 'Transactions received'])
    for (const item of report.accounts) accounts.addRow([spreadsheetText(item.id), item.sentCount, item.receivedCount])
  }
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    const header = sheet.getRow(1)
    header.font = { bold: true, color: { argb: 'FFE7F6F4' } }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123A37' } }
    header.alignment = { vertical: 'middle', wrapText: true }
    header.height = 24
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true }
    })
    sheet.columns.forEach((column) => {
      let width = 12
      column.eachCell({ includeEmpty: false }, (cell) => {
        width = Math.max(width, String(cell.value ?? '').length + 2)
      })
      column.width = Math.min(width, 60)
    })
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', environment: 'DEMO DATA', liveSourceConfigured: false }))
app.post('/api/auth/login', authLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email)
  const actual = user ? passwordHash(password, user.password_salt) : passwordHash(password || 'invalid', 'muleshield-invalid-salt')
  if (!user || !user.enabled || !safeEqual(actual, user.password_hash)) {
    audit('LOGIN_FAILED', { actorId: user?.id || null, success: false })
    return res.status(401).json({ error: 'Email or password is incorrect.' })
  }
  if (user.mfa_enabled) {
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
    db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(user.id)
    db.prepare('DELETE FROM mfa_enrollment_challenges WHERE user_id=?').run(user.id)
    clearCookie(res, 'ms_session')
    clearCookie(res, 'ms_mfa_enroll')
    const challenge = crypto.randomBytes(32).toString('base64url')
    const expires = new Date(Date.now() + 5 * 60_000).toISOString()
    db.prepare('INSERT INTO mfa_challenges(token_hash,user_id,expires_at) VALUES (?,?,?)').run(hashToken(challenge), user.id, expires)
    res.cookie('ms_mfa_challenge', challenge, cookieOptions(5 * 60_000))
    audit('MFA_CHALLENGE_ISSUED', { actorId: user.id })
    return res.json({ mfaRequired: true })
  }
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
  db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(user.id)
  db.prepare('DELETE FROM mfa_enrollment_challenges WHERE user_id=?').run(user.id)
  clearCookie(res, 'ms_session')
  clearCookie(res, 'ms_mfa_challenge')
  const challenge = crypto.randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + 10 * 60_000).toISOString()
  db.prepare('INSERT INTO mfa_enrollment_challenges(token_hash,user_id,expires_at) VALUES (?,?,?)').run(hashToken(challenge), user.id, expires)
  res.cookie('ms_mfa_enroll', challenge, cookieOptions(10 * 60_000))
  audit('MFA_ENROLLMENT_REQUIRED', { actorId: user.id })
  res.json({ mfaEnrollmentRequired: true })
})
app.post('/api/auth/mfa/verify', mfaLimiter, (req, res) => {
  const challenge = req.cookies?.ms_mfa_challenge
  const code = String(req.body?.code || '').trim().toUpperCase()
  if (!challenge || !/^(\d{6}|[A-F0-9]{10})$/.test(code)) return res.status(401).json({ error: 'Invalid or expired verification challenge.' })
  const challengeRow = db.prepare(`SELECT mfa_challenges.*, users.* FROM mfa_challenges JOIN users ON users.id=mfa_challenges.user_id WHERE token_hash=? AND expires_at>?`)
    .get(hashToken(challenge), nowIso())
  if (!challengeRow || challengeRow.attempts >= 5 || !challengeRow.enabled || !challengeRow.mfa_enabled) {
    clearCookie(res, 'ms_mfa_challenge')
    return res.status(401).json({ error: 'Invalid or expired verification challenge.' })
  }
  const isRecovery = !/^\d{6}$/.test(code)
  const recoveryHashes = JSON.parse(challengeRow.recovery_hashes)
  const recoveryIndex = isRecovery ? recoveryHashes.findIndex((value) => safeEqual(value, hashToken(code))) : -1
  const secret = decryptSecret(challengeRow.totp_secret)
  const step = isRecovery ? null : createTotp(challengeRow, secret).validate({ token: code, window: 1 })
  const matchedStep = step === null ? null : Math.floor(Date.now() / 30_000) + step
  if ((isRecovery && recoveryIndex < 0) || (!isRecovery && (step === null || (challengeRow.last_totp_step !== null && matchedStep <= challengeRow.last_totp_step)))) {
    db.prepare('UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=?').run(hashToken(challenge))
    audit('MFA_VERIFICATION_FAILED', { actorId: challengeRow.id, success: false })
    return res.status(401).json({ error: 'Verification code is invalid or has already been used.' })
  }
  if (isRecovery) {
    recoveryHashes.splice(recoveryIndex, 1)
    db.prepare('UPDATE users SET recovery_hashes=? WHERE id=?').run(JSON.stringify(recoveryHashes), challengeRow.id)
    audit('MFA_RECOVERY_CODE_USED', { actorId: challengeRow.id })
  } else {
    db.prepare('UPDATE users SET last_totp_step=? WHERE id=?').run(matchedStep, challengeRow.id)
  }
  db.prepare('DELETE FROM mfa_challenges WHERE token_hash=?').run(hashToken(challenge))
  clearCookie(res, 'ms_mfa_challenge')
  createSession(challengeRow.id, res)
  audit('MFA_VERIFICATION_SUCCEEDED', { actorId: challengeRow.id })
  res.json({ user: safeUser(challengeRow) })
})
app.get('/api/auth/me', authenticated, (req, res) => res.json({ user: safeUser(req.user) }))
app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.ms_session
  const mfaChallenge = req.cookies?.ms_mfa_challenge
  const enrollmentChallenge = req.cookies?.ms_mfa_enroll
  const session = token && db.prepare('SELECT user_id FROM sessions WHERE token_hash=?').get(hashToken(token))
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token))
  if (mfaChallenge) db.prepare('DELETE FROM mfa_challenges WHERE token_hash=?').run(hashToken(mfaChallenge))
  if (enrollmentChallenge) db.prepare('DELETE FROM mfa_enrollment_challenges WHERE token_hash=?').run(hashToken(enrollmentChallenge))
  if (session) audit('LOGOUT', { actorId: session.user_id })
  clearCookie(res, 'ms_session')
  clearCookie(res, 'ms_mfa_challenge')
  clearCookie(res, 'ms_mfa_enroll')
  res.status(204).end()
})
app.post('/api/auth/mfa/enroll/start', enrollmentChallenge, (req, res) => {
  const secret = new Secret({ size: 20 })
  const totp = createTotp(req.enrollmentChallenge, secret)
  db.prepare('UPDATE users SET pending_totp_secret=? WHERE id=?').run(encryptSecret(secret.base32), req.enrollmentChallenge.id)
  res.json({ provisioningUri: totp.toString(), manualKey: secret.base32 })
})
app.post('/api/auth/mfa/enroll/confirm', mfaLimiter, enrollmentChallenge, (req, res) => {
  const code = String(req.body?.code || '')
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.enrollmentChallenge.id)
  if (!user.pending_totp_secret || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Start MFA enrollment before confirming.' })
  const secret = decryptSecret(user.pending_totp_secret)
  const step = createTotp(user, Secret.fromBase32(secret)).validate({ token: code, window: 1 })
  if (step === null) {
    db.prepare('UPDATE mfa_enrollment_challenges SET attempts=attempts+1 WHERE token_hash=?').run(req.enrollmentChallenge.token_hash)
    audit('MFA_ENROLLMENT_VERIFICATION_FAILED', { actorId: user.id, success: false })
    return res.status(401).json({ error: 'Code did not verify. Check your authenticator app and try again.' })
  }
  const matchedStep = Math.floor(Date.now() / 30_000) + step
  const recoveryCodes = generateRecoveryCodes()
  const recoveryHashes = recoveryCodes.map((item) => hashToken(item))
  db.prepare('UPDATE users SET mfa_enabled=1,totp_secret=pending_totp_secret,pending_totp_secret=NULL,last_totp_step=?,recovery_hashes=? WHERE id=?')
    .run(matchedStep, JSON.stringify(recoveryHashes), user.id)
  db.prepare('DELETE FROM mfa_enrollment_challenges WHERE token_hash=?').run(req.enrollmentChallenge.token_hash)
  clearCookie(res, 'ms_mfa_enroll')
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
  createSession(user.id, res)
  audit('MFA_ENROLLED', { actorId: user.id })
  res.json({ enabled: true, user: safeUser({ ...user, mfa_enabled: 1 }), recoveryCodes })
})
app.post('/api/auth/mfa/disable', authenticated, mfaLimiter, (req, res) => {
  const password = String(req.body?.password || '')
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
  const valid = safeEqual(passwordHash(password, user.password_salt), user.password_hash)
  if (!valid) return res.status(401).json({ error: 'Reauthentication failed.' })
  db.prepare('UPDATE users SET mfa_enabled=0,totp_secret=NULL,pending_totp_secret=NULL,last_totp_step=NULL,recovery_hashes=\'[]\' WHERE id=?').run(user.id)
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
  clearCookie(res, 'ms_session')
  audit('MFA_DISABLED', { actorId: user.id })
  res.json({ disabled: true })
})
app.post('/api/auth/password/change', authenticated, authLimiter, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '')
  const newPassword = String(req.body?.newPassword || '')
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
  if (!safeEqual(passwordHash(currentPassword, user.password_salt), user.password_hash)) return res.status(401).json({ error: 'Reauthentication failed.' })
  if (newPassword.length < 14 || newPassword.length > 128) return res.status(400).json({ error: 'New password must be between 14 and 128 characters.' })
  const salt = crypto.randomBytes(16).toString('hex')
  db.prepare('UPDATE users SET password_salt=?,password_hash=? WHERE id=?').run(salt, passwordHash(newPassword, salt), user.id)
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
  audit('PASSWORD_CHANGED', { actorId: user.id })
  clearCookie(res, 'ms_session')
  res.json({ changed: true })
})
app.get('/api/admin/users', authenticated, adminOnly, (_req, res) => {
  res.json({ users: db.prepare('SELECT id,email,name,role,enabled,mfa_enabled,created_at FROM users ORDER BY created_at DESC').all() })
})
app.post('/api/admin/users', authenticated, adminOnly, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const name = String(req.body?.name || '').trim()
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const role = req.body?.role
  if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 1 || name.length > 120 || password.length < 14 || password.length > 128 || !['ANALYST', 'ADMINISTRATOR'].includes(role)) {
    return res.status(400).json({ error: 'Valid email, name, password, and role are required. Passwords must be 14–128 characters.' })
  }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'An account with that email already exists.' })
  const id = crypto.randomUUID()
  const createdAt = nowIso()
  const salt = crypto.randomBytes(16).toString('hex')
  db.prepare('INSERT INTO users (id,email,name,password_hash,password_salt,role,enabled,mfa_enabled,recovery_hashes,created_at) VALUES (?,?,?,?,?,?,1,0,\'[]\',?)')
    .run(id, email, name, passwordHash(password, salt), salt, role, createdAt)
  audit('ADMIN_USER_PROVISIONED', { actorId: req.user.id, objectId: id, metadata: { role } })
  res.status(201).json({ user: { id, email, name, role, enabled: 1, mfa_enabled: 0, created_at: createdAt } })
})
app.patch('/api/admin/users/:id', authenticated, adminOnly, (req, res) => {
  const changes = Object.keys(req.body || {})
  if (changes.length !== 1 || !['enabled', 'role'].includes(changes[0])) {
    return res.status(400).json({ error: 'Provide exactly one account change: enabled or role.' })
  }
  const user = db.prepare('SELECT id,role,enabled FROM users WHERE id=?').get(req.params.id)
  if (!user) return res.status(404).json({ error: 'Account not found.' })
  if (changes[0] === 'role') {
    const role = req.body.role
    if (!['ANALYST', 'ADMINISTRATOR'].includes(role)) return res.status(400).json({ error: 'Role must be ANALYST or ADMINISTRATOR.' })
    if (role === user.role) return res.json({ id: user.id, role })
    if (user.id === req.user.id) return res.status(409).json({ error: 'Administrators cannot change their own role.' })
    if (user.enabled && user.role === 'ADMINISTRATOR' && role === 'ANALYST') {
      const activeAdmins = db.prepare('SELECT COUNT(*) AS count FROM users WHERE role=\'ADMINISTRATOR\' AND enabled=1').get().count
      if (activeAdmins <= 1) return res.status(409).json({ error: 'The last enabled administrator cannot be demoted.' })
    }
    db.prepare('UPDATE users SET role=? WHERE id=?').run(role, user.id)
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
    db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(user.id)
    db.prepare('DELETE FROM mfa_enrollment_challenges WHERE user_id=?').run(user.id)
    audit('ADMIN_USER_ROLE_CHANGED', { actorId: req.user.id, objectId: user.id, metadata: { previousRole: user.role, role } })
    return res.json({ id: user.id, role })
  }
  const enabled = req.body.enabled
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Account enabled status must be true or false.' })
  if (!enabled && user.id === req.user.id) return res.status(409).json({ error: 'Administrators cannot disable their own account.' })
  if (Boolean(user.enabled) === enabled) return res.json({ id: user.id, enabled })
  if (!enabled && user.role === 'ADMINISTRATOR') {
    const activeAdmins = db.prepare('SELECT COUNT(*) AS count FROM users WHERE role=\'ADMINISTRATOR\' AND enabled=1').get().count
    if (activeAdmins <= 1) return res.status(409).json({ error: 'The last enabled administrator cannot be disabled.' })
  }
  db.prepare('UPDATE users SET enabled=? WHERE id=?').run(enabled ? 1 : 0, user.id)
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
  db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(user.id)
  db.prepare('DELETE FROM mfa_enrollment_challenges WHERE user_id=?').run(user.id)
  audit(enabled ? 'ADMIN_USER_REACTIVATED' : 'ADMIN_USER_DISABLED', { actorId: req.user.id, objectId: user.id, metadata: { role: user.role } })
  res.json({ id: user.id, enabled })
})
app.get('/api/admin/audit', authenticated, adminOnly, (_req, res) => {
  res.json({ events: db.prepare('SELECT id,event_type,timestamp,actor_id,object_id,success,metadata FROM audit_events ORDER BY timestamp DESC LIMIT 200').all().map((row) => ({ ...row, success: Boolean(row.success), metadata: JSON.parse(row.metadata) })) })
})

app.get('/api/investigations', authenticated, (req, res) => {
  const rows = req.user.role === 'ADMINISTRATOR'
    ? db.prepare('SELECT * FROM investigations ORDER BY updated_at DESC').all()
    : db.prepare('SELECT * FROM investigations WHERE owner_id=? ORDER BY updated_at DESC').all(req.user.id)
  res.json({ investigations: rows.map((row) => ({ ...row, knownIds: JSON.parse(row.known_ids) })) })
})
app.post('/api/investigations', authenticated, (req, res) => {
  const title = String(req.body?.title || '').trim()
  const description = String(req.body?.description || '').trim()
  const amount = req.body?.reportedAmount === '' || req.body?.reportedAmount == null ? null : Number(req.body.reportedAmount)
  const currency = String(req.body?.currency || 'USD').trim().toUpperCase()
  if (title.length < 3 || title.length > 160) return res.status(400).json({ error: 'Case title must be between 3 and 160 characters.' })
  if (description.length > 4000 || (amount !== null && (!Number.isFinite(amount) || amount < 0)) || !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'Case details are invalid.' })
  const id = crypto.randomUUID(); const timestamp = nowIso()
  const knownIds = Array.isArray(req.body?.knownIds) ? req.body.knownIds.map((value) => String(value).trim()).filter(Boolean).slice(0, 100) : []
  db.prepare('INSERT INTO investigations(id,title,description,reported_amount,currency,date_from,date_to,known_ids,status,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, title, description, amount, currency, req.body?.dateFrom || null, req.body?.dateTo || null, JSON.stringify(knownIds), 'OPEN', req.user.id, timestamp, timestamp)
  audit('INVESTIGATION_CREATED', { actorId: req.user.id, objectId: id })
  res.status(201).json({ investigation: db.prepare('SELECT * FROM investigations WHERE id=?').get(id) })
})
app.get('/api/investigations/:id', authenticated, (req, res) => {
  const investigation = caseAccess(req, res, req.params.id)
  if (!investigation) return
  const transactions = db.prepare('SELECT * FROM transactions WHERE investigation_id=? ORDER BY timestamp').all(investigation.id)
  const findings = db.prepare('SELECT * FROM findings WHERE investigation_id=? ORDER BY created_at DESC').all(investigation.id).map((item) => ({ ...item, supporting_transaction_ids: JSON.parse(item.supporting_transaction_ids), account_ids: JSON.parse(item.account_ids), timestamps: JSON.parse(item.timestamps), amounts: JSON.parse(item.amounts) }))
  const notes = db.prepare('SELECT id,actor_id,note,created_at FROM investigation_notes WHERE investigation_id=? ORDER BY created_at DESC').all(investigation.id)
  res.json({ investigation: { ...investigation, knownIds: JSON.parse(investigation.known_ids) }, transactions, findings, notes })
})
app.patch('/api/investigations/:id', authenticated, (req, res) => {
  const investigation = caseAccess(req, res, req.params.id)
  if (!investigation) return
  const allowed = new Set(['OPEN', 'IN_REVIEW', 'CLOSED'])
  const status = String(req.body?.status || '')
  if (!allowed.has(status)) return res.status(400).json({ error: 'Status must be OPEN, IN_REVIEW, or CLOSED.' })
  db.prepare('UPDATE investigations SET status=?,updated_at=? WHERE id=?').run(status, nowIso(), investigation.id)
  audit('INVESTIGATION_STATUS_CHANGED', { actorId: req.user.id, objectId: investigation.id, metadata: { status } })
  res.json({ status })
})
app.post('/api/investigations/:id/csv/preview', authenticated, (req, res) => {
  const investigation = caseAccess(req, res, req.params.id)
  if (!investigation) return
  const csv = String(req.body?.csv || '')
  if (!csv || Buffer.byteLength(csv, 'utf8') > 4 * 1024 * 1024) return res.status(400).json({ error: 'CSV is empty or exceeds the 4 MB limit.' })
  try {
    const result = validateCsvText(csv, req.body?.mapping || {})
    if (result.totalRows > 25_000) return res.status(400).json({ error: 'CSV exceeds the 25,000 row limit.' })
    const existing = new Set(db.prepare('SELECT transaction_id FROM transactions WHERE investigation_id=?').all(investigation.id).map((row) => row.transaction_id))
    result.duplicateRows.push(...result.validRows.filter((item) => existing.has(item.transaction_id)).map((item) => ({ rowNumber: item.rowNumber, transactionId: item.transaction_id, reason: 'Transaction already imported into this case' })))
    result.validRows = result.validRows.filter((item) => !existing.has(item.transaction_id))
    res.json({ ...result, sampleRows: result.validRows.slice(0, 10), invalidRows: result.invalidRows.slice(0, 500), duplicateRows: result.duplicateRows.slice(0, 500) })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'CSV could not be parsed.' }) }
})
app.post('/api/investigations/:id/csv/import', authenticated, (req, res) => {
  const investigation = caseAccess(req, res, req.params.id)
  if (!investigation) return
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicitly confirm the reviewed CSV import.' })
  const csv = String(req.body?.csv || '')
  if (!csv || Buffer.byteLength(csv, 'utf8') > 4 * 1024 * 1024) return res.status(400).json({ error: 'CSV is empty or exceeds the 4 MB limit.' })
  try {
    const result = validateCsvText(csv, req.body?.mapping || {})
    if (result.totalRows > 25_000) return res.status(400).json({ error: 'CSV exceeds the 25,000 row limit.' })
    const existing = new Set(db.prepare('SELECT transaction_id FROM transactions WHERE investigation_id=?').all(investigation.id).map((row) => row.transaction_id))
    const rows = result.validRows.filter((row) => !existing.has(row.transaction_id))
    const insert = db.prepare('INSERT OR IGNORE INTO transactions(id,investigation_id,transaction_id,sender_account,receiver_account,amount,currency,timestamp,transaction_type,description) VALUES (?,?,?,?,?,?,?,?,?,?)')
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) insert.run(crypto.randomUUID(), investigation.id, row.transaction_id, row.sender_account, row.receiver_account, row.amount, row.currency, row.timestamp, row.transaction_type, row.description)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const total = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE investigation_id=?').get(investigation.id).count
    db.prepare('UPDATE investigations SET updated_at=? WHERE id=?').run(nowIso(), investigation.id)
    audit('TRANSACTION_IMPORT', { actorId: req.user.id, objectId: investigation.id, metadata: { imported: rows.length, invalid: result.invalidRows.length, duplicates: result.duplicateRows.length } })
    res.status(201).json({ imported: rows.length, invalidRows: result.invalidRows, duplicateRows: result.duplicateRows, totalTransactions: total })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'CSV import failed.' }) }
})
app.post('/api/investigations/:id/analyze', authenticated, (req, res) => {
  const investigation = caseAccess(req, res, req.params.id)
  if (!investigation) return
  const transactions = db.prepare('SELECT * FROM transactions WHERE investigation_id=? ORDER BY timestamp').all(investigation.id)
  const result = findingsFor(investigation.id, transactions)
  audit('ANALYSIS_EXECUTED', { actorId: req.user.id, objectId: investigation.id, metadata: { transactionCount: transactions.length, findingCount: result.findings.length, createdCount: result.createdCount, updatedCount: result.updatedCount, engine: 'deterministic-rules-v1' } })
  res.json({ engine: 'deterministic-rules-v1', transactionCount: transactions.length, findings: result.findings, createdCount: result.createdCount, updatedCount: result.updatedCount })
})
app.get('/api/investigations/:id/network', authenticated, (req, res) => {
  const investigation = caseAccess(req, res, req.params.id)
  if (!investigation) return
  const transactions = db.prepare('SELECT transaction_id,sender_account,receiver_account,amount,currency,timestamp FROM transactions WHERE investigation_id=? ORDER BY timestamp').all(investigation.id)
  const accounts = [...new Set(transactions.flatMap((item) => [item.sender_account, item.receiver_account]))].map((id) => ({ id }))
  res.json({ source: 'IMPORTED INVESTIGATION RECORDS', accounts, transactions })
})
app.post('/api/investigations/:id/notes', authenticated, (req, res) => {
  const investigation = caseAccess(req, res, req.params.id)
  if (!investigation) return
  const note = String(req.body?.note || '').trim()
  if (!note || note.length > 4000) return res.status(400).json({ error: 'Note must be between 1 and 4,000 characters.' })
  const id = crypto.randomUUID(); const timestamp = nowIso()
  db.prepare('INSERT INTO investigation_notes(id,investigation_id,actor_id,note,created_at) VALUES (?,?,?,?,?)').run(id, investigation.id, req.user.id, note, timestamp)
  audit('INVESTIGATION_NOTE_ADDED', { actorId: req.user.id, objectId: investigation.id })
  res.status(201).json({ note: { id, actor_id: req.user.id, note, created_at: timestamp } })
})
app.get('/api/investigations/:id/report', authenticated, (req, res) => {
  const investigation = caseAccess(req, res, req.params.id)
  if (!investigation) return
  const report = caseReportFor(investigation)
  audit('REPORT_GENERATED', { actorId: req.user.id, objectId: investigation.id })
  res.json({ report })
})
app.get('/api/investigations/:id/report/:format', authenticated, async (req, res) => {
  const investigation = caseAccess(req, res, req.params.id)
  if (!investigation) return
  const report = caseReportFor(investigation)
  const safeId = investigation.id.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (req.params.format === 'pdf') {
    const pdf = await reportPdf(report)
    audit('REPORT_GENERATED', { actorId: req.user.id, objectId: investigation.id, metadata: { format: 'pdf' } })
    res.type('application/pdf').set('Content-Disposition', `attachment; filename="MuleShield_${safeId}_Report.pdf"`).send(pdf)
    return
  }
  if (req.params.format === 'xlsx') {
    const workbook = await reportWorkbook(report)
    audit('REPORT_GENERATED', { actorId: req.user.id, objectId: investigation.id, metadata: { format: 'xlsx' } })
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', `attachment; filename="MuleShield_${safeId}_Report.xlsx"`).send(workbook)
    return
  }
  if (req.params.format === 'csv') {
    const type = String(req.query.type || 'transactions')
    if (!['transactions', 'findings'].includes(type)) return res.status(400).json({ error: 'CSV type must be transactions or findings.' })
    const csv = type === 'findings'
      ? reportCsv(
        ['Severity', 'Title', 'Explanation', 'Supporting transaction IDs', 'Accounts', 'Threshold', 'Recommended next step'],
        report.findings.map((item) => [item.severity, item.rule_name, item.explanation, item.supporting_transaction_ids.join(', '), item.account_ids.join(', '), item.threshold, item.recommended_next_step]),
      )
      : reportCsv(
        ['Transaction ID', 'Sender account', 'Receiver account', 'Amount', 'Currency', 'Timestamp', 'Transaction type', 'Description'],
        report.supportingTransactions.map((item) => [item.transaction_id, item.sender_account, item.receiver_account, item.amount, item.currency, item.timestamp, item.transaction_type, item.description]),
      )
    audit('REPORT_GENERATED', { actorId: req.user.id, objectId: investigation.id, metadata: { format: 'csv', type } })
    res.type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="MuleShield_${safeId}_${type === 'findings' ? 'Findings' : 'Transactions'}.csv"`)
      .send(csv)
    return
  }
  res.status(404).json({ error: 'Report format not found.' })
})
app.get('/api/alerts', authenticated, (req, res) => {
  const findings = req.user.role === 'ADMINISTRATOR'
    ? db.prepare(`SELECT f.id,f.investigation_id,i.title AS investigation_title,i.status AS investigation_status,
        f.rule_name,f.severity,f.explanation,f.supporting_transaction_ids,f.account_ids,f.timestamps,
        f.amounts,f.threshold,f.recommended_next_step,f.created_at
      FROM findings f JOIN investigations i ON i.id=f.investigation_id ORDER BY f.created_at DESC LIMIT 500`).all()
    : db.prepare(`SELECT f.id,f.investigation_id,i.title AS investigation_title,i.status AS investigation_status,
        f.rule_name,f.severity,f.explanation,f.supporting_transaction_ids,f.account_ids,f.timestamps,
        f.amounts,f.threshold,f.recommended_next_step,f.created_at
      FROM findings f JOIN investigations i ON i.id=f.investigation_id
      WHERE i.owner_id=? ORDER BY f.created_at DESC LIMIT 500`).all(req.user.id)
  res.json({
    source: 'DETERMINISTIC REVIEW SIGNALS FROM IMPORTED CASE DATA',
    findings: findings.map((item) => ({
      ...item,
      supporting_transaction_ids: JSON.parse(item.supporting_transaction_ids),
      account_ids: JSON.parse(item.account_ids),
      timestamps: JSON.parse(item.timestamps),
      amounts: JSON.parse(item.amounts),
    })),
  })
})
app.get('/api/monitoring/status', authenticated, (_req, res) => {
  const state = db.prepare('SELECT status,events_processed,started_at,updated_at FROM monitoring_state WHERE singleton=1').get()
  res.json({ environment: 'DEMO MODE', source: 'SYNTHETIC DEMO — no authorized live transaction source is configured', kafka: { configured: false, connected: false }, status: state.status, eventsReceived: 0, eventsProcessed: state.events_processed, processingErrors: 0, suspiciousPatterns: 0, alertsGenerated: 0, lastEventAt: null, recentEvents: [], recentAlerts: [], updatedAt: state.updated_at })
})
app.post('/api/monitoring/:action', authenticated, (req, res) => {
  const actions = { start: ['STOPPED'], pause: ['RUNNING'], resume: ['PAUSED'], stop: ['RUNNING', 'PAUSED'] }
  const action = req.params.action
  const current = db.prepare('SELECT status FROM monitoring_state WHERE singleton=1').get().status
  if (!actions[action] || !actions[action].includes(current)) return res.status(409).json({ error: 'That monitoring transition is not available from the current state.' })
  const nextStatus = action === 'pause' ? 'PAUSED' : action === 'stop' ? 'STOPPED' : 'RUNNING'
  const timestamp = nowIso()
  db.prepare('UPDATE monitoring_state SET status=?,started_at=CASE WHEN ?=\'RUNNING\' AND started_at IS NULL THEN ? WHEN ?=\'STOPPED\' THEN NULL ELSE started_at END,updated_at=? WHERE singleton=1')
    .run(nextStatus, nextStatus, timestamp, nextStatus, timestamp)
  audit('DEMO_MONITORING_CONTROL', { actorId: req.user.id, metadata: { action, nextStatus, liveSourceConfigured: false } })
  res.json({ status: nextStatus, environment: 'DEMO MODE', liveSourceConfigured: false, notice: 'No external transaction event stream is connected. These controls update demo-console state only.' })
})

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }))
if (isProduction) {
  const distPath = path.resolve(__dirname, '..', 'dist')
  app.use(express.static(distPath))
  app.use((_req, res) => res.sendFile(path.join(distPath, 'index.html')))
}
app.listen(port, host, () => console.log(`MuleShield API listening on http://${host}:${port}`))
