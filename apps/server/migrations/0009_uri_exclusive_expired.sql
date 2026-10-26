-- 已失效或已过期的记录不再算作 URI 冲突，与服务层 claimUri 的规则一致（它会先让出这些记录）
CREATE OR REPLACE FUNCTION memories_uri_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.domain IS NULL OR NEW.path IS NULL THEN
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
