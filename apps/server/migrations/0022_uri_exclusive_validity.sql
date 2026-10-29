-- 让记忆重新生效时只改有效期（valid_to、expires_at），原来的触发器只在改 URI、归属与删除状态时检查，
-- 重新生效的记录就会和占着这个 URI 的成员节点（或共享节点）并存。改成有效期变化时也检查。
-- 同时把「已失效或过期的记录不算 URI 冲突」用到被写入的这一行上：它自己已经过期时不挡别人，也不被别人挡
CREATE OR REPLACE FUNCTION memories_uri_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.domain IS NULL OR NEW.path IS NULL
    OR (NEW.valid_to IS NOT NULL AND NEW.valid_to <= now())
    OR (NEW.expires_at IS NOT NULL AND NEW.expires_at <= now()) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.space_id::text || '|' || NEW.domain || '://' || NEW.path));
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
--> statement-breakpoint
DROP TRIGGER memories_uri_exclusive ON memories;
--> statement-breakpoint
CREATE TRIGGER memories_uri_exclusive
  BEFORE INSERT OR UPDATE OF domain, path, owner_account_id, deleted_at, valid_to, expires_at ON memories
  FOR EACH ROW EXECUTE FUNCTION memories_uri_exclusive();
