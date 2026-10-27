CREATE TABLE "memory_credential_refs" (
	"space_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	CONSTRAINT "memory_credential_refs_memory_id_identifier_pk" PRIMARY KEY("memory_id","identifier")
);
--> statement-breakpoint
ALTER TABLE "memory_credential_refs" ADD CONSTRAINT "memory_credential_refs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_credential_refs" ADD CONSTRAINT "memory_credential_refs_memory_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_credential_refs_space_id_identifier_index" ON "memory_credential_refs" USING btree ("space_id","identifier");--> statement-breakpoint
-- 已有的记忆按正文补上引用：只有不是 secret 的（secret 的正文是密文，也不进索引）。正则与 contracts 里的
-- CREDENTIAL_PLACEHOLDER 相同。memories 开了 FORCE RLS，迁移连接没有设置 app.space_id，查询会被过滤成零行，
-- 所以在本迁移的事务里临时取消 FORCE、补完立即恢复（见 0010）
ALTER TABLE memories NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO memory_credential_refs (space_id, memory_id, identifier)
SELECT DISTINCT m.space_id, m.id, r.match[1]
FROM memories m
CROSS JOIN LATERAL regexp_matches(
  m.content,
  '\{\{cred:([a-z0-9][a-z0-9_-]{0,63})(?:#[a-z0-9][a-z0-9_-]{0,63})?\}\}',
  'g'
) AS r(match)
WHERE m.content IS NOT NULL AND m.sensitivity <> 'secret';
--> statement-breakpoint
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 与其他内容表一样按 app.space_id 强制隔离
ALTER TABLE memory_credential_refs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memory_credential_refs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON memory_credential_refs
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
