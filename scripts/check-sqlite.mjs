import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/muleshield.sqlite')

try {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all()

  console.log('Existing SQLite tables:')
  console.table(tables)
} finally {
  db.close()
}