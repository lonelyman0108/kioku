-- 导入空间时不为每个 URI 加咨询锁。这里只换 URI 互斥触发器的函数，触发器本身和它看的列
-- （含 valid_to、expires_at）沿用上一个迁移。函数现在包含这几条规则：
--
-- 不检查的：已删除的、没有 URI 的，以及这一行自己已经失效或过期的（valid_to、expires_at 不晚于 now()）。
-- 已失效或过期的记录不挡别人，也不被别人挡。
--
-- 咨询锁：按 URI 加一把锁到事务结束，让并发写同一个 URI 的事务排队。导入空间的事务例外：
-- 导入在一个事务里建出新空间、写下全部记忆，上万条带 URI 的记忆各加一把锁会占满共享的锁表
-- （默认配置下一万多把），还会挤掉别的连接要用的锁。空间这一行是本事务刚写下的（xmin 是本事务）时，
-- 提交之前别的事务看不到这个空间，也写不进它的记忆，没有要排队的。只有导入的事务设置 app.importing_space：
-- 它等于这一行的空间、而且空间那一行是本事务写下的，两个条件都满足才不加锁
-- （这个会话里没设过时 current_setting 是 NULL，先换成空串，免得条件成了 NULL 被当成不成立）。
--
-- 冲突：同一个空间、同一个 URI 上还有别的没删除、没失效也没过期的记录，而且两边有一边是共享节点、
-- 或者两边属于同一个成员时，报唯一约束冲突（约束名 memories_uri_live_idx，服务层转成 409）。
-- 不加咨询锁时也照常检查
CREATE OR REPLACE FUNCTION memories_uri_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.domain IS NULL OR NEW.path IS NULL
    OR (NEW.valid_to IS NOT NULL AND NEW.valid_to <= now())
    OR (NEW.expires_at IS NOT NULL AND NEW.expires_at <= now()) THEN
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
