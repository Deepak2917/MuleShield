import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import ExcelJS from 'exceljs'
import { Secret, TOTP } from 'otpauth'

let child
let baseUrl
let tempDir
let db
const origin = 'http://localhost:5173'

function pdfText(pdf) {
  const contents = pdf.toString('latin1').match(/stream\r?\n([\s\S]*?)\r?\nendstream/g) || []
  return contents.map((stream) => [...stream.matchAll(/<([0-9a-f]{2,})>/gi)]
    .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
    .join(' ')).join('\n')
}

function makeEmail(prefix) {
  return `${prefix}-${crypto.randomUUID()}@test.invalid`
}

function provision(db, { email, name, role, password }) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')
  db.prepare('INSERT INTO users (id,email,name,password_hash,password_salt,role,enabled,mfa_enabled,recovery_hashes,created_at) VALUES (?,?,?,?,?,?,1,0,\'[]\',?)')
    .run(crypto.randomUUID(), email, name, hash, salt, role, new Date().toISOString())
}
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function api(pathname, { method = 'GET', body, cookies = '' } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json', origin }),
      ...(cookies ? { cookie: cookies } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
function mergeCookies(jar, response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';')
    const [key, ...rest] = pair.split('=')
    const value = rest.join('=')
    if (/Max-Age=0/i.test(header)) delete jar[key]
    else jar[key] = value
  }
  return Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; ')
}
async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Test server exited during startup.')
    try { await fetch(`${baseUrl}/api/health`); return } catch { await delay(100) }
  }
  throw new Error('Test API did not start.')
}

async function loginAndEnroll(email, password = 'a-test-password-that-is-long') {
  const jar = {}
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password } })
  assert.equal(login.status, 200)
  assert.deepEqual(await login.clone().json(), { mfaEnrollmentRequired: true })
  let cookies = mergeCookies(jar, login)
  const enrollment = await api('/api/auth/mfa/enroll/start', { method: 'POST', body: {}, cookies })
  assert.equal(enrollment.status, 200)
  const { provisioningUri } = await enrollment.json()
  const secret = Secret.fromBase32(new URLSearchParams(new URL(provisioningUri).search).get('secret'))
  const totp = new TOTP({ issuer: 'MuleShield', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret })
  const confirm = await api('/api/auth/mfa/enroll/confirm', { method: 'POST', body: { code: totp.generate() }, cookies })
  assert.equal(confirm.status, 200)
  const confirmation = await confirm.json()
  cookies = mergeCookies(jar, confirm)
  return { cookies, recoveryCodes: confirmation.recoveryCodes, totp, userId: confirmation.user.id }
}

