-- 凭据的到期与轮换、值版本与看到的条目修改时间；密码库连接的去处（集合连同组织与名称，每个成员最多一个）；写回的错误类别。
-- 已有的托管凭据按现在的版本与更新时间补上值版本与上次改值的时间。这两张表 FORCE RLS，迁移连接没有设置 app.space_id，
-- UPDATE 会被策略过滤成零行，所以先 NO FORCE、改完再 FORCE
ALTER TYPE "public"."vault_error_kind" ADD VALUE 'read_only' BEFORE 'unsupported_format';--> statement-breakpoint
ALTER TYPE "public"."vault_error_kind" ADD VALUE 'item_conflict' BEFORE 'unsupported_format';--> statement-breakpoint
ALTER TYPE "public"."vault_error_kind" ADD VALUE 'value_too_long' BEFORE 'unsupported_format';--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rotation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "value_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "value_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "vault_revision" text;--> statement-breakpoint
ALTER TABLE "vault_connections" ADD COLUMN "default_organization_id" text;--> statement-breakpoint
ALTER TABLE "vault_connections" ADD COLUMN "default_collection_name" text;--> statement-breakpoint
ALTER TABLE "credentials" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vault_connections" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "credentials" SET "value_version" = "version", "value_changed_at" = "updated_at" WHERE "source" = 'hosted';--> statement-breakpoint
UPDATE "vault_connections" SET "default_collection_id" = NULL WHERE "default_collection_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vault_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "vault_connections_destination_idx" ON "vault_connections" USING btree ("space_id","owner_account_id") WHERE "vault_connections"."default_collection_id" is not null;--> statement-breakpoint
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_destination_shape" CHECK (("vault_connections"."default_collection_id" is null) = ("vault_connections"."default_organization_id" is null)
        and ("vault_connections"."default_collection_id" is null) = ("vault_connections"."default_collection_name" is null));
