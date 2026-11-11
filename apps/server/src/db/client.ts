import { drizzle } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import path from 'node:path'
import * as schema from './schema'

export async function getDb(databaseUrl: string) {
  // dateStrings: DATE/DATETIME columns arrive from the driver as plain calendar
  // strings, never Date objects — the schema columns use mode: 'string' to pass
  // them straight through to the JSON wire as `YYYY-MM-DD` / `YYYY-MM-DD HH:MM:SS`.
  const pool = mysql.createPool({ uri: databaseUrl, dateStrings: true })
  return drizzle(pool, { schema, mode: 'default' })
}

export async function applyMigrations(db: any) {
  const migrationsFolder = path.resolve(process.cwd(), 'apps/server/db/migrations')
  await migrate(db, { migrationsFolder })
}
