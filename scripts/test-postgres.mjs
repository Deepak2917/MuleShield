import { checkPostgresConnection, pool } from '../server/postgres.mjs'

try {
  const result = await checkPostgresConnection()
  console.log('PostgreSQL connection successful!')
  console.log('Database server time:', result.server_time)
} catch (error) {
  console.error('PostgreSQL connection failed:', error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}