async function runServerWithKey(key) {
  const env = { ...process.env, PORT: '0' }
  if (key === undefined) delete env.MULESHIELD_ENCRYPTION_KEY
  else env.MULESHIELD_ENCRYPTION_KEY = key
  const childProcess = spawn(globalThis.process.execPath, ['server/index.mjs'], { cwd: globalThis.process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  childProcess.stderr.setEncoding('utf8')
  childProcess.stderr.on('data', (chunk) => { stderr += chunk })
  const exitCode = await new Promise((resolve) => childProcess.once('close', resolve))
  return { exitCode, stderr }
}

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'muleshield-auth-'))
  const dbPath = path.join(tempDir, 'test.sqlite')
  db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('ANALYST', 'ADMINISTRATOR')),
    enabled INTEGER NOT NULL DEFAULT 1, mfa_enabled INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT, pending_totp_secret TEXT, last_totp_step INTEGER,
    recovery_hashes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE TABLE investigations (id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',reported_amount REAL,currency TEXT NOT NULL DEFAULT 'USD',date_from TEXT,date_to TEXT,known_ids TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'OPEN',owner_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE transactions (id TEXT PRIMARY KEY,investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,transaction_id TEXT NOT NULL,sender_account TEXT NOT NULL,receiver_account TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'USD',timestamp TEXT NOT NULL,transaction_type TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',UNIQUE(investigation_id,transaction_id));
  CREATE TABLE findings (id TEXT PRIMARY KEY,investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,rule_name TEXT NOT NULL,severity TEXT NOT NULL,explanation TEXT NOT NULL,supporting_transaction_ids TEXT NOT NULL,account_ids TEXT NOT NULL,timestamps TEXT NOT NULL,amounts TEXT NOT NULL,threshold TEXT NOT NULL,recommended_next_step TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE investigation_notes (id TEXT PRIMARY KEY,investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,actor_id TEXT NOT NULL REFERENCES users(id),note TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE monitoring_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),status TEXT NOT NULL DEFAULT 'STOPPED',events_processed INTEGER NOT NULL DEFAULT 0,started_at TEXT,updated_at TEXT NOT NULL);
  INSERT INTO monitoring_state(singleton,status,updated_at) VALUES (1,'STOPPED',CURRENT_TIMESTAMP);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
  CREATE TABLE mfa_challenges (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE mfa_enrollment_challenges (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE audit_events (id TEXT PRIMARY KEY,event_type TEXT NOT NULL,timestamp TEXT NOT NULL,actor_id TEXT,object_id TEXT,success INTEGER NOT NULL,metadata TEXT NOT NULL DEFAULT '{}');`)
  provision(db, { email: 'analyst@test.invalid', name: 'Test Analyst', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  provision(db, { email: 'other-analyst@test.invalid', name: 'Other Analyst', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  provision(db, { email: 'admin@test.invalid', name: 'Test Admin', role: 'ADMINISTRATOR', password: 'a-test-password-that-is-long' })
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), MULESHIELD_DB_PATH: dbPath, MULESHIELD_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') },
    stdio: 'ignore',
  })
  await waitForServer()
})
after(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise((resolve) => child.once('close', resolve))
  }
  if (db) db.close()
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

test('unauthenticated requests are denied and health labels demo mode honestly', async () => {
  const health = await (await api('/api/health')).json()
  assert.deepEqual(health, { status: 'ok', environment: 'DEMO DATA', liveSourceConfigured: false })
  assert.equal((await api('/api/auth/me')).status, 401)
  assert.equal((await api('/api/alerts')).status, 401)
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: 'analyst@test.invalid', password: 'wrong-password' } })).status, 401)
})

test('server rejects missing and malformed encryption keys with a clear startup error', async () => {
  for (const key of [undefined, 'a'.repeat(64) + 'not-hex']) {
    const result = await runServerWithKey(key)
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /MULESHIELD_ENCRYPTION_KEY must be a 32-byte hex value/)
  }
})

test('user provisioning refuses non-interactive input without creating an account', async () => {
  const provisionDir = await mkdtemp(path.join(os.tmpdir(), 'muleshield-provision-'))
  const databasePath = path.join(provisionDir, 'provision.sqlite')
  try {
    const childProcess = spawn(process.execPath, ['scripts/provision-user.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MULESHIELD_DB_PATH: databasePath },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    childProcess.stderr.setEncoding('utf8')
    childProcess.stderr.on('data', (chunk) => { stderr += chunk })
    childProcess.stdin.end('cli-test@test.invalid\nCLI Test\nADMINISTRATOR\n')
    const exitCode = await new Promise((resolve) => childProcess.once('close', resolve))
    assert.equal(exitCode, 1)
    assert.match(stderr, /Provisioning must run from an interactive terminal/)
    const provisionDb = new DatabaseSync(databasePath)
    assert.equal(provisionDb.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
    provisionDb.close()
  } finally {
    await rm(provisionDir, { recursive: true, force: true })
  }
})

test('expired sessions are rejected by the backend', async () => {
  const email = makeEmail('expired-session')
  provision(db, { email, name: 'Expired Session', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  const { cookies, userId } = await loginAndEnroll(email)
  db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(new Date(Date.now() - 1000).toISOString(), userId)
  assert.equal((await api('/api/auth/me', { cookies })).status, 401)
})

test('disabled accounts cannot authenticate', async () => {
  const email = makeEmail('disabled-user')
  provision(db, { email, name: 'Disabled User', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  db.prepare('UPDATE users SET enabled=0 WHERE email=?').run(email)
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email, password: 'a-test-password-that-is-long' } })).status, 401)
})

test('expired enrollment and MFA challenges cannot be used', async () => {
  const enrollmentEmail = makeEmail('expired-enrollment')
  provision(db, { email: enrollmentEmail, name: 'Expired Enrollment', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  const enrollmentLogin = await api('/api/auth/login', { method: 'POST', body: { email: enrollmentEmail, password: 'a-test-password-that-is-long' } })
  const enrollmentCookies = mergeCookies({}, enrollmentLogin)
  assert.deepEqual(await enrollmentLogin.json(), { mfaEnrollmentRequired: true })
  db.prepare('UPDATE mfa_enrollment_challenges SET expires_at=? WHERE user_id=(SELECT id FROM users WHERE email=?)').run(new Date(Date.now() - 1000).toISOString(), enrollmentEmail)
  assert.equal((await api('/api/auth/mfa/enroll/start', { method: 'POST', body: {}, cookies: enrollmentCookies })).status, 401)

  const mfaEmail = makeEmail('expired-mfa')
  provision(db, { email: mfaEmail, name: 'Expired MFA', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  const { cookies: enrolledCookies, userId } = await loginAndEnroll(mfaEmail)
  await api('/api/auth/logout', { method: 'POST', body: {}, cookies: enrolledCookies })
  const challengeLogin = await api('/api/auth/login', { method: 'POST', body: { email: mfaEmail, password: 'a-test-password-that-is-long' } })
  const challengeCookies = mergeCookies({}, challengeLogin)
  assert.deepEqual(await challengeLogin.json(), { mfaRequired: true })
  db.prepare('UPDATE mfa_challenges SET expires_at=? WHERE user_id=?').run(new Date(Date.now() - 1000).toISOString(), userId)
  assert.equal((await api('/api/auth/mfa/verify', { method: 'POST', body: { code: '000000' }, cookies: challengeCookies })).status, 401)
})

test('analyst login returns a server session and cannot read administrator APIs', async () => {
  const analystEmail = makeEmail('analyst-login')
  provision(db, { email: analystEmail, name: 'Analyst Login', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  const { cookies: cookie } = await loginAndEnroll(analystEmail)
  assert.equal((await api('/api/auth/me', { cookies: cookie })).status, 200)
  assert.equal((await api('/api/admin/audit', { cookies: cookie })).status, 403)
  assert.equal((await api('/api/auth/me', { cookies: cookie })).status, 200)
  assert.equal((await api('/api/auth/logout', { method: 'POST', body: {}, cookies: cookie })).status, 204)
  assert.equal((await api('/api/auth/me', { cookies: cookie })).status, 401)
})

test('TOTP enrollment, challenge restriction, replay rejection, and one-time recovery work', async () => {
  const analystEmail = makeEmail('totp-analyst')
  provision(db, { email: analystEmail, name: 'TOTP Analyst', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  const jar = {}
  const login = await api('/api/auth/login', { method: 'POST', body: { email: analystEmail, password: 'a-test-password-that-is-long' } })
  let cookie = mergeCookies(jar, login)
  assert.equal(login.status, 200)
  assert.deepEqual(await login.clone().json(), { mfaEnrollmentRequired: true })
  assert.equal((await api('/api/auth/me', { cookies: cookie })).status, 401)
  assert.equal((await api('/api/investigations', { cookies: cookie })).status, 401)
  const enrollment = await api('/api/auth/mfa/enroll/start', { method: 'POST', body: {}, cookies: cookie })
  assert.equal(enrollment.status, 200)
  const { provisioningUri } = await enrollment.json()
  const url = new URL(provisioningUri)
  const secret = Secret.fromBase32(new URLSearchParams(url.search).get('secret'))
  const totp = new TOTP({ issuer: 'MuleShield', label: analystEmail, algorithm: 'SHA1', digits: 6, period: 30, secret })
  const enrollmentCode = totp.generate()
  const invalidEnrollment = await api('/api/auth/mfa/enroll/confirm', { method: 'POST', body: { code: enrollmentCode === '000000' ? '000001' : '000000' }, cookies: cookie })
  assert.equal(invalidEnrollment.status, 401)
  const confirmation = await api('/api/auth/mfa/enroll/confirm', { method: 'POST', body: { code: enrollmentCode }, cookies: cookie })
  assert.equal(confirmation.status, 200)
  const { recoveryCodes } = await confirmation.json()
  assert.equal(recoveryCodes.length, 10)
  cookie = mergeCookies(jar, confirmation)
  assert.equal((await api('/api/auth/me', { cookies: cookie })).status, 200)

  await api('/api/auth/logout', { method: 'POST', body: {}, cookies: cookie }).then((response) => { cookie = mergeCookies(jar, response) })
  const secondLogin = await api('/api/auth/login', { method: 'POST', body: { email: analystEmail, password: 'a-test-password-that-is-long' } })
  cookie = mergeCookies(jar, secondLogin)
  assert.deepEqual(await secondLogin.json(), { mfaRequired: true })
  assert.equal((await api('/api/auth/me', { cookies: cookie })).status, 401)
  const currentCode = totp.generate({ timestamp: Date.now() + 30_000 })
  const verified = await api('/api/auth/mfa/verify', { method: 'POST', body: { code: currentCode }, cookies: cookie })
  assert.equal(verified.status, 200)
  cookie = mergeCookies(jar, verified)
  await api('/api/auth/logout', { method: 'POST', body: {}, cookies: cookie }).then((response) => { cookie = mergeCookies(jar, response) })
  const replayLogin = await api('/api/auth/login', { method: 'POST', body: { email: analystEmail, password: 'a-test-password-that-is-long' } })
  cookie = mergeCookies(jar, replayLogin)
  const replay = await api('/api/auth/mfa/verify', { method: 'POST', body: { code: currentCode }, cookies: cookie })
  assert.equal(replay.status, 401)

  await api('/api/auth/logout', { method: 'POST', body: {}, cookies: cookie })
  const recoveryLogin = await api('/api/auth/login', { method: 'POST', body: { email: analystEmail, password: 'a-test-password-that-is-long' } })
  cookie = mergeCookies(jar, recoveryLogin)
  const recovery = await api('/api/auth/mfa/verify', { method: 'POST', body: { code: recoveryCodes[0] }, cookies: cookie })
  assert.equal(recovery.status, 200)
  cookie = mergeCookies(jar, recovery)
  await api('/api/auth/logout', { method: 'POST', body: {}, cookies: cookie })
  const reusedLogin = await api('/api/auth/login', { method: 'POST', body: { email: analystEmail, password: 'a-test-password-that-is-long' } })
  cookie = mergeCookies(jar, reusedLogin)
  const reused = await api('/api/auth/mfa/verify', { method: 'POST', body: { code: recoveryCodes[0] }, cookies: cookie })
  assert.equal(reused.status, 401)
})

test('administrator can read audit records', async () => {
  const adminEmail = makeEmail('audit-admin')
  provision(db, { email: adminEmail, name: 'Audit Admin', role: 'ADMINISTRATOR', password: 'a-test-password-that-is-long' })
  const { cookies: cookie } = await loginAndEnroll(adminEmail)
  assert.equal((await api('/api/admin/audit', { cookies: cookie })).status, 200)
  assert.equal((await api('/api/admin/users', { cookies: cookie })).status, 200)
})

test('administrator can provision and manage accounts; analyst access is denied', async () => {
  const adminEmail = makeEmail('account-admin')
  const analystEmail = makeEmail('account-analyst')
  const adminPassword = 'a-test-password-that-is-long'
  provision(db, { email: adminEmail, name: 'Account Admin', role: 'ADMINISTRATOR', password: adminPassword })
  provision(db, { email: analystEmail, name: 'Account Analyst', role: 'ANALYST', password: adminPassword })
  const { cookies: adminCookies, userId: adminId } = await loginAndEnroll(adminEmail, adminPassword)
  const { cookies: analystCookies } = await loginAndEnroll(analystEmail, adminPassword)

  const account = { email: makeEmail('provisioned-user'), name: 'Provisioned User', password: 'a-new-account-password', role: 'ANALYST' }
  assert.equal((await api('/api/admin/users', { method: 'POST', cookies: analystCookies, body: account })).status, 403)
  const analystId = db.prepare('SELECT id FROM users WHERE email=?').get(analystEmail).id
  assert.equal((await api(`/api/admin/users/${analystId}`, { method: 'PATCH', cookies: analystCookies, body: { enabled: false } })).status, 403)

  const created = await api('/api/admin/users', { method: 'POST', cookies: adminCookies, body: account })
  assert.equal(created.status, 201)
  const { user } = await created.json()
  assert.deepEqual({ email: user.email, name: user.name, role: user.role, enabled: user.enabled, mfa_enabled: user.mfa_enabled }, {
    email: account.email,
    name: account.name,
    role: 'ANALYST',
    enabled: 1,
    mfa_enabled: 0,
  })
  const stored = db.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').get(user.id)
  assert.ok(stored.password_hash)
  assert.notEqual(stored.password_hash, account.password)
  assert.ok(stored.password_salt)

  for (const invalid of [
    { ...account, email: 'not-an-email' },
    { ...account, name: ' ' },
    { ...account, password: 'too-short' },
    { ...account, role: 'OWNER' },
  ]) {
    assert.equal((await api('/api/admin/users', { method: 'POST', cookies: adminCookies, body: invalid })).status, 400)
  }
  assert.equal((await api('/api/admin/users', { method: 'POST', cookies: adminCookies, body: account })).status, 409)

  const { cookies: userCookies, totp } = await loginAndEnroll(account.email, account.password)
  const disabled = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', cookies: adminCookies, body: { enabled: false } })
  assert.equal(disabled.status, 200)
  assert.equal((await api('/api/auth/me', { cookies: userCookies })).status, 401)
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: account.email, password: account.password } })).status, 401)
  assert.equal((await api(`/api/admin/users/${user.id}`, { method: 'PATCH', cookies: adminCookies, body: { enabled: 'false' } })).status, 400)
  assert.equal((await api('/api/admin/users/missing', { method: 'PATCH', cookies: adminCookies, body: { enabled: true } })).status, 404)
  assert.equal((await api(`/api/admin/users/${adminId}`, { method: 'PATCH', cookies: adminCookies, body: { enabled: false } })).status, 409)

  const reactivated = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', cookies: adminCookies, body: { enabled: true } })
  assert.equal(reactivated.status, 200)
  assert.equal((await api('/api/auth/me', { cookies: userCookies })).status, 401)
  const secondLogin = await api('/api/auth/login', { method: 'POST', body: { email: account.email, password: account.password } })
  assert.equal(secondLogin.status, 200)
  assert.deepEqual(await secondLogin.json(), { mfaRequired: true })
  const verified = await api('/api/auth/mfa/verify', {
    method: 'POST',
    cookies: mergeCookies({}, secondLogin),
    body: { code: totp.generate({ timestamp: Date.now() + 30_000 }) },
  })
  assert.equal(verified.status, 200)

  const audit = await (await api('/api/admin/audit', { cookies: adminCookies })).json()
  const accountEvents = audit.events.filter((event) => event.object_id === user.id)
  assert.deepEqual(accountEvents.map((event) => event.event_type).sort(), [
    'ADMIN_USER_DISABLED',
    'ADMIN_USER_PROVISIONED',
    'ADMIN_USER_REACTIVATED',
  ])
  assert.ok(accountEvents.every((event) => event.actor_id === adminId))
})

test('administrator can change account roles and role changes revoke access', async () => {
  const adminEmail = makeEmail('role-admin')
  const analystEmail = makeEmail('role-analyst')
  const password = 'a-test-password-that-is-long'
  provision(db, { email: adminEmail, name: 'Role Admin', role: 'ADMINISTRATOR', password })
  provision(db, { email: analystEmail, name: 'Role Analyst', role: 'ANALYST', password })
  const { cookies: adminCookies, userId: adminId } = await loginAndEnroll(adminEmail, password)
  const { cookies: analystCookies, userId: analystId, totp, recoveryCodes } = await loginAndEnroll(analystEmail, password)

  assert.equal((await api(`/api/admin/users/${analystId}`, { method: 'PATCH', cookies: analystCookies, body: { role: 'ADMINISTRATOR' } })).status, 403)
  assert.equal((await api(`/api/admin/users/${analystId}`, { method: 'PATCH', cookies: adminCookies, body: { role: 'OWNER' } })).status, 400)
  assert.equal((await api(`/api/admin/users/${analystId}`, { method: 'PATCH', cookies: adminCookies, body: { role: 'ADMINISTRATOR', enabled: false } })).status, 400)
  assert.equal((await api('/api/admin/users/missing', { method: 'PATCH', cookies: adminCookies, body: { role: 'ADMINISTRATOR' } })).status, 404)
  assert.equal((await api(`/api/admin/users/${adminId}`, { method: 'PATCH', cookies: adminCookies, body: { role: 'ANALYST' } })).status, 409)

  const promoted = await api(`/api/admin/users/${analystId}`, { method: 'PATCH', cookies: adminCookies, body: { role: 'ADMINISTRATOR' } })
  assert.equal(promoted.status, 200)
  assert.deepEqual(await promoted.json(), { id: analystId, role: 'ADMINISTRATOR' })
  assert.equal((await api('/api/admin/users', { cookies: analystCookies })).status, 401)

  const login = await api('/api/auth/login', { method: 'POST', body: { email: analystEmail, password } })
  assert.deepEqual(await login.clone().json(), { mfaRequired: true })
  const elevatedJar = {}
  const elevatedChallenge = mergeCookies(elevatedJar, login)
  const verified = await api('/api/auth/mfa/verify', {
    method: 'POST',
    cookies: elevatedChallenge,
    body: { code: totp.generate({ timestamp: Date.now() + 30_000 }) },
  })
  assert.equal(verified.status, 200)
  const promotedCookies = mergeCookies(elevatedJar, verified)
  assert.equal((await api('/api/admin/users', { cookies: promotedCookies })).status, 200)

  const demoted = await api(`/api/admin/users/${analystId}`, { method: 'PATCH', cookies: adminCookies, body: { role: 'ANALYST' } })
  assert.equal(demoted.status, 200)
  assert.equal((await api('/api/admin/users', { cookies: promotedCookies })).status, 401)

  const relogin = await api('/api/auth/login', { method: 'POST', body: { email: analystEmail, password } })
  const analystJar = {}
  const analystChallenge = mergeCookies(analystJar, relogin)
  const reverified = await api('/api/auth/mfa/verify', {
    method: 'POST',
    cookies: analystChallenge,
    body: { code: recoveryCodes[0] },
  })
  assert.equal(reverified.status, 200)
  assert.equal((await api('/api/admin/users', { cookies: mergeCookies(analystJar, reverified) })).status, 403)

  const audit = await (await api('/api/admin/audit', { cookies: adminCookies })).json()
  const roleEvents = audit.events.filter((event) => event.object_id === analystId && event.event_type === 'ADMIN_USER_ROLE_CHANGED')
  assert.deepEqual(roleEvents.map((event) => event.metadata.role), ['ANALYST', 'ADMINISTRATOR'])
  assert.ok(roleEvents.every((event) => event.actor_id === adminId))
})

test('monitoring reports configured demo-source truth and enforces state transitions', async () => {
  const email = makeEmail('monitoring-analyst')
  provision(db, { email, name: 'Monitoring Analyst', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  const { cookies } = await loginAndEnroll(email)
  const status = await (await api('/api/monitoring/status', { cookies })).json()
  assert.equal(status.environment, 'DEMO MODE')
  assert.deepEqual(status.kafka, { configured: false, connected: false })
  assert.match(status.source, /no authorized live transaction source is configured/i)
  for (const [action, expected] of [['start', 'RUNNING'], ['pause', 'PAUSED'], ['resume', 'RUNNING'], ['stop', 'STOPPED']]) {
    const response = await api(`/api/monitoring/${action}`, { method: 'POST', cookies, body: {} })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.status, expected)
    assert.equal(result.liveSourceConfigured, false)
  }
})

test('analyst can import validated transactions and cannot access another analyst case', async () => {
  const analystEmail = makeEmail('import-analyst')
  const otherAnalystEmail = makeEmail('other-analyst')
  provision(db, { email: analystEmail, name: 'Import Analyst', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  provision(db, { email: otherAnalystEmail, name: 'Other Analyst', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  let { cookies } = await loginAndEnroll(analystEmail)
  const created = await api('/api/investigations', { method: 'POST', cookies, body: { title: 'Synthetic transfer review', description: 'Synthetic demo case', currency: 'USD' } })
  assert.equal(created.status, 201)
  const { investigation } = await created.json()
  assert.equal((await api(`/api/investigations/${investigation.id}`, { cookies })).status, 200)
  const csv = 'transaction_id,sender_account,receiver_account,amount,timestamp,description\nT-1,A,B,10,2026-01-01T10:00:00Z,"line one, ""quoted"""\nT-2,A,C,12,2026-01-01T10:01:00Z,"=HYPERLINK(""https://example.invalid"",""x"")"\nT-3,A,D,15,2026-01-01T10:02:00Z,"first line\nsecond line"\nT-4,A,E,-3,not-a-date,bad\nT-1,A,B,10,2026-01-01T10:00:00Z,duplicate'
  const preview = await api(`/api/investigations/${investigation.id}/csv/preview`, { method: 'POST', cookies, body: { csv } })
  assert.equal(preview.status, 200)
  const previewResult = await preview.json()
  assert.equal(previewResult.validRows.length, 3)
  assert.equal(previewResult.invalidRows.length, 1)
  assert.equal(previewResult.duplicateRows.length, 1)
  const imported = await api(`/api/investigations/${investigation.id}/csv/import`, { method: 'POST', cookies, body: { csv, confirm: true } })
  assert.equal((await imported.json()).imported, 3)
  const analysis = await api(`/api/investigations/${investigation.id}/analyze`, { method: 'POST', cookies, body: {} })
  assert.equal(analysis.status, 200)
  const analyzed = await analysis.json()
  assert.equal(analyzed.findings.length, 2)
  assert.equal(analyzed.createdCount, 2)
  assert.equal(analyzed.updatedCount, 0)
  assert.deepEqual(analyzed.findings.map((item) => item.rule_name).sort(), ['Fund splitting across destinations', 'High transaction velocity'])
  const firstFindingIds = analyzed.findings.map((item) => item.id).sort()
  const repeatedAnalysis = await api(`/api/investigations/${investigation.id}/analyze`, { method: 'POST', cookies, body: {} })
  const repeatedResult = await repeatedAnalysis.json()
  assert.equal(repeatedResult.createdCount, 0)
  assert.equal(repeatedResult.updatedCount, 2)
  assert.deepEqual(repeatedResult.findings.map((item) => item.id).sort(), firstFindingIds)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM findings WHERE investigation_id=?').get(investigation.id).count, 2)
  const savedNote = 'Review note, with "quotes" and\nanother line.'
  assert.equal((await api(`/api/investigations/${investigation.id}/notes`, { method: 'POST', cookies, body: { note: savedNote } })).status, 201)
  const alerts = await api('/api/alerts', { cookies })
  assert.equal(alerts.status, 200)
  const alertResult = await alerts.json()
  assert.match(alertResult.source, /IMPORTED CASE DATA/)
  assert.ok(alertResult.findings.some((item) => item.investigation_id === investigation.id))
  const report = await api(`/api/investigations/${investigation.id}/report`, { cookies })
  const reportResult = (await report.json()).report
  assert.equal(reportResult.datasetCoverage.transactionCount, 3)
  assert.equal(reportResult.findings.length, 2)
  assert.ok(reportResult.findings.every((item) => item.supporting_transaction_ids.length > 0))
  assert.equal(reportResult.notes[0].note, savedNote)
  assert.deepEqual(reportResult.riskOverview.findingsBySeverity, [{ severity: 'MEDIUM', count: 2 }])
  assert.deepEqual(reportResult.riskOverview.accountsWithMultipleFindings, [
    { accountId: 'A', findingCount: 2 },
    { accountId: 'B', findingCount: 2 },
    { accountId: 'C', findingCount: 2 },
    { accountId: 'D', findingCount: 2 },
  ])
  assert.equal(Object.hasOwn(reportResult, 'riskScore'), false)
  const pdfResponse = await api(`/api/investigations/${investigation.id}/report/pdf`, { cookies })
  assert.equal(pdfResponse.status, 200)
  assert.match(pdfResponse.headers.get('content-type'), /application\/pdf/)
  assert.match(pdfResponse.headers.get('content-disposition'), new RegExp(`MuleShield_${investigation.id}_Report\\.pdf`))
  const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer())
  assert.ok(pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
  assert.match(pdfBytes.toString('latin1').slice(-20), /%%EOF\s*$/)
  const pdfContent = pdfText(pdfBytes).replace(/\s+/g, '')
  for (const expected of [
    'MULESHIELD',
    'Case ID:',
    'Risk overview',
    'MEDIUM (2)',
    'Accounts associated with multiple findings',
    'Transaction network graph',
    'High transaction velocity',
    'T-1',
    'Review the supporting transactions',
    'Review note, with',
    'not proof of fraud',
  ]) assert.ok(pdfContent.includes(expected.replace(/\s+/g, '')), `PDF should include ${expected}.`)
  assert.ok(pdfContent.includes(investigation.id.replace(/\s+/g, '')))
  const excelResponse = await api(`/api/investigations/${investigation.id}/report/xlsx`, { cookies })
  assert.equal(excelResponse.status, 200)
  assert.match(excelResponse.headers.get('content-type'), /spreadsheetml\.sheet/)
  assert.match(excelResponse.headers.get('content-disposition'), new RegExp(`MuleShield_${investigation.id}_Report\\.xlsx`))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(await excelResponse.arrayBuffer()))
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Case Summary', 'Transactions', 'Findings', 'Accounts'])
  const exportedTransactions = workbook.getWorksheet('Transactions')
  assert.equal(exportedTransactions.getCell('D2').value, 10)
  assert.equal(typeof exportedTransactions.getCell('D2').value, 'number')
  assert.equal(exportedTransactions.getCell('H3').value, '\'=HYPERLINK("https://example.invalid","x")')
  const exportedSummary = workbook.getWorksheet('Case Summary')
  assert.ok(exportedSummary.getColumn(2).values.some((value) => String(value).includes(savedNote)))
  const transactionsCsvResponse = await api(`/api/investigations/${investigation.id}/report/csv`, { cookies })
  const transactionsCsv = Buffer.from(await transactionsCsvResponse.arrayBuffer()).toString('utf8')
  assert.equal(transactionsCsvResponse.status, 200)
  assert.match(transactionsCsvResponse.headers.get('content-disposition'), /Transactions\.csv/)
  assert.match(transactionsCsv, /^\uFEFF"Transaction ID","Sender account","Receiver account","Amount"/)
  assert.match(transactionsCsv, /"T-1","A","B","10"/)
  assert.match(transactionsCsv, /"'=HYPERLINK\(""https:\/\/example\.invalid"",""x""\)"/)
  assert.match(transactionsCsv, /"line one, ""quoted"""/)
  assert.match(transactionsCsv, /"first line\nsecond line"/)
  const findingsCsvResponse = await api(`/api/investigations/${investigation.id}/report/csv?type=findings`, { cookies })
  const findingsCsv = Buffer.from(await findingsCsvResponse.arrayBuffer()).toString('utf8')
  assert.equal(findingsCsvResponse.status, 200)
  assert.match(findingsCsv, /^\uFEFF"Severity","Title","Explanation"/)
  assert.match(findingsCsv, /"MEDIUM"/)
  assert.equal((await api(`/api/investigations/${investigation.id}/report/csv?type=unknown`, { cookies })).status, 400)
  assert.equal((await api(`/api/investigations/${investigation.id}/report/xml`, { cookies })).status, 404)
  const otherCaseResponse = await api('/api/investigations', { method: 'POST', cookies, body: { title: 'Separate synthetic case' } })
  const { investigation: otherCase } = await otherCaseResponse.json()
  await api(`/api/investigations/${otherCase.id}/csv/import`, {
    method: 'POST',
    cookies,
    body: { csv: 'transaction_id,sender_account,receiver_account,amount,timestamp\nOTHER-CASE-ONLY,SYNTH-1,SYNTH-2,99,2026-02-01T10:00:00Z', confirm: true },
  })
  const otherCaseReport = (await (await api(`/api/investigations/${otherCase.id}/report`, { cookies })).json()).report
  assert.deepEqual(otherCaseReport.supportingTransactions.map((item) => item.transaction_id), ['OTHER-CASE-ONLY'])
  assert.ok(!reportResult.supportingTransactions.some((item) => item.transaction_id === 'OTHER-CASE-ONLY'))
  const isolatedCsv = Buffer.from(await (await api(`/api/investigations/${investigation.id}/report/csv`, { cookies })).arrayBuffer()).toString('utf8')
  assert.ok(!isolatedCsv.includes('OTHER-CASE-ONLY'))
  const graph = await api(`/api/investigations/${investigation.id}/network`, { cookies })
  assert.equal((await graph.json()).accounts.length, 4)
  assert.equal((await api(`/api/investigations/${investigation.id}`, { method: 'PATCH', cookies, body: { status: 'CLOSED' } })).status, 200)
  assert.equal((await api(`/api/investigations/${investigation.id}`, { method: 'PATCH', cookies, body: { status: 'OPEN' } })).status, 200)
  const reopened = await api(`/api/investigations/${investigation.id}`, { cookies })
  assert.equal(reopened.status, 200)
  const reopenedCase = await reopened.json()
  assert.equal(reopenedCase.transactions.length, 3)
  assert.equal(reopenedCase.findings.length, 2)
  const listed = await (await api('/api/investigations', { cookies })).json()
  assert.ok(listed.investigations.some((item) => item.id === investigation.id))
  const { cookies: otherCookies } = await loginAndEnroll(otherAnalystEmail)
  const denied = await api(`/api/investigations/${investigation.id}`, { cookies: otherCookies })
  assert.equal(denied.status, 404)
  assert.equal((await api(`/api/investigations/${investigation.id}/analyze`, { method: 'POST', cookies: otherCookies, body: {} })).status, 404)
  assert.equal((await api(`/api/investigations/${investigation.id}/report/pdf`, { cookies: otherCookies })).status, 404)
  const otherAlerts = await (await api('/api/alerts', { cookies: otherCookies })).json()
  assert.ok(otherAlerts.findings.every((item) => item.investigation_id !== investigation.id))
})

test('empty cases produce valid empty exports without inventing records', async () => {
  const email = makeEmail('empty-case')
  provision(db, { email, name: 'Empty Case Analyst', role: 'ANALYST', password: 'a-test-password-that-is-long' })
  const { cookies } = await loginAndEnroll(email)
  const created = await api('/api/investigations', { method: 'POST', cookies, body: { title: 'Empty synthetic case' } })
  assert.equal(created.status, 201)
  const { investigation } = await created.json()
  const jsonResponse = await api(`/api/investigations/${investigation.id}/report`, { cookies })
  const jsonReport = (await jsonResponse.json()).report
  assert.equal(jsonReport.supportingTransactions.length, 0)
  assert.equal(jsonReport.findings.length, 0)
  assert.equal(jsonReport.notes.length, 0)
  assert.deepEqual(jsonReport.riskOverview, { findingsBySeverity: [], findingsByRule: [], accountsWithMultipleFindings: [] })
  const csvResponse = await api(`/api/investigations/${investigation.id}/report/csv`, { cookies })
  const csv = Buffer.from(await csvResponse.arrayBuffer()).toString('utf8')
  assert.match(csv, /^\uFEFF"Transaction ID","Sender account","Receiver account","Amount"/)
  assert.equal((csv.match(/T-[0-9]+/g) || []).length, 0)
  const pdfResponse = await api(`/api/investigations/${investigation.id}/report/pdf`, { cookies })
  const pdf = Buffer.from(await pdfResponse.arrayBuffer())
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
  const xlsxResponse = await api(`/api/investigations/${investigation.id}/report/xlsx`, { cookies })
  const emptyWorkbook = new ExcelJS.Workbook()
  await emptyWorkbook.xlsx.load(Buffer.from(await xlsxResponse.arrayBuffer()))
  assert.deepEqual(emptyWorkbook.worksheets.map((sheet) => sheet.name), ['Case Summary', 'Transactions', 'Findings'])
  assert.equal(emptyWorkbook.getWorksheet('Transactions').rowCount, 1)
  assert.equal(emptyWorkbook.getWorksheet('Findings').rowCount, 1)
})
