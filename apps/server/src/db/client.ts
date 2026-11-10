import { drizzle } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import path from 'node:path'
import * as schema from './schema'

export async function getDb(databaseUrl: string) {
  const pool = mysql.createPool(databaseUrl)
  return drizzle(pool, { schema, mode: 'default' })
}

export async function applyMigrations(db: any) {
  const migrationsFolder = path.resolve(process.cwd(), 'apps/server/db/migrations')
  await migrate(db, { migrationsFolder })
}
