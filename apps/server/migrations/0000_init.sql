CREATE TYPE "public"."member_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."memory_form" AS ENUM('curated', 'extracted');--> statement-breakpoint
CREATE TYPE "public"."memory_layer" AS ENUM('base', 'persona', 'app', 'owner', 'private', 'subject', 'episode');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('owner', 'agent', 'untrusted', 'system');--> statement-breakpoint
CREATE TYPE "public"."sensitivity" AS ENUM('public', 'internal', 'private', 'secret');--> statement-breakpoint
CREATE TYPE "public"."subject_kind" AS ENUM('person', 'group');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"runtime_family" text NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"default_persona_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_spaceId_id_unique" UNIQUE("space_id","id")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"form" "memory_form" NOT NULL,
	"layer" "memory_layer" NOT NULL,
	"sensitivity" "sensitivity" NOT NULL,
	"provenance" "provenance" NOT NULL,
	"origin_scope" text DEFAULT 'global' NOT NULL,
	"owner_account_id" uuid,
	"persona_id" uuid,
	"app_id" uuid,
	"subject_id" uuid,
	"domain" text,
	"path" text,
	"content" text,
	"ciphertext" "bytea",
	"wrapped_key" "bytea",
	"priority" integer DEFAULT 2 NOT NULL,
	"disclosure" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "memories_spaceId_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "memories_uri_by_form" CHECK (("memories"."form" = 'curated') = ("memories"."domain" is not null and "memories"."path" is not null)),
	CONSTRAINT "memories_secret_encrypted" CHECK (case when "memories"."sensitivity" = 'secret'
        then "memories"."content" is null and "memories"."ciphertext" is not null and "memories"."wrapped_key" is not null
        else "memories"."content" is not null and "memories"."ciphertext" is null and "memories"."wrapped_key" is null end),
	CONSTRAINT "memories_owner_by_layer" CHECK (("memories"."layer" in ('owner', 'private')) = ("memories"."owner_account_id" is not null)
        and ("memories"."layer" = 'persona') = ("memories"."persona_id" is not null)
        and ("memories"."layer" = 'app') = ("memories"."app_id" is not null)
        and ("memories"."layer" = 'subject') = ("memories"."subject_id" is not null)),
	CONSTRAINT "memories_untrusted_layers" CHECK ("memories"."provenance" <> 'untrusted' or "memories"."layer" in ('subject', 'episode')),
	CONSTRAINT "memories_priority_nonneg" CHECK ("memories"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "memory_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"memory_id" uuid,
	"event_type" text NOT NULL,
	"actor_key_id" uuid,
	"actor_account_id" uuid,
	"provenance" "provenance" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_glossary" (
	"space_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"keyword" text NOT NULL,
	CONSTRAINT "memory_glossary_memory_id_keyword_pk" PRIMARY KEY("memory_id","keyword")
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"extends_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_spaceId_id_unique" UNIQUE("space_id","id")
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"space_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_space_id_account_id_pk" PRIMARY KEY("space_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"kind" "subject_kind" NOT NULL,
	"display_name" text NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_spaceId_id_unique" UNIQUE("space_id","id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_default_persona_id_personas_id_fk" FOREIGN KEY ("default_persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_persona_id_personas_space_id_id_fk" FOREIGN KEY ("space_id","persona_id") REFERENCES "public"."personas"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_subject_id_subjects_space_id_id_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_glossary" ADD CONSTRAINT "memory_glossary_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_glossary" ADD CONSTRAINT "memory_glossary_space_id_memory_id_memories_space_id_id_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_extends_id_personas_id_fk" FOREIGN KEY ("extends_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_identities" ADD CONSTRAINT "subject_identities_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_identities" ADD CONSTRAINT "subject_identities_space_id_subject_id_subjects_space_id_id_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_space_id_index" ON "api_keys" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_space_id_slug_index" ON "apps" USING btree ("space_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_uri_live_idx" ON "memories" USING btree ("space_id","domain","path") WHERE "memories"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "memories_space_id_layer_index" ON "memories" USING btree ("space_id","layer");--> statement-breakpoint
CREATE INDEX "memories_subject_id_index" ON "memories" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "memory_events_space_id_created_at_index" ON "memory_events" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_events_memory_id_created_at_index" ON "memory_events" USING btree ("memory_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_glossary_space_id_keyword_index" ON "memory_glossary" USING btree ("space_id","keyword");--> statement-breakpoint
CREATE UNIQUE INDEX "personas_space_id_slug_index" ON "personas" USING btree ("space_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_identities_space_id_platform_external_id_index" ON "subject_identities" USING btree ("space_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "subject_identities_subject_id_index" ON "subject_identities" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subjects_space_id_index" ON "subjects" USING btree ("space_id");