CREATE INDEX "recall_events_space_id_owner_account_id_id_index" ON "recall_events" USING btree ("space_id","owner_account_id","id");--> statement-breakpoint
-- 开始记录召回事件的时间：之前的记忆没机会被记下召回，召回分析要等记录满保留天数之后才把它们算作「从没被召回」
INSERT INTO settings (key, value) VALUES ('recall-started', to_jsonb(now())) ON CONFLICT (key) DO NOTHING;
