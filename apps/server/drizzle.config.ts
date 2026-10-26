import { defineConfig } from 'drizzle-kit'

// 只用于 drizzle-kit generate 生成迁移 SQL；运行时迁移见 src/db/migrate.ts
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  casing: 'snake_case',
})
