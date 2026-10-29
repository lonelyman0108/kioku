-- 导入空间时不为每个 URI 加咨询锁。导入在一个事务里建出新空间、写下全部记忆；咨询锁要到事务结束才放，
-- 上万条带 URI 的记忆会占满共享的锁表（默认配置下一万多把），还会挤掉别的连接要用的锁。
-- 这把锁只是让并发写同一个 URI 的事务排队；空间这一行是本事务刚写下的（xmin 是本事务）时，
-- 提交之前别的事务看不到这个空间，也写不进它的记忆，没有要排队的。只有导入的事务设置 app.importing_space，
-- 两个条件都满足才跳过（这个会话里没设过时 current_setting 是 NULL，先换成空串，免得条件成了 NULL 被当成不成立）；
-- 冲突的检查照常做
CREATE OR REPLACE FUNCTION memories_uri_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.domain IS NULL OR NEW.path IS NULL THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('app.importing_space', true), '') <> NEW.space_id::text
    OR NOT EXISTS (
      SELECT 1 FROM spaces s WHERE s.id = NEW.space_id AND s.xmin = pg_current_xact_id()::xid
    ) THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.space_id::text || '|' || NEW.domain || '://' || NEW.path));
  END IF;
  IF EXISTS (
    SELECT 1 FROM memories m
    WHERE m.space_id = NEW.space_id AND m.domain = NEW.domain AND m.path = NEW.path
      AND m.deleted_at IS NULL AND m.id <> NEW.id
      AND (m.valid_to IS NULL OR m.valid_to > now())
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND (NEW.owner_account_id IS NULL OR m.owner_account_id IS NULL OR m.owner_account_id = NEW.owner_account_id)
  ) THEN
    RAISE EXCEPTION 'URI 已被占用' USING ERRCODE = 'unique_violation', CONSTRAINT = 'memories_uri_live_idx';
  END IF;
  RETURN NEW;
END
$$;
