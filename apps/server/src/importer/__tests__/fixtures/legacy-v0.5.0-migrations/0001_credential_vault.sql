-- 凭据改版：凭据源换成密码库连接，凭据的来源只剩托管与密码库。不兼容旧的凭据：三张凭据表连同事件直接删掉重建。
-- 这几张表 FORCE RLS，迁移连接没有设置 app.space_id，DELETE 会被策略过滤成零行，所以用 DROP 而不是逐行删。
-- 引用索引（memory_credential_refs）按标识记，不指向凭据，留着
DROP TABLE "credential_events";--> statement-breakpoint
DROP TABLE "credentials";--> statement-breakpoint
DROP TABLE "credential_providers";--> statement-breakpoint
DROP TYPE "public"."credential_source";--> statement-breakpoint
DROP TYPE "public"."credential_provider_kind";--> statement-breakpoint
CREATE TYPE "public"."credential_source" AS ENUM('hosted', 'vault');--> statement-breakpoint
CREATE TYPE "public"."vault_connection_status" AS ENUM('ok', 'reauth_required', 'disabled', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."vault_disabled_reason" AS ENUM('personal_items', 'organization_role');--> statement-breakpoint
CREATE TYPE "public"."vault_error_kind" AS ENUM('invalid_credentials', 'two_factor_invalid', 'unsupported_two_factor', 'reauth_required', 'item_unavailable', 'unsupported_format', 'integrity', 'unreachable', 'server_error');--> statement-breakpoint
CREATE TABLE "vault_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"server_url" text NOT NULL,
	"email" text NOT NULL,
	"vault_user_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"ciphertext" "bytea",
	"wrapped_key" "bytea",
	"key_id" text,
	"status" "vault_connection_status" DEFAULT 'ok' NOT NULL,
	"disabled_reason" "vault_disabled_reason",
	"last_error_kind" "vault_error_kind",
	"last_error_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"default_collection_id" text,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_connections_spaceId_ownerAccountId_id_unique" UNIQUE("space_id","owner_account_id","id"),
	CONSTRAINT "vault_connections_secrets_shape" CHECK (("vault_connections"."ciphertext" is null) = ("vault_connections"."wrapped_key" is null)
        and ("vault_connections"."ciphertext" is null) = ("vault_connections"."status" = 'disconnected')
        and ("vault_connections"."disconnected_at" is null) = ("vault_connections"."status" <> 'disconnected')),
	CONSTRAINT "vault_connections_disabled_reason" CHECK (("vault_connections"."disabled_reason" is null) = ("vault_connections"."status" <> 'disabled')),
	CONSTRAINT "vault_connections_last_error" CHECK (("vault_connections"."last_error_kind" is null) = ("vault_connections"."last_error_at" is null))
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" "credential_source" NOT NULL,
	"vault_connection_id" uuid,
	"vault_item_id" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ciphertext" "bytea",
	"wrapped_key" "bytea",
	"key_id" text,
	"app_ids" uuid[],
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credentials_spaceId_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "credentials_source_shape" CHECK (case when "credentials"."source" = 'hosted'
        then "credentials"."ciphertext" is not null and "credentials"."wrapped_key" is not null and "credentials"."vault_connection_id" is null and "credentials"."vault_item_id" is null
        else "credentials"."ciphertext" is null and "credentials"."wrapped_key" is null and "credentials"."vault_connection_id" is not null and "credentials"."vault_item_id" is not null end)
);
--> statement-breakpoint
CREATE TABLE "credential_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_key_id" uuid,
	"actor_account_id" uuid,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_vault_connection_fk" FOREIGN KEY ("space_id","owner_account_id","vault_connection_id") REFERENCES "public"."vault_connections"("space_id","owner_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_credential_fk" FOREIGN KEY ("space_id","credential_id") REFERENCES "public"."credentials"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_connections_space_id_owner_account_id_index" ON "vault_connections" USING btree ("space_id","owner_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_connections_account_idx" ON "vault_connections" USING btree ("space_id","owner_account_id","server_url","vault_user_id");--> statement-breakpoint
CREATE INDEX "vault_connections_key_id_idx" ON "vault_connections" USING btree ("space_id","key_id") WHERE "vault_connections"."wrapped_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_identifier_live_idx" ON "credentials" USING btree ("space_id","owner_account_id","identifier") WHERE "credentials"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_vault_item_live_idx" ON "credentials" USING btree ("vault_connection_id","vault_item_id") WHERE "credentials"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "credentials_vault_connection_idx" ON "credentials" USING btree ("vault_connection_id");--> statement-breakpoint
CREATE INDEX "credentials_key_id_idx" ON "credentials" USING btree ("space_id","key_id") WHERE "credentials"."wrapped_key" is not null;--> statement-breakpoint
CREATE INDEX "credential_events_credential_id_id_index" ON "credential_events" USING btree ("credential_id","id");--> statement-breakpoint
-- 重建的三张表重新开启并强制 RLS，策略与 0000_baseline 的相同；清单与 src/db/schema.ts 的 RLS_TABLES 一致，
-- rls.int.test.ts 核对两边
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vault_connections', 'credentials', 'credential_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY space_isolation ON %I USING (space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid) WITH CHECK (space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint
-- 访问密钥加了凭据能力，已有的访问密钥补上 none（不可用）。api_keys 是身份表，不受 RLS 约束
UPDATE "api_keys" SET "scopes" = "scopes" || '{"credentials":"none"}'::jsonb WHERE NOT ("scopes" ? 'credentials');
