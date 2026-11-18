-- 迁移基线：表、类型、约束与索引由 drizzle-kit 按 src/db/schema.ts 生成，
-- 补充中文全文检索配置、列名级 ON DELETE SET NULL 外键、延迟外键、读写分权 RLS 策略、触发器与默认设置。
CREATE TEXT SEARCH CONFIGURATION kioku_zh (PARSER = zhparser);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION kioku_zh ADD MAPPING FOR n, v, a, i, e, l, j WITH simple;
--> statement-breakpoint
CREATE TYPE "public"."account_link_purpose" AS ENUM('setup', 'reset');--> statement-breakpoint
CREATE TYPE "public"."circle_kind" AS ENUM('personal', 'shared');--> statement-breakpoint
CREATE TYPE "public"."conversation_kind" AS ENUM('group', 'direct', 'channel', 'none');--> statement-breakpoint
CREATE TYPE "public"."credential_source" AS ENUM('hosted', 'vault');--> statement-breakpoint
CREATE TYPE "public"."entry_kind" AS ENUM('entry', 'fact', 'episode');--> statement-breakpoint
CREATE TYPE "public"."facet_match_mode" AS ENUM('exclusive', 'additive');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('owner', 'agent', 'untrusted', 'system');--> statement-breakpoint
CREATE TYPE "public"."sensitivity" AS ENUM('public', 'internal', 'private', 'secret');--> statement-breakpoint
CREATE TYPE "public"."subject_kind" AS ENUM('person', 'group');--> statement-breakpoint
CREATE TYPE "public"."vault_connection_status" AS ENUM('ok', 'reauth_required', 'disabled', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."vault_disabled_reason" AS ENUM('personal_items', 'organization_role');--> statement-breakpoint
CREATE TYPE "public"."vault_error_kind" AS ENUM('invalid_credentials', 'two_factor_invalid', 'unsupported_two_factor', 'reauth_required', 'item_unavailable', 'read_only', 'item_conflict', 'value_too_long', 'unsupported_format', 'integrity', 'unreachable', 'server_error');--> statement-breakpoint
CREATE TABLE "account_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" "account_link_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "account_links_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"linked_circles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_facets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"persona_override_id" uuid,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "circle_departures" (
	"circle_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"left_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dream_private" boolean NOT NULL,
	"purge_started_at" timestamp with time zone,
	CONSTRAINT "circle_departures_circle_id_account_id_pk" PRIMARY KEY("circle_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "circle_members" (
	"circle_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"dream_private" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circle_members_circle_id_account_id_pk" PRIMARY KEY("circle_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "circles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "circle_kind" NOT NULL,
	"owner_account_id" uuid,
	"default_facets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extraction_monthly_tokens" integer DEFAULT 2000000 NOT NULL,
	"extraction_daily_writes" integer DEFAULT 20 NOT NULL,
	"advanced" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"privacy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"privacy_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circles_slug_unique" UNIQUE("slug"),
	CONSTRAINT "circles_id_kind_unique" UNIQUE("id","kind"),
	CONSTRAINT "circles_owner_by_kind" CHECK (("circles"."kind" = 'personal') = ("circles"."owner_account_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "client_group_rules" (
	"circle_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"group_subject_id" uuid NOT NULL,
	"persona_id" uuid,
	"isolate_group_memory" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_group_rules_client_id_group_subject_id_pk" PRIMARY KEY("client_id","group_subject_id")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"runtime_family" text NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"default_persona_id" uuid,
	"config" jsonb DEFAULT '{"personMemoryMode":"strict"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_circle_id_unique" UNIQUE("circle_id","id")
);
--> statement-breakpoint
CREATE TABLE "conversation_turns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"circle_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
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
	"circle_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "conversation_kind" NOT NULL,
	"device_key" text DEFAULT '' NOT NULL,
	"project_slug" text DEFAULT '' NOT NULL,
	"subject_id" uuid,
	"owner_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_circle_id_unique" UNIQUE("circle_id","id"),
	CONSTRAINT "conversations_kind_shape" CHECK (case when "conversations"."kind" = 'none'
        then "conversations"."subject_id" is null and "conversations"."owner_account_id" is not null
        else "conversations"."subject_id" is not null and "conversations"."owner_account_id" is null and "conversations"."device_key" = '' and "conversations"."project_slug" = '' end)
);
--> statement-breakpoint
CREATE TABLE "credential_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"circle_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_key_id" uuid,
	"actor_account_id" uuid,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
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
	"client_ids" uuid[],
	"allowed_realms" text[],
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"rotation_requested_at" timestamp with time zone,
	"value_version" integer DEFAULT 1 NOT NULL,
	"value_changed_at" timestamp with time zone,
	"vault_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credentials_circle_id_unique" UNIQUE("circle_id","id"),
	CONSTRAINT "credentials_source_shape" CHECK (case when "credentials"."source" = 'hosted'
        then "credentials"."ciphertext" is not null and "credentials"."wrapped_key" is not null and "credentials"."vault_connection_id" is null and "credentials"."vault_item_id" is null
        else "credentials"."ciphertext" is null and "credentials"."wrapped_key" is null and "credentials"."vault_connection_id" is not null and "credentials"."vault_item_id" is not null end)
);
--> statement-breakpoint
CREATE TABLE "device_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_hash" text NOT NULL,
	"user_hash" text NOT NULL,
	"runtime_family" text,
	"platforms" jsonb,
	"client_name" text,
	"client_address" text,
	"client_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"selections" jsonb,
	"approved_at" timestamp with time zone,
	"circle_id" uuid,
	"client_id" uuid,
	"linked_circles" jsonb,
	"context_facets" jsonb,
	"key_name" text,
	"scopes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	CONSTRAINT "device_grants_deviceHash_unique" UNIQUE("device_hash"),
	CONSTRAINT "device_grants_userHash_unique" UNIQUE("user_hash"),
	CONSTRAINT "device_grants_platforms_shape" CHECK (("device_grants"."runtime_family" is null) <> ("device_grants"."platforms" is null))
);
--> statement-breakpoint
CREATE TABLE "dream_marks" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"circle_id" uuid NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dream_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"circle_id" uuid NOT NULL,
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
	"circle_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"owner_account_id" uuid,
	"kind" text NOT NULL,
	"entry_ids" uuid[] NOT NULL,
	"versions" integer[] NOT NULL,
	"keep_id" uuid,
	"title" text,
	"content" text,
	"variants" jsonb,
	"when" jsonb,
	"topics" text[],
	"disclosure" text,
	"verdict" text,
	"target_priority" integer,
	"reason" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dream_suggestions_kind" CHECK ("dream_suggestions"."kind" in ('merge', 'merge_variants', 'facet_tag', 'generalize', 'distill', 'distill_episode', 'stale', 'review', 'promote')),
	CONSTRAINT "dream_suggestions_status" CHECK ("dream_suggestions"."status" in ('pending', 'applied', 'rejected')),
	CONSTRAINT "dream_suggestions_entries" CHECK (cardinality("dream_suggestions"."entry_ids") >= 1 and cardinality("dream_suggestions"."entry_ids") = cardinality("dream_suggestions"."versions"))
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
	"circle_kind" "circle_kind" NOT NULL,
	"short_id" text NOT NULL,
	"kind" "entry_kind" NOT NULL,
	"title" text NOT NULL,
	"sensitivity" "sensitivity" NOT NULL,
	"provenance" "provenance" NOT NULL,
	"origin_scope" text DEFAULT 'global' NOT NULL,
	"client_id" uuid,
	"owner_account_id" uuid,
	"subject_id" uuid,
	"subject_kind" "subject_kind",
	"conversation_id" uuid,
	"realms" text[] DEFAULT '{}' NOT NULL,
	"topics" text[] DEFAULT '{}' NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"disclosure" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "entries_short_id_unique" UNIQUE("short_id"),
	CONSTRAINT "entries_circle_id_unique" UNIQUE("circle_id","id"),
	CONSTRAINT "entries_circle_id_sens_kind_unique" UNIQUE("circle_id","id","sensitivity","kind"),
	CONSTRAINT "entries_short_id_format" CHECK ("entries"."short_id" ~ '^m-[2-9a-hjkmnp-tv-z]{6,8}$'),
	CONSTRAINT "entries_subject_kind_pair" CHECK (("entries"."subject_id" is null) = ("entries"."subject_kind" is null)),
	CONSTRAINT "entries_shape_by_kind" CHECK (case "entries"."kind"
        when 'entry' then (("entries"."circle_kind" = 'personal' and "entries"."owner_account_id" is not null)
          or ("entries"."circle_kind" = 'shared' and "entries"."owner_account_id" is null))
          and "entries"."subject_id" is null and "entries"."subject_kind" is null and "entries"."conversation_id" is null
        when 'fact' then "entries"."subject_id" is not null and "entries"."subject_kind" is not null
          and "entries"."owner_account_id" is null
        when 'episode' then "entries"."conversation_id" is not null
          and "entries"."subject_id" is null and "entries"."subject_kind" is null
        else false end),
	CONSTRAINT "entries_untrusted_kinds" CHECK ("entries"."provenance" <> 'untrusted' or "entries"."kind" in ('fact', 'episode')),
	CONSTRAINT "entries_episode_not_secret" CHECK ("entries"."kind" <> 'episode' or "entries"."sensitivity" <> 'secret'),
	CONSTRAINT "entries_episode_priority" CHECK ("entries"."kind" <> 'episode' or "entries"."priority" >= 1),
	CONSTRAINT "entries_priority_nonneg" CHECK ("entries"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "entry_credential_refs" (
	"circle_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	CONSTRAINT "entry_credential_refs_entry_id_identifier_pk" PRIMARY KEY("entry_id","identifier")
);
--> statement-breakpoint
CREATE TABLE "entry_embeddings" (
	"circle_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_embeddings_variant_id_model_pk" PRIMARY KEY("variant_id","model")
);
--> statement-breakpoint
CREATE TABLE "entry_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"circle_id" uuid NOT NULL,
	"entry_id" uuid,
	"short_id" text NOT NULL,
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
CREATE TABLE "entry_glossary" (
	"circle_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"keyword" text NOT NULL,
	CONSTRAINT "entry_glossary_entry_id_keyword_pk" PRIMARY KEY("entry_id","keyword")
);
--> statement-breakpoint
CREATE TABLE "entry_links" (
	"circle_id" uuid NOT NULL,
	"source_variant_id" uuid NOT NULL,
	"source_entry_id" uuid NOT NULL,
	"target_short_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_links_source_variant_id_target_short_id_pk" PRIMARY KEY("source_variant_id","target_short_id"),
	CONSTRAINT "entry_links_target_format" CHECK ("entry_links"."target_short_id" ~ '^m-[2-9a-hjkmnp-tv-z]{6,8}$')
);
--> statement-breakpoint
CREATE TABLE "entry_recall_stats" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"circle_id" uuid NOT NULL,
	"count" integer NOT NULL,
	"last_recalled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"sensitivity" "sensitivity" NOT NULL,
	"kind" "entry_kind" NOT NULL,
	"when" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"when_signature" text DEFAULT '{}' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"search_header" text DEFAULT '' NOT NULL,
	"content" text,
	"ciphertext" "bytea",
	"wrapped_key" "bytea",
	"key_id" text,
	"plaintext_ignored_hash" text,
	"sensitive_revision" integer DEFAULT 0 NOT NULL,
	"sensitive_credential" boolean DEFAULT false NOT NULL,
	"sensitive_pii" boolean DEFAULT false NOT NULL,
	"sensitive_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('kioku_zh'::regconfig, coalesce(search_header, '') || ' ' || coalesce(content, ''))) STORED,
	CONSTRAINT "entry_variants_circle_id_unique" UNIQUE("circle_id","id"),
	CONSTRAINT "entry_variants_secret_encrypted" CHECK (case when "entry_variants"."sensitivity" = 'secret'
        then "entry_variants"."content" is null and "entry_variants"."search_header" = '' and "entry_variants"."ciphertext" is not null and "entry_variants"."wrapped_key" is not null
        else "entry_variants"."content" is not null and "entry_variants"."ciphertext" is null and "entry_variants"."wrapped_key" is null end),
	CONSTRAINT "entry_variants_episode_unconditional" CHECK ("entry_variants"."kind" <> 'episode' or ("entry_variants"."when" = '{}'::jsonb and "entry_variants"."when_signature" = '{}'))
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"circle_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"conversation_id" uuid,
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
CREATE TABLE "facet_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"match_mode" "facet_match_mode" DEFAULT 'exclusive' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facet_dimensions_not_builtin" CHECK ("facet_dimensions"."key" not in ('realm', 'env', 'runtime', 'project'))
);
--> statement-breakpoint
CREATE TABLE "facet_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
	"dimension_key" text NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"implies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"auto_registered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_uris" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"legacy_uri" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_uris_source_check" CHECK ("legacy_uris"."source" in ('lore', 'kioku-legacy'))
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"username" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_traits" (
	"circle_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"trait_key" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persona_traits_persona_id_trait_key_pk" PRIMARY KEY("persona_id","trait_key")
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"extends_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_circle_id_unique" UNIQUE("circle_id","id")
);
--> statement-breakpoint
CREATE TABLE "recall_event_hits" (
	"event_id" bigint NOT NULL,
	"circle_id" uuid NOT NULL,
	"target_circle_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"short_id" text NOT NULL,
	"rank" smallint NOT NULL,
	"score" real NOT NULL,
	"via" text[] NOT NULL,
	CONSTRAINT "recall_event_hits_event_id_entry_id_pk" PRIMARY KEY("event_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "recall_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"circle_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
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
	"client_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
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
CREATE TABLE "subject_bind_attempts" (
	"circle_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subject_bind_attempts_client_id_key_pk" PRIMARY KEY("client_id","key")
);
--> statement-breakpoint
CREATE TABLE "subject_bind_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
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
	"circle_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
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
	"circle_id" uuid NOT NULL,
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
	"circle_id" uuid NOT NULL,
	"kind" "subject_kind" NOT NULL,
	"display_name" text NOT NULL,
	"name_locked" boolean DEFAULT false NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_circle_id_unique" UNIQUE("circle_id","id"),
	CONSTRAINT "subjects_circle_id_kind_unique" UNIQUE("circle_id","id","kind")
);
--> statement-breakpoint
CREATE TABLE "vault_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circle_id" uuid NOT NULL,
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
	"default_organization_id" text,
	"default_collection_name" text,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_connections_circle_owner_id_unique" UNIQUE("circle_id","owner_account_id","id"),
	CONSTRAINT "vault_connections_secrets_shape" CHECK (("vault_connections"."ciphertext" is null) = ("vault_connections"."wrapped_key" is null)
        and ("vault_connections"."ciphertext" is null) = ("vault_connections"."status" = 'disconnected')
        and ("vault_connections"."disconnected_at" is null) = ("vault_connections"."status" <> 'disconnected')),
	CONSTRAINT "vault_connections_disabled_reason" CHECK (("vault_connections"."disabled_reason" is null) = ("vault_connections"."status" <> 'disabled')),
	CONSTRAINT "vault_connections_last_error" CHECK (("vault_connections"."last_error_kind" is null) = ("vault_connections"."last_error_at" is null)),
	CONSTRAINT "vault_connections_destination_shape" CHECK (("vault_connections"."default_collection_id" is null) = ("vault_connections"."default_organization_id" is null)
        and ("vault_connections"."default_collection_id" is null) = ("vault_connections"."default_collection_name" is null))
);
--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_persona_override_id_personas_id_fk" FOREIGN KEY ("persona_override_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle_departures" ADD CONSTRAINT "circle_departures_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle_departures" ADD CONSTRAINT "circle_departures_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle_members" ADD CONSTRAINT "circle_members_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle_members" ADD CONSTRAINT "circle_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circles" ADD CONSTRAINT "circles_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_group_rules" ADD CONSTRAINT "client_group_rules_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_group_rules" ADD CONSTRAINT "client_group_rules_client_fk" FOREIGN KEY ("circle_id","client_id") REFERENCES "public"."clients"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_group_rules" ADD CONSTRAINT "client_group_rules_subject_fk" FOREIGN KEY ("circle_id","group_subject_id") REFERENCES "public"."subjects"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_group_rules" ADD CONSTRAINT "client_group_rules_persona_fk" FOREIGN KEY ("circle_id","persona_id") REFERENCES "public"."personas"("circle_id","id") ON DELETE SET NULL ("persona_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_default_persona_fk" FOREIGN KEY ("circle_id","default_persona_id") REFERENCES "public"."personas"("circle_id","id") ON DELETE SET NULL ("default_persona_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_client_fk" FOREIGN KEY ("circle_id","client_id") REFERENCES "public"."clients"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_group_fk" FOREIGN KEY ("circle_id","group_subject_id") REFERENCES "public"."subjects"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_sender_fk" FOREIGN KEY ("circle_id","sender_subject_id") REFERENCES "public"."subjects"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_fk" FOREIGN KEY ("circle_id","client_id") REFERENCES "public"."clients"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_subject_fk" FOREIGN KEY ("circle_id","subject_id") REFERENCES "public"."subjects"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_events" ADD CONSTRAINT "credential_events_credential_fk" FOREIGN KEY ("circle_id","credential_id") REFERENCES "public"."credentials"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_vault_connection_fk" FOREIGN KEY ("circle_id","owner_account_id","vault_connection_id") REFERENCES "public"."vault_connections"("circle_id","owner_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_approved_by_accounts_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_circle_client_fk" FOREIGN KEY ("circle_id","client_id") REFERENCES "public"."clients"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_marks" ADD CONSTRAINT "dream_marks_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_marks" ADD CONSTRAINT "dream_marks_entry_fk" FOREIGN KEY ("circle_id","entry_id") REFERENCES "public"."entries"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_runs" ADD CONSTRAINT "dream_runs_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_runs" ADD CONSTRAINT "dream_runs_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_circle_kind_fk" FOREIGN KEY ("circle_id","circle_kind") REFERENCES "public"."circles"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_client_fk" FOREIGN KEY ("circle_id","client_id") REFERENCES "public"."clients"("circle_id","id") ON DELETE SET NULL ("client_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_subject_fk" FOREIGN KEY ("circle_id","subject_id","subject_kind") REFERENCES "public"."subjects"("circle_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_conversation_fk" FOREIGN KEY ("circle_id","conversation_id") REFERENCES "public"."conversations"("circle_id","id") ON DELETE SET NULL ("conversation_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_credential_refs" ADD CONSTRAINT "entry_credential_refs_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_credential_refs" ADD CONSTRAINT "entry_credential_refs_entry_fk" FOREIGN KEY ("circle_id","entry_id") REFERENCES "public"."entries"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_embeddings" ADD CONSTRAINT "entry_embeddings_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_embeddings" ADD CONSTRAINT "entry_embeddings_variant_fk" FOREIGN KEY ("circle_id","variant_id") REFERENCES "public"."entry_variants"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_embeddings" ADD CONSTRAINT "entry_embeddings_entry_fk" FOREIGN KEY ("circle_id","entry_id") REFERENCES "public"."entries"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_events" ADD CONSTRAINT "entry_events_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_events" ADD CONSTRAINT "entry_events_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_glossary" ADD CONSTRAINT "entry_glossary_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_glossary" ADD CONSTRAINT "entry_glossary_entry_fk" FOREIGN KEY ("circle_id","entry_id") REFERENCES "public"."entries"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_variant_fk" FOREIGN KEY ("circle_id","source_variant_id") REFERENCES "public"."entry_variants"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_entry_fk" FOREIGN KEY ("circle_id","source_entry_id") REFERENCES "public"."entries"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_recall_stats" ADD CONSTRAINT "entry_recall_stats_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_recall_stats" ADD CONSTRAINT "entry_recall_stats_entry_fk" FOREIGN KEY ("circle_id","entry_id") REFERENCES "public"."entries"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_variants" ADD CONSTRAINT "entry_variants_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_variants" ADD CONSTRAINT "entry_variants_entry_fk" FOREIGN KEY ("circle_id","entry_id") REFERENCES "public"."entries"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_variants" ADD CONSTRAINT "entry_variants_state_fk" FOREIGN KEY ("circle_id","entry_id","sensitivity","kind") REFERENCES "public"."entries"("circle_id","id","sensitivity","kind") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_client_fk" FOREIGN KEY ("circle_id","client_id") REFERENCES "public"."clients"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_conversation_fk" FOREIGN KEY ("circle_id","conversation_id") REFERENCES "public"."conversations"("circle_id","id") ON DELETE SET NULL ("conversation_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facet_dimensions" ADD CONSTRAINT "facet_dimensions_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facet_terms" ADD CONSTRAINT "facet_terms_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_uris" ADD CONSTRAINT "legacy_uris_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_uris" ADD CONSTRAINT "legacy_uris_entry_fk" FOREIGN KEY ("circle_id","entry_id") REFERENCES "public"."entries"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_traits" ADD CONSTRAINT "persona_traits_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_traits" ADD CONSTRAINT "persona_traits_persona_fk" FOREIGN KEY ("circle_id","persona_id") REFERENCES "public"."personas"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_extends_id_personas_id_fk" FOREIGN KEY ("extends_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_event_hits" ADD CONSTRAINT "recall_event_hits_event_id_recall_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."recall_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_event_hits" ADD CONSTRAINT "recall_event_hits_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_event_hits" ADD CONSTRAINT "recall_event_hits_target_circle_id_circles_id_fk" FOREIGN KEY ("target_circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_events" ADD CONSTRAINT "recall_events_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_events" ADD CONSTRAINT "recall_events_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_attempts" ADD CONSTRAINT "subject_bind_attempts_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_attempts" ADD CONSTRAINT "subject_bind_attempts_client_fk" FOREIGN KEY ("circle_id","client_id") REFERENCES "public"."clients"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_codes" ADD CONSTRAINT "subject_bind_codes_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_codes" ADD CONSTRAINT "subject_bind_codes_client_fk" FOREIGN KEY ("circle_id","client_id") REFERENCES "public"."clients"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_codes" ADD CONSTRAINT "subject_bind_codes_subject_fk" FOREIGN KEY ("circle_id","subject_id") REFERENCES "public"."subjects"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_client_fk" FOREIGN KEY ("circle_id","client_id") REFERENCES "public"."clients"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_subject_fk" FOREIGN KEY ("circle_id","subject_id") REFERENCES "public"."subjects"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_from_subject_fk" FOREIGN KEY ("circle_id","from_subject_id") REFERENCES "public"."subjects"("circle_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_identities" ADD CONSTRAINT "subject_identities_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_identities" ADD CONSTRAINT "subject_identities_subject_fk" FOREIGN KEY ("circle_id","subject_id","kind") REFERENCES "public"."subjects"("circle_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_links_account_id_index" ON "account_links" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_links_expires_at_index" ON "account_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "api_keys_client_id_index" ON "api_keys" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "circle_departures_left_at_index" ON "circle_departures" USING btree ("left_at");--> statement-breakpoint
CREATE UNIQUE INDEX "circles_personal_owner_idx" ON "circles" USING btree ("owner_account_id") WHERE "circles"."kind" = 'personal';--> statement-breakpoint
CREATE INDEX "client_group_rules_persona_idx" ON "client_group_rules" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "client_group_rules_group_idx" ON "client_group_rules" USING btree ("group_subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_circle_slug_idx" ON "clients" USING btree ("circle_id","slug");--> statement-breakpoint
CREATE INDEX "conversation_turns_client_scope_idx" ON "conversation_turns" USING btree ("client_id","scope","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_subject_idx" ON "conversations" USING btree ("client_id","subject_id") WHERE "conversations"."kind" <> 'none';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_none_idx" ON "conversations" USING btree ("client_id","owner_account_id","device_key","project_slug") WHERE "conversations"."kind" = 'none';--> statement-breakpoint
CREATE INDEX "conversations_circle_active_idx" ON "conversations" USING btree ("circle_id","last_active_at");--> statement-breakpoint
CREATE INDEX "conversations_subject_lookup_idx" ON "conversations" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "credential_events_credential_id_id_index" ON "credential_events" USING btree ("credential_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_identifier_live_idx" ON "credentials" USING btree ("circle_id","owner_account_id","identifier") WHERE "credentials"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_vault_item_live_idx" ON "credentials" USING btree ("vault_connection_id","vault_item_id") WHERE "credentials"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "credentials_vault_connection_idx" ON "credentials" USING btree ("vault_connection_id");--> statement-breakpoint
CREATE INDEX "credentials_key_id_idx" ON "credentials" USING btree ("circle_id","key_id") WHERE "credentials"."wrapped_key" is not null;--> statement-breakpoint
CREATE INDEX "device_grants_expires_at_index" ON "device_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "device_grants_client_key_index" ON "device_grants" USING btree ("client_key");--> statement-breakpoint
CREATE INDEX "device_grants_circle_id_index" ON "device_grants" USING btree ("circle_id");--> statement-breakpoint
CREATE INDEX "dream_runs_circle_id_created_at_index" ON "dream_runs" USING btree ("circle_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dream_suggestions_fingerprint_idx" ON "dream_suggestions" USING btree ("circle_id","fingerprint");--> statement-breakpoint
CREATE INDEX "dream_suggestions_circle_id_status_created_at_index" ON "dream_suggestions" USING btree ("circle_id","status","created_at");--> statement-breakpoint
CREATE INDEX "entries_circle_kind_idx" ON "entries" USING btree ("circle_id","kind");--> statement-breakpoint
CREATE INDEX "entries_subject_idx" ON "entries" USING btree ("subject_id") WHERE "entries"."subject_id" is not null;--> statement-breakpoint
CREATE INDEX "entries_conversation_idx" ON "entries" USING btree ("conversation_id") WHERE "entries"."conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "entries_topics_gin_idx" ON "entries" USING gin ("topics");--> statement-breakpoint
CREATE INDEX "entries_realms_gin_idx" ON "entries" USING gin ("realms");--> statement-breakpoint
CREATE INDEX "entry_credential_refs_circle_id_identifier_index" ON "entry_credential_refs" USING btree ("circle_id","identifier");--> statement-breakpoint
CREATE INDEX "entry_embeddings_hnsw_idx" ON "entry_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "entry_embeddings_entry_idx" ON "entry_embeddings" USING btree ("circle_id","entry_id");--> statement-breakpoint
CREATE INDEX "entry_events_circle_id_created_at_index" ON "entry_events" USING btree ("circle_id","created_at");--> statement-breakpoint
CREATE INDEX "entry_events_entry_id_created_at_index" ON "entry_events" USING btree ("entry_id","created_at");--> statement-breakpoint
CREATE INDEX "entry_events_circle_id_short_id_created_at_index" ON "entry_events" USING btree ("circle_id","short_id","created_at");--> statement-breakpoint
CREATE INDEX "entry_glossary_circle_id_keyword_index" ON "entry_glossary" USING btree ("circle_id","keyword");--> statement-breakpoint
CREATE INDEX "entry_links_target_idx" ON "entry_links" USING btree ("target_short_id");--> statement-breakpoint
CREATE INDEX "entry_links_source_entry_idx" ON "entry_links" USING btree ("circle_id","source_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_variants_entry_when_idx" ON "entry_variants" USING btree ("entry_id","when_signature");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_variants_episode_single_idx" ON "entry_variants" USING btree ("entry_id") WHERE "entry_variants"."kind" = 'episode';--> statement-breakpoint
CREATE INDEX "entry_variants_fts_idx" ON "entry_variants" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "entry_variants_key_id_idx" ON "entry_variants" USING btree ("circle_id","key_id") WHERE "entry_variants"."wrapped_key" is not null;--> statement-breakpoint
CREATE INDEX "entry_variants_sensitive_idx" ON "entry_variants" USING btree ("circle_id","sensitive_credential","sensitive_pii");--> statement-breakpoint
CREATE INDEX "extraction_runs_circle_id_created_at_index" ON "extraction_runs" USING btree ("circle_id","created_at");--> statement-breakpoint
CREATE INDEX "extraction_runs_subject_ids_index" ON "extraction_runs" USING gin ("subject_ids");--> statement-breakpoint
CREATE INDEX "extraction_runs_conversation_idx" ON "extraction_runs" USING btree ("conversation_id","created_at") WHERE "extraction_runs"."conversation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "facet_dimensions_circle_key_idx" ON "facet_dimensions" USING btree ("circle_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "facet_terms_circle_dim_slug_idx" ON "facet_terms" USING btree ("circle_id","dimension_key","slug");--> statement-breakpoint
CREATE INDEX "facet_terms_aliases_gin_idx" ON "facet_terms" USING gin ("aliases");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_uris_circle_uri_idx" ON "legacy_uris" USING btree ("circle_id","legacy_uri");--> statement-breakpoint
CREATE INDEX "legacy_uris_entry_idx" ON "legacy_uris" USING btree ("circle_id","entry_id");--> statement-breakpoint
CREATE INDEX "login_attempts_reset_at_index" ON "login_attempts" USING btree ("reset_at");--> statement-breakpoint
CREATE INDEX "persona_traits_circle_idx" ON "persona_traits" USING btree ("circle_id","persona_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "personas_circle_slug_idx" ON "personas" USING btree ("circle_id","slug");--> statement-breakpoint
CREATE INDEX "recall_event_hits_target_idx" ON "recall_event_hits" USING btree ("target_circle_id","entry_id");--> statement-breakpoint
CREATE INDEX "recall_events_circle_id_created_at_index" ON "recall_events" USING btree ("circle_id","created_at");--> statement-breakpoint
CREATE INDEX "recall_events_client_id_created_at_index" ON "recall_events" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "recall_events_circle_id_owner_account_id_client_id_id_index" ON "recall_events" USING btree ("circle_id","owner_account_id","client_id","id");--> statement-breakpoint
CREATE INDEX "sessions_account_id_index" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "subject_bind_attempts_reset_at_index" ON "subject_bind_attempts" USING btree ("reset_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_bind_codes_client_hash_idx" ON "subject_bind_codes" USING btree ("client_id","code_hash");--> statement-breakpoint
CREATE INDEX "subject_bind_codes_subject_id_index" ON "subject_bind_codes" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subject_bind_codes_expires_at_index" ON "subject_bind_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "subject_bindings_subject_id_index" ON "subject_bindings" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subject_bindings_from_subject_id_index" ON "subject_bindings" USING btree ("from_subject_id");--> statement-breakpoint
CREATE INDEX "subject_bindings_account_id_index" ON "subject_bindings" USING btree ("account_id") WHERE "subject_bindings"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "subject_identities_platform_idx" ON "subject_identities" USING btree ("circle_id","platform","kind","external_id");--> statement-breakpoint
CREATE INDEX "subject_identities_subject_idx" ON "subject_identities" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subjects_circle_created_idx" ON "subjects" USING btree ("circle_id","created_at","id");--> statement-breakpoint
CREATE INDEX "vault_connections_circle_owner_idx" ON "vault_connections" USING btree ("circle_id","owner_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_connections_account_idx" ON "vault_connections" USING btree ("circle_id","owner_account_id","server_url","vault_user_id");--> statement-breakpoint
CREATE INDEX "vault_connections_key_id_idx" ON "vault_connections" USING btree ("circle_id","key_id") WHERE "vault_connections"."wrapped_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "vault_connections_destination_idx" ON "vault_connections" USING btree ("circle_id","owner_account_id") WHERE "vault_connections"."default_collection_id" is not null;--> statement-breakpoint
-- 内容表四命令分权行级安全（清单与 src/db/schema.ts 的 RLS_TABLES 一致）
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'personas', 'persona_traits', 'clients', 'subjects', 'subject_identities',
    'client_group_rules', 'conversations', 'facet_dimensions', 'facet_terms',
    'entries', 'entry_variants', 'entry_embeddings', 'entry_links',
    'entry_glossary', 'entry_events', 'entry_credential_refs',
    'entry_recall_stats', 'legacy_uris', 'vault_connections', 'credentials',
    'credential_events', 'recall_events', 'recall_event_hits',
    'conversation_turns', 'extraction_runs', 'subject_bind_codes',
    'subject_bindings', 'subject_bind_attempts', 'dream_runs',
    'dream_suggestions', 'dream_marks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY circle_select ON %I FOR SELECT USING (circle_id = ANY(coalesce(string_to_array(nullif(current_setting(''app.read_circles'', true), ''''), '','')::uuid[], ''{}''::uuid[])))',
      t
    );
    EXECUTE format(
      'CREATE POLICY circle_insert ON %I FOR INSERT WITH CHECK (circle_id = ANY(coalesce(string_to_array(nullif(current_setting(''app.write_circles'', true), ''''), '','')::uuid[], ''{}''::uuid[])))',
      t
    );
    EXECUTE format(
      'CREATE POLICY circle_update ON %I FOR UPDATE USING (circle_id = ANY(coalesce(string_to_array(nullif(current_setting(''app.write_circles'', true), ''''), '','')::uuid[], ''{}''::uuid[]))) WITH CHECK (circle_id = ANY(coalesce(string_to_array(nullif(current_setting(''app.write_circles'', true), ''''), '','')::uuid[], ''{}''::uuid[])))',
      t
    );
    EXECUTE format(
      'CREATE POLICY circle_delete ON %I FOR DELETE USING (circle_id = ANY(coalesce(string_to_array(nullif(current_setting(''app.write_circles'', true), ''''), '','')::uuid[], ''{}''::uuid[])))',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint
-- 禁止直接删除仍存在所属账号的个人圈；删除账号时级联清理放行
CREATE FUNCTION circles_forbid_personal_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'personal' AND EXISTS (SELECT 1 FROM accounts WHERE id = OLD.owner_account_id) THEN
    RAISE EXCEPTION 'personal circle cannot be deleted directly'
      USING ERRCODE = '23514', CONSTRAINT = 'circles_personal_undeletable';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER circles_forbid_personal_delete
  BEFORE DELETE ON circles
  FOR EACH ROW EXECUTE FUNCTION circles_forbid_personal_delete();
--> statement-breakpoint
-- 删掉会话前清理挂载的会话摘要（episode），保留联系人事实并将 conversation_id 置空
CREATE FUNCTION conversations_delete_episodes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev_read text := current_setting('app.read_circles', true);
  prev_write text := current_setting('app.write_circles', true);
BEGIN
  PERFORM set_config('app.read_circles', OLD.circle_id::text, true);
  PERFORM set_config('app.write_circles', OLD.circle_id::text, true);
  DELETE FROM entries
  WHERE circle_id = OLD.circle_id AND conversation_id = OLD.id AND kind = 'episode';
  PERFORM set_config('app.read_circles', coalesce(prev_read, ''), true);
  PERFORM set_config('app.write_circles', coalesce(prev_write, ''), true);
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER conversations_delete_episodes
  BEFORE DELETE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_delete_episodes();
--> statement-breakpoint
INSERT INTO settings (key, value) VALUES ('recall-started', to_jsonb(now()));