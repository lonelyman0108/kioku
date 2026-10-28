CREATE INDEX "recall_events_space_id_owner_account_id_app_id_id_index" ON "recall_events" USING btree ("space_id","owner_account_id","app_id","id");--> statement-breakpoint
-- 开始记录召回事件的时间：之前的记忆没机会被记下召回，召回分析要等记录满保留天数之后才把它们算作「从没被召回」。
-- 0014 已经在记的话取最早的一条事件；recall_events 开了 FORCE RLS，迁移连接没有设置 app.space_id，
-- 要先临时取消 FORCE 才查得到（见 0010）
ALTER TABLE recall_events NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO settings (key, value)
SELECT 'recall-started', to_jsonb(coalesce(min(created_at), now())) FROM recall_events
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
ALTER TABLE recall_events FORCE ROW LEVEL SECURITY;
