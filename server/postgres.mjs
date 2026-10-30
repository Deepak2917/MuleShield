import pg from 'pg'

const { Pool } = pg

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is missing. Configure your PostgreSQL connection string in the environment.'
  )
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error.message)
})

export async function checkPostgresConnection() {
  const result = await pool.query('SELECT NOW() AS server_time')
  return result.rows[0]
}