CREATE TYPE "public"."credential_provider_kind" AS ENUM('bitwarden', '1password', 'env', 'other');--> statement-breakpoint
CREATE TYPE "public"."credential_source" AS ENUM('hosted', 'external');--> statement-breakpoint
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
CREATE TABLE "credential_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"kind" "credential_provider_kind" NOT NULL,
	"name" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credential_providers_spaceId_ownerAccountId_id_unique" UNIQUE("space_id","owner_account_id","id")
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
	"provider_id" uuid,
	"location" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ciphertext" "bytea",
	"wrapped_key" "bytea",
	"app_ids" uuid[],
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credentials_spaceId_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "credentials_source_shape" CHECK (case when "credentials"."source" = 'hosted'
        then "credentials"."ciphertext" is not null and "credentials"."wrapped_key" is not null and "credentials"."provider_id" is null and "credentials"."location" is null
        else "credentials"."ciphertext" is null and "credentials"."wrapped_key" is null and "credentials"."provider_id" is not null and "credentials"."location" is not null end)
);
--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_credential_fk" FOREIGN KEY ("space_id","credential_id") REFERENCES "public"."credentials"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_providers" ADD CONSTRAINT "credential_providers_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_providers" ADD CONSTRAINT "credential_providers_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_provider_fk" FOREIGN KEY ("space_id","owner_account_id","provider_id") REFERENCES "public"."credential_providers"("space_id","owner_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_events_credential_id_created_at_index" ON "credential_events" USING btree ("credential_id","created_at");--> statement-breakpoint
CREATE INDEX "credential_providers_space_id_owner_account_id_index" ON "credential_providers" USING btree ("space_id","owner_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_identifier_live_idx" ON "credentials" USING btree ("space_id","owner_account_id","identifier") WHERE "credentials"."deleted_at" is null;--> statement-breakpoint
-- 凭据的三张表与其他内容表一样按 app.space_id 强制隔离（见 0001）
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['credential_providers', 'credentials', 'credential_events']
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
