-- 在「改成 secret 时清除历史明文」上线之前，已经被改成 secret 的记忆，历史事件快照里可能还留着明文与全文向量。
-- 这里一次性清掉。memories 与 memory_events 开了 FORCE RLS，迁移连接没有设置 app.space_id，
-- 直接 UPDATE 会被策略过滤成一行都不改；所以在本迁移的事务里临时取消 FORCE，表的属主不受 RLS 约束，
-- 清理完立即恢复。整个迁移在同一个事务里执行，中途失败会一起回滚，不会停在未 FORCE 的状态
ALTER TABLE memories NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memory_events NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE memory_events e
SET before = CASE WHEN e.before IS NULL THEN NULL ELSE e.before - 'content' - 'fts' END,
    after = CASE WHEN e.after IS NULL THEN NULL ELSE e.after - 'content' - 'fts' END
FROM memories m
WHERE e.memory_id = m.id AND m.sensitivity = 'secret';
--> statement-breakpoint
-- 快照从此不再含全文向量（里面是正文分词），旧事件里的也一并去掉
UPDATE memory_events
SET before = CASE WHEN before IS NULL THEN NULL ELSE before - 'fts' END,
    after = CASE WHEN after IS NULL THEN NULL ELSE after - 'fts' END
WHERE (before ? 'fts') OR (after ? 'fts');
--> statement-breakpoint
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memory_events FORCE ROW LEVEL SECURITY;
