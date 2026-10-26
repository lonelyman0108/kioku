-- 一个 URI 要么是共享的（owner_account_id 为空），要么按成员各自占用，二者不共存。
-- 唯一索引只能保证同一归属下不重复，这条规则用触发器在数据库层兜底，绕开服务层 claimUri 的写入路径也会被拦下。
-- 咨询锁的键与 claimUri 相同，并发写同一个 URI 时串行检查；冲突时按唯一约束错误抛出，服务层统一转成 409
CREATE FUNCTION memories_uri_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.domain IS NULL OR NEW.path IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.space_id::text || '|' || NEW.domain || '://' || NEW.path));
  IF EXISTS (
    SELECT 1 FROM memories m
    WHERE m.space_id = NEW.space_id AND m.domain = NEW.domain AND m.path = NEW.path
      AND m.deleted_at IS NULL AND m.id <> NEW.id
      AND (NEW.owner_account_id IS NULL OR m.owner_account_id IS NULL OR m.owner_account_id = NEW.owner_account_id)
  ) THEN
    RAISE EXCEPTION 'URI 已被占用' USING ERRCODE = 'unique_violation', CONSTRAINT = 'memories_uri_live_idx';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER memories_uri_exclusive
  BEFORE INSERT OR UPDATE OF domain, path, owner_account_id, deleted_at ON memories
  FOR EACH ROW EXECUTE FUNCTION memories_uri_exclusive();
