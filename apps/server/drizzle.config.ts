import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './db/migrations',
  dialect: 'mysql',
  dbCredentials: {
    url: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'mysql://root:test@127.0.0.1:3307/st_test',
  },
})
