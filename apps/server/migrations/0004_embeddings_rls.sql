-- memory_embeddings 与其他内容表一样按 app.space_id 强制隔离
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memory_embeddings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON memory_embeddings
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
-- 已有实例：最早创建的账号就是首次初始化的账号，设为管理员
UPDATE accounts SET is_admin = true WHERE id = (SELECT id FROM accounts ORDER BY created_at LIMIT 1);
