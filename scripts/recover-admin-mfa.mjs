import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { access } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const databasePath = process.env.MULESHIELD_DB_PATH || path.resolve('data/muleshield.sqlite')
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('Administrator MFA recovery must run from an interactive local terminal.')
  process.exit(1)
}
try {
  await access(databasePath)
} catch {
  console.error(`MuleShield database not found at ${databasePath}; no changes were made.`)
  process.exit(1)
}

const rl = readline.createInterface({ input: stdin, output: stdout })
const db = new DatabaseSync(databasePath)
try {
  const email = (await rl.question('Administrator account email: ')).trim().toLowerCase()
  const ticket = (await rl.question('Verified incident/ticket reference: ')).trim()
  const user = db.prepare("SELECT id,email,role FROM users WHERE email=? AND role='ADMINISTRATOR' AND enabled=1").get(email)
  if (!user || !ticket || ticket.length > 200) {
    console.error('An enabled Administrator and a valid incident reference are required; no changes were made.')
    process.exitCode = 1
  } else {
    const confirmation = await rl.question(`After independently verifying identity, type RESET MFA FOR ${email}: `)
    if (confirmation !== `RESET MFA FOR ${email}`) {
      console.error('Confirmation did not match; no changes were made.')
      process.exitCode = 1
    } else {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare("UPDATE users SET mfa_enabled=0,totp_secret=NULL,pending_totp_secret=NULL,last_totp_step=NULL,recovery_hashes='[]' WHERE id=?").run(user.id)
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
        db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(user.id)
        db.prepare('DELETE FROM mfa_enrollment_challenges WHERE user_id=?').run(user.id)
        db.prepare('INSERT INTO audit_events (id,event_type,timestamp,actor_id,object_id,success,metadata) VALUES (?,?,?,?,?,?,?)')
          .run(crypto.randomUUID(), 'ADMIN_MFA_OFFLINE_RECOVERY', new Date().toISOString(), null, user.id, 1, JSON.stringify({ ticket, method: 'offline_operator_recovery', reEnrollmentRequired: true }))
        db.exec('COMMIT')
        console.log(`MFA reset for ${email}. All sessions were revoked; the next password login must complete MFA enrollment.`)
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Recovery failed; no success was reported.')
  process.exitCode = 1
} finally {
  rl.close()
  db.close()
}
