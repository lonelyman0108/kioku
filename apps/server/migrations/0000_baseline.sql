-- 迁移基线：表、约束与索引由 drizzle-kit 按 src/db/schema.ts 生成，补充中文全文检索配置。
CREATE TEXT SEARCH CONFIGURATION kioku_zh (PARSER = zhparser);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION kioku_zh ADD MAPPING FOR n, v, a, i, e, l, j WITH simple;
--> statement-breakpoint
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
	"name" text NOT NULL,
	"runtime_family" text DEFAULT 'generic' NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"envs" text[] DEFAULT '{}' NOT NULL,
	"allowed_realms" text[],
	"can_write" boolean DEFAULT true NOT NULL,
	"can_resolve_credentials" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"allowed_realms" text[],
	"ciphertext" "bytea" NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_slug_unique" UNIQUE("slug"),
	CONSTRAINT "credentials_slug_format" CHECK ("credentials"."slug" ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
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
	"selections" jsonb,
	"key_name" text,
	"envs" text[],
	"allowed_realms" text[],
	"can_write" boolean,
	"can_resolve_credentials" boolean,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	CONSTRAINT "device_grants_deviceHash_unique" UNIQUE("device_hash"),
	CONSTRAINT "device_grants_userHash_unique" UNIQUE("user_hash"),
	CONSTRAINT "device_grants_status_check" CHECK ("device_grants"."status" in ('pending', 'approved', 'denied')),
	CONSTRAINT "device_grants_platforms_shape" CHECK (("device_grants"."runtime_family" is null) <> ("device_grants"."platforms" is null))
);
--> statement-breakpoint
CREATE TABLE "dream_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"entry_ids" uuid[] NOT NULL,
	"entry_versions" integer[] NOT NULL,
	"keep_id" uuid,
	"proposed_title" text,
	"proposed_content" text,
	"proposed_disclosure" text,
	"proposed_topics" text[],
	"proposed_envs" text[],
	"proposed_realms" text[],
	"proposed_projects" text[],
	"proposed_runtimes" text[],
	"reason" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "dream_suggestions_fingerprint_unique" UNIQUE("fingerprint"),
	CONSTRAINT "dream_suggestions_kind_check" CHECK ("dream_suggestions"."kind" in ('distill_episode', 'merge_duplicates', 'mark_stale', 'update')),
	CONSTRAINT "dream_suggestions_status_check" CHECK ("dream_suggestions"."status" in ('pending', 'applied', 'rejected')),
	CONSTRAINT "dream_suggestions_entries_check" CHECK (cardinality("dream_suggestions"."entry_ids") >= 1 and cardinality("dream_suggestions"."entry_ids") = cardinality("dream_suggestions"."entry_versions"))
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" text NOT NULL,
	"kind" text DEFAULT 'entry' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"disclosure" text,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"envs" text[] DEFAULT '{}' NOT NULL,
	"realms" text[] DEFAULT '{}' NOT NULL,
	"projects" text[] DEFAULT '{}' NOT NULL,
	"runtimes" text[] DEFAULT '{}' NOT NULL,
	"topics" text[] DEFAULT '{}' NOT NULL,
	"device_key" text,
	"project_slug" text,
	"search_tags" text DEFAULT '' NOT NULL,
	"valid_to" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"dream_checked_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('kioku_zh'::regconfig, coalesce(title, '') || ' ' || coalesce(disclosure, '') || ' ' || coalesce(search_tags, '') || ' ' || content)) STORED,
	CONSTRAINT "entries_shortId_unique" UNIQUE("short_id"),
	CONSTRAINT "entries_short_id_format" CHECK ("entries"."short_id" ~ '^m-[2-9a-hjkmnp-tv-z]{6,8}$'),
	CONSTRAINT "entries_kind_check" CHECK ("entries"."kind" in ('entry', 'episode')),
	CONSTRAINT "entries_episode_not_pinned" CHECK ("entries"."kind" <> 'episode' or not "entries"."is_pinned"),
	CONSTRAINT "entries_version_positive" CHECK ("entries"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "entry_embeddings" (
	"entry_id" uuid NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_embeddings_entry_id_model_pk" PRIMARY KEY("entry_id","model")
);
--> statement-breakpoint
CREATE TABLE "entry_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_events_type_check" CHECK ("entry_events"."event_type" in ('create', 'update', 'delete', 'undelete', 'restore'))
);
--> statement-breakpoint
CREATE TABLE "entry_links" (
	"source_entry_id" uuid NOT NULL,
	"target_short_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_links_source_entry_id_target_short_id_pk" PRIMARY KEY("source_entry_id","target_short_id"),
	CONSTRAINT "entry_links_target_format" CHECK ("entry_links"."target_short_id" ~ '^m-[2-9a-hjkmnp-tv-z]{6,8}$')
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
CREATE TABLE "turn_buffer" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_id" uuid NOT NULL,
	"device_key" text DEFAULT '' NOT NULL,
	"project_slug" text DEFAULT '' NOT NULL,
	"session_id" text NOT NULL,
	"user_text" text NOT NULL,
	"reply_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_embeddings" ADD CONSTRAINT "entry_embeddings_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_events" ADD CONSTRAINT "entry_events_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_source_entry_id_entries_id_fk" FOREIGN KEY ("source_entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_buffer" ADD CONSTRAINT "turn_buffer_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credentials_key_id_idx" ON "credentials" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "device_grants_expires_idx" ON "device_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "device_grants_client_key_idx" ON "device_grants" USING btree ("client_key");--> statement-breakpoint
CREATE INDEX "dream_suggestions_status_idx" ON "dream_suggestions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "entries_fts_idx" ON "entries" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "entries_realms_gin_idx" ON "entries" USING gin ("realms");--> statement-breakpoint
CREATE INDEX "entries_projects_gin_idx" ON "entries" USING gin ("projects");--> statement-breakpoint
CREATE INDEX "entries_topics_gin_idx" ON "entries" USING gin ("topics");--> statement-breakpoint
CREATE INDEX "entries_episodes_scope_idx" ON "entries" USING btree ("device_key","project_slug","created_at") WHERE "entries"."kind" = 'episode' and "entries"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "entries_pinned_active_idx" ON "entries" USING btree ("created_at","short_id") WHERE "entries"."is_pinned" = true and "entries"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "entries_deleted_idx" ON "entries" USING btree ("deleted_at") WHERE "entries"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "entry_embeddings_hnsw_idx" ON "entry_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "entry_events_entry_idx" ON "entry_events" USING btree ("entry_id","id");--> statement-breakpoint
CREATE INDEX "entry_links_target_idx" ON "entry_links" USING btree ("target_short_id");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "turn_buffer_scope_idx" ON "turn_buffer" USING btree ("device_key","project_slug","id");