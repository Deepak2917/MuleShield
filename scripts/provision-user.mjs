import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const databasePath = process.env.MULESHIELD_DB_PATH || path.resolve('data/muleshield.sqlite')
await mkdir(path.dirname(databasePath), { recursive: true })
const db = new DatabaseSync(databasePath)
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ANALYST', 'ADMINISTRATOR')),
  enabled INTEGER NOT NULL DEFAULT 1, mfa_enabled INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT, pending_totp_secret TEXT, last_totp_step INTEGER,
  recovery_hashes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
)`)

if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
  db.close()
  console.error('Provisioning must run from an interactive terminal.')
  process.exit(1)
}

const rl = readline.createInterface({ input: stdin, output: stdout })

function readHiddenPassword() {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Provisioning must run from an interactive terminal.'))
  }
  stdin.setEncoding('utf8')
  stdout.write('Password (minimum 14 characters): ')
  stdin.setRawMode(true)
  stdin.resume()

  return new Promise((resolve, reject) => {
    let value = ''
    let settled = false
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.off('error', onError)
      stdin.off('end', onEnd)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const key of String(chunk)) {
        if (key === '\u0003') return finish(new Error('Provisioning cancelled.'))
        if (key === '\r' || key === '\n') return finish()
        if (key === '\u007f' || key === '\b') value = value.slice(0, -1)
        else if (key >= ' ' && key !== '\u007f') value += key
      }
    }
    const onError = () => finish(new Error('Password input failed.'))
    const onEnd = () => finish(new Error('Password input ended before submission.'))
    stdin.on('data', onData)
    stdin.once('error', onError)
    stdin.once('end', onEnd)
  })
}

try {
  const email = (await rl.question('Account email: ')).trim().toLowerCase()
  const name = (await rl.question('Display name: ')).trim()
  const role = (await rl.question('Role (ANALYST or ADMINISTRATOR): ')).trim().toUpperCase()
  if (!/^\S+@\S+\.\S+$/.test(email) || !name || !['ANALYST', 'ADMINISTRATOR'].includes(role)) {
    throw new Error('Valid email, name, and role are required.')
  }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
    throw new Error('An account with that email already exists; no changes were made.')
  }

  rl.close()
  const password = await readHiddenPassword()
  if (password.length < 14 || password.length > 128) {
    throw new Error('Password must be between 14 and 128 characters.')
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')
  db.prepare('INSERT INTO users (id,email,name,password_hash,password_salt,role,enabled,mfa_enabled,recovery_hashes,created_at) VALUES (?,?,?,?,?,?,1,0,\'[]\',?)')
    .run(crypto.randomUUID(), email, name, hash, salt, role, new Date().toISOString())
  console.log(`Provisioned ${role} account for ${email}. MFA enrollment is required before workspace access.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Account provisioning failed; no success was reported.')
  process.exitCode = 1
} finally {
  rl.close()
  db.close()
}
