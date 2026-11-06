-- 迁移基线：表、类型、约束与索引由 drizzle-kit 按 src/db/schema.ts 生成，生成不了的几处手写在这里（文件开头的全文检索配置、
-- 外键 memories_conversation_fk 的动作，以及文件末尾的行级安全、触发器与默认设置）。
--
-- 中文全文检索配置：zhparser 扩展由数据库初始化脚本以超级用户安装，这里只建配置。memories.fts 是用它的生成列，
-- 所以要在建表之前
CREATE TEXT SEARCH CONFIGURATION kioku_zh (PARSER = zhparser);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION kioku_zh ADD MAPPING FOR n, v, a, i, e, l, j WITH simple;
--> statement-breakpoint
CREATE TYPE "public"."conversation_kind" AS ENUM('group', 'direct', 'none');--> statement-breakpoint
CREATE TYPE "public"."credential_provider_kind" AS ENUM('bitwarden', '1password', 'env', 'other');--> statement-breakpoint
CREATE TYPE "public"."credential_source" AS ENUM('hosted', 'external');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."memory_form" AS ENUM('curated', 'extracted');--> statement-breakpoint
CREATE TYPE "public"."memory_layer" AS ENUM('core', 'persona', 'app', 'user', 'subject', 'episode');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('owner', 'agent', 'untrusted', 'system');--> statement-breakpoint
CREATE TYPE "public"."sensitivity" AS ENUM('public', 'internal', 'private', 'secret');--> statement-breakpoint
CREATE TYPE "public"."subject_kind" AS ENUM('person', 'group');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "app_group_personas" (
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_group_personas_app_id_subject_id_pk" PRIMARY KEY("app_id","subject_id")
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
CREATE TABLE "conversation_turns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"session_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"group_subject_id" uuid,
	"sender_subject_id" uuid,
	"owner_account_id" uuid,
	"sender_name" text,
	"user_text" text NOT NULL,
	"reply_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_turns_chat_type" CHECK (case "conversation_turns"."chat_type"
          when 'none' then "conversation_turns"."group_subject_id" is null and "conversation_turns"."sender_subject_id" is null
            and "conversation_turns"."owner_account_id" is not null
          when 'direct' then "conversation_turns"."group_subject_id" is null and "conversation_turns"."sender_subject_id" is not null
            and "conversation_turns"."owner_account_id" is null
          when 'group' then "conversation_turns"."group_subject_id" is not null and "conversation_turns"."sender_subject_id" is not null
            and "conversation_turns"."owner_account_id" is null
          when 'channel' then "conversation_turns"."group_subject_id" is not null and "conversation_turns"."sender_subject_id" is not null
            and "conversation_turns"."owner_account_id" is null
          else false end)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"kind" "conversation_kind" NOT NULL,
	"subject_id" uuid,
	"owner_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_spaceId_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "conversations_kind_shape" CHECK (case when "conversations"."kind" = 'none'
        then "conversations"."subject_id" is null and "conversations"."owner_account_id" is not null
        else "conversations"."subject_id" is not null and "conversations"."owner_account_id" is null end)
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
	"key_id" text,
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
CREATE TABLE "dream_marks" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dream_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"scope" text,
	"owner_account_id" uuid,
	"model" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"considered" integer DEFAULT 0 NOT NULL,
	"suggested" integer DEFAULT 0 NOT NULL,
	"known" integer DEFAULT 0 NOT NULL,
	"dropped" integer DEFAULT 0 NOT NULL,
	"more" boolean DEFAULT false NOT NULL,
	"skipped" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dream_runs_trigger" CHECK ("dream_runs"."trigger" in ('scheduled', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "dream_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"owner_account_id" uuid,
	"kind" text NOT NULL,
	"memory_ids" uuid[] NOT NULL,
	"versions" integer[] NOT NULL,
	"keep_id" uuid,
	"content" text,
	"uri" text,
	"disclosure" text,
	"verdict" text,
	"reason" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dream_suggestions_kind" CHECK ("dream_suggestions"."kind" in ('merge', 'distill', 'stale', 'review')),
	CONSTRAINT "dream_suggestions_status" CHECK ("dream_suggestions"."status" in ('pending', 'applied', 'rejected')),
	CONSTRAINT "dream_suggestions_memories" CHECK (cardinality("dream_suggestions"."memory_ids") >= 1 and cardinality("dream_suggestions"."memory_ids") = cardinality("dream_suggestions"."versions"))
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"subject_ids" uuid[] NOT NULL,
	"turns" integer NOT NULL,
	"skipped_turns" integer DEFAULT 0 NOT NULL,
	"model" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"dropped" integer DEFAULT 0 NOT NULL,
	"summarized" boolean DEFAULT false NOT NULL,
	"summary_only" boolean DEFAULT false NOT NULL,
	"limited" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"username" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
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
	"conversation_id" uuid,
	"domain" text,
	"path" text,
	"title" text,
	"content" text,
	"ciphertext" "bytea",
	"wrapped_key" "bytea",
	"key_id" text,
	"plaintext_ignored_hash" text,
	"priority" integer DEFAULT 2 NOT NULL,
	"disclosure" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('kioku_zh'::regconfig, coalesce(title, '') || ' ' || coalesce(domain, '') || ' ' || coalesce(path, '') || ' ' || coalesce(disclosure, '') || ' ' || coalesce(content, ''))) STORED,
	CONSTRAINT "memories_spaceId_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "memories_form_by_layer" CHECK (("memories"."form" = 'curated') = ("memories"."layer" in ('core', 'persona', 'app', 'user'))),
	CONSTRAINT "memories_uri_by_form" CHECK (("memories"."form" = 'curated') = ("memories"."domain" is not null and "memories"."path" is not null)),
	CONSTRAINT "memories_domain_by_layer" CHECK ("memories"."domain" is null or "memories"."domain" = "memories"."layer"::text),
	CONSTRAINT "memories_title_by_form" CHECK (("memories"."form" = 'curated') = ("memories"."title" is not null)),
	CONSTRAINT "memories_secret_encrypted" CHECK (case when "memories"."sensitivity" = 'secret'
        then "memories"."content" is null and "memories"."ciphertext" is not null and "memories"."wrapped_key" is not null
        else "memories"."content" is not null and "memories"."ciphertext" is null and "memories"."wrapped_key" is null end),
	CONSTRAINT "memories_owner_by_layer" CHECK (case "memories"."layer" when 'user' then "memories"."owner_account_id" is not null
          when 'episode' then true
          else "memories"."owner_account_id" is null end
        and ("memories"."layer" = 'persona') = ("memories"."persona_id" is not null)
        and ("memories"."layer" = 'app') = ("memories"."app_id" is not null)
        and ("memories"."layer" = 'subject') = ("memories"."subject_id" is not null)),
	CONSTRAINT "memories_conversation_by_layer" CHECK ("memories"."conversation_id" is null or "memories"."layer" in ('subject', 'episode')),
	CONSTRAINT "memories_user_not_public" CHECK ("memories"."layer" <> 'user' or "memories"."sensitivity" <> 'public'),
	CONSTRAINT "memories_untrusted_layers" CHECK ("memories"."provenance" <> 'untrusted' or "memories"."layer" in ('subject', 'episode')),
	CONSTRAINT "memories_priority_nonneg" CHECK ("memories"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "memory_credential_refs" (
	"space_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	CONSTRAINT "memory_credential_refs_memory_id_identifier_pk" PRIMARY KEY("memory_id","identifier")
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"space_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_embeddings_memory_id_model_pk" PRIMARY KEY("memory_id","model")
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
CREATE TABLE "memory_recall_stats" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"count" integer NOT NULL,
	"last_recalled_at" timestamp with time zone NOT NULL
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
CREATE TABLE "recall_event_hits" (
	"event_id" bigint NOT NULL,
	"space_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"score" real NOT NULL,
	"via" text[] NOT NULL,
	CONSTRAINT "recall_event_hits_event_id_memory_id_pk" PRIMARY KEY("event_id","memory_id")
);
--> statement-breakpoint
CREATE TABLE "recall_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"key_id" uuid,
	"owner_account_id" uuid NOT NULL,
	"source" text NOT NULL,
	"query" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"space_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"dream_private" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_space_id_account_id_pk" PRIMARY KEY("space_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"extraction_monthly_tokens" integer DEFAULT 2000000 NOT NULL,
	"extraction_daily_writes" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_bind_attempts" (
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subject_bind_attempts_app_id_key_pk" PRIMARY KEY("app_id","key")
);
--> statement-breakpoint
CREATE TABLE "subject_bind_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"previewed_by" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subject_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"from_subject_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"issued_platform" text NOT NULL,
	"issued_external_id" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"account_id" uuid,
	"decided_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	CONSTRAINT "subject_bindings_status" CHECK ("subject_bindings"."status" in ('pending', 'merged', 'confirmed', 'rejected', 'cancelled')
        and ("subject_bindings"."status" = 'pending') = ("subject_bindings"."decided_at" is null)
        and ("subject_bindings"."status" <> 'pending' or "subject_bindings"."expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "subject_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" "subject_kind" NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"kind" "subject_kind" NOT NULL,
	"display_name" text NOT NULL,
	"name_locked" boolean DEFAULT false NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_spaceId_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "subjects_spaceId_id_kind_unique" UNIQUE("space_id","id","kind")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_group_personas" ADD CONSTRAINT "app_group_personas_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_group_personas" ADD CONSTRAINT "app_group_personas_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_group_personas" ADD CONSTRAINT "app_group_personas_space_id_subject_id_subjects_space_id_id_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_group_personas" ADD CONSTRAINT "app_group_personas_space_id_persona_id_personas_space_id_id_fk" FOREIGN KEY ("space_id","persona_id") REFERENCES "public"."personas"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_default_persona_id_personas_id_fk" FOREIGN KEY ("default_persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_group_fk" FOREIGN KEY ("space_id","group_subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_sender_fk" FOREIGN KEY ("space_id","sender_subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_space_id_subject_id_subjects_space_id_id_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_credential_fk" FOREIGN KEY ("space_id","credential_id") REFERENCES "public"."credentials"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_providers" ADD CONSTRAINT "credential_providers_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_providers" ADD CONSTRAINT "credential_providers_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_provider_fk" FOREIGN KEY ("space_id","owner_account_id","provider_id") REFERENCES "public"."credential_providers"("space_id","owner_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_marks" ADD CONSTRAINT "dream_marks_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_marks" ADD CONSTRAINT "dream_marks_memory_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_runs" ADD CONSTRAINT "dream_runs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_runs" ADD CONSTRAINT "dream_runs_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_persona_id_personas_space_id_id_fk" FOREIGN KEY ("space_id","persona_id") REFERENCES "public"."personas"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_subject_id_subjects_space_id_id_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 删掉会话时只把 conversation_id 置空、space_id 不动（drizzle 生成的 SET NULL 不带列名，会把两列都置空）。
-- 会话摘要在会话删掉之前就由下面的触发器删掉了，这里只剩在这个会话里听到的联系人事实
ALTER TABLE "memories" ADD CONSTRAINT "memories_conversation_fk" FOREIGN KEY ("space_id","conversation_id") REFERENCES "public"."conversations"("space_id","id") ON DELETE SET NULL ("conversation_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_credential_refs" ADD CONSTRAINT "memory_credential_refs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_credential_refs" ADD CONSTRAINT "memory_credential_refs_memory_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_space_id_memory_id_memories_space_id_id_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_glossary" ADD CONSTRAINT "memory_glossary_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_glossary" ADD CONSTRAINT "memory_glossary_space_id_memory_id_memories_space_id_id_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_recall_stats" ADD CONSTRAINT "memory_recall_stats_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_recall_stats" ADD CONSTRAINT "memory_recall_stats_memory_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_extends_id_personas_id_fk" FOREIGN KEY ("extends_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_event_hits" ADD CONSTRAINT "recall_event_hits_event_id_recall_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."recall_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_event_hits" ADD CONSTRAINT "recall_event_hits_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_event_hits" ADD CONSTRAINT "recall_event_hits_memory_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_events" ADD CONSTRAINT "recall_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_events" ADD CONSTRAINT "recall_events_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_attempts" ADD CONSTRAINT "subject_bind_attempts_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_attempts" ADD CONSTRAINT "subject_bind_attempts_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_codes" ADD CONSTRAINT "subject_bind_codes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_codes" ADD CONSTRAINT "subject_bind_codes_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_codes" ADD CONSTRAINT "subject_bind_codes_subject_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_subject_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_from_subject_fk" FOREIGN KEY ("space_id","from_subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_identities" ADD CONSTRAINT "subject_identities_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_identities" ADD CONSTRAINT "subject_identities_subject_fk" FOREIGN KEY ("space_id","subject_id","kind") REFERENCES "public"."subjects"("space_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_space_id_index" ON "api_keys" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "app_group_personas_persona_id_index" ON "app_group_personas" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "app_group_personas_subject_id_index" ON "app_group_personas" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_space_id_slug_index" ON "apps" USING btree ("space_id","slug");--> statement-breakpoint
CREATE INDEX "conversation_turns_app_id_scope_id_index" ON "conversation_turns" USING btree ("app_id","scope","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_subject_idx" ON "conversations" USING btree ("app_id","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_owner_idx" ON "conversations" USING btree ("app_id","owner_account_id");--> statement-breakpoint
CREATE INDEX "conversations_space_id_last_active_at_index" ON "conversations" USING btree ("space_id","last_active_at");--> statement-breakpoint
CREATE INDEX "conversations_subject_id_index" ON "conversations" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "credential_events_credential_id_id_index" ON "credential_events" USING btree ("credential_id","id");--> statement-breakpoint
CREATE INDEX "credential_providers_space_id_owner_account_id_index" ON "credential_providers" USING btree ("space_id","owner_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_identifier_live_idx" ON "credentials" USING btree ("space_id","owner_account_id","identifier") WHERE "credentials"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "credentials_provider_live_idx" ON "credentials" USING btree ("provider_id") WHERE "credentials"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "credentials_key_id_idx" ON "credentials" USING btree ("space_id","key_id") WHERE "credentials"."wrapped_key" is not null;--> statement-breakpoint
CREATE INDEX "dream_runs_space_id_created_at_index" ON "dream_runs" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dream_suggestions_fingerprint_idx" ON "dream_suggestions" USING btree ("space_id","fingerprint");--> statement-breakpoint
CREATE INDEX "dream_suggestions_space_id_status_created_at_index" ON "dream_suggestions" USING btree ("space_id","status","created_at");--> statement-breakpoint
CREATE INDEX "extraction_runs_space_id_created_at_index" ON "extraction_runs" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "extraction_runs_subject_ids_index" ON "extraction_runs" USING gin ("subject_ids");--> statement-breakpoint
CREATE INDEX "login_attempts_reset_at_index" ON "login_attempts" USING btree ("reset_at");--> statement-breakpoint
CREATE INDEX "memories_fts_idx" ON "memories" USING gin ("fts");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_uri_live_idx" ON "memories" USING btree ("space_id","domain","path",coalesce("owner_account_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "memories"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "memories_space_id_layer_index" ON "memories" USING btree ("space_id","layer");--> statement-breakpoint
CREATE INDEX "memories_subject_id_index" ON "memories" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "memories_conversation_idx" ON "memories" USING btree ("conversation_id") WHERE "memories"."conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "memories_key_id_idx" ON "memories" USING btree ("space_id","key_id") WHERE "memories"."wrapped_key" is not null;--> statement-breakpoint
CREATE INDEX "memory_credential_refs_space_id_identifier_index" ON "memory_credential_refs" USING btree ("space_id","identifier");--> statement-breakpoint
CREATE INDEX "memory_embeddings_hnsw_idx" ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_events_space_id_created_at_index" ON "memory_events" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_events_memory_id_created_at_index" ON "memory_events" USING btree ("memory_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_glossary_space_id_keyword_index" ON "memory_glossary" USING btree ("space_id","keyword");--> statement-breakpoint
CREATE UNIQUE INDEX "personas_space_id_slug_index" ON "personas" USING btree ("space_id","slug");--> statement-breakpoint
CREATE INDEX "recall_event_hits_space_id_memory_id_index" ON "recall_event_hits" USING btree ("space_id","memory_id");--> statement-breakpoint
CREATE INDEX "recall_events_space_id_created_at_index" ON "recall_events" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "recall_events_app_id_created_at_index" ON "recall_events" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "recall_events_space_id_owner_account_id_app_id_id_index" ON "recall_events" USING btree ("space_id","owner_account_id","app_id","id");--> statement-breakpoint
CREATE INDEX "sessions_account_id_index" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "subject_bind_attempts_reset_at_index" ON "subject_bind_attempts" USING btree ("reset_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_bind_codes_app_id_code_hash_index" ON "subject_bind_codes" USING btree ("app_id","code_hash");--> statement-breakpoint
CREATE INDEX "subject_bind_codes_subject_id_index" ON "subject_bind_codes" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subject_bind_codes_expires_at_index" ON "subject_bind_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "subject_bindings_subject_id_index" ON "subject_bindings" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subject_bindings_from_subject_id_index" ON "subject_bindings" USING btree ("from_subject_id");--> statement-breakpoint
CREATE INDEX "subject_bindings_account_id_index" ON "subject_bindings" USING btree ("account_id") WHERE "subject_bindings"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "subject_identities_space_id_platform_kind_external_id_index" ON "subject_identities" USING btree ("space_id","platform","kind","external_id");--> statement-breakpoint
CREATE INDEX "subject_identities_subject_id_index" ON "subject_identities" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subjects_space_id_created_at_id_index" ON "subjects" USING btree ("space_id","created_at","id");--> statement-breakpoint
-- 内容表的行级安全：每个事务用 set_config('app.space_id', ..., true) 声明当前空间。
-- 没设置时 nullif 得到 NULL，比较结果为假，查询返回空集、写入被拒，默认关闭而不是默认放行。
-- FORCE 让表的属主（应用角色本身）也受策略约束；超级用户和 BYPASSRLS 角色仍会绕过，服务启动时拒绝这两种角色。
-- 清单与 src/db/schema.ts 的 RLS_TABLES 相同，rls.int.test.ts 核对两边一致
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'personas', 'apps', 'subjects', 'subject_identities', 'app_group_personas', 'conversations',
    'memories', 'memory_embeddings', 'memory_glossary', 'memory_events',
    'credential_providers', 'credentials', 'credential_events', 'memory_credential_refs',
    'recall_events', 'recall_event_hits', 'memory_recall_stats', 'conversation_turns', 'extraction_runs',
    'subject_bind_codes', 'subject_bindings', 'subject_bind_attempts',
    'dream_runs', 'dream_suggestions', 'dream_marks'
  ]
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
-- 删掉会话时，挂在它上面的会话摘要跟着删；在这里听到的联系人事实留着，由外键 memories_conversation_fk 只断开关联。
-- 外键的动作在会话那一行删掉之后才执行、找不到摘要了，所以摘要在删除之前删。应用、联系人或成员删掉、
-- 级联删除会话时同样经过这里
CREATE FUNCTION conversations_delete_summaries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM memories
  WHERE space_id = OLD.space_id AND conversation_id = OLD.id AND layer = 'episode';
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER conversations_delete_summaries
  BEFORE DELETE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_delete_summaries();
--> statement-breakpoint
-- 开始记录召回事件的时间：之前的记忆没机会被记下召回，召回分析要等记录满保留天数之后才把它们算作「从没被召回」
INSERT INTO settings (key, value) VALUES ('recall-started', to_jsonb(now()));
