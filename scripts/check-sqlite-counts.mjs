import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/muleshield.sqlite')

const tables = [
  'users',
  'sessions',
  'mfa_challenges',
  'mfa_enrollment_challenges',
  'audit_events',
  'investigations',
  'transactions',
  'findings',
  'investigation_notes',
  'monitoring_state',
]

try {
  console.log('MuleShield SQLite Record Counts:\n')

  for (const table of tables) {
    const result = db.prepare(
      `SELECT COUNT(*) AS count FROM "${table}"`
    ).get()

    console.log(`${table}: ${result.count}`)
  }
} finally {
  db.close()
}