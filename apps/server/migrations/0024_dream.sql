CREATE TABLE "dream_cursors" (
	"space_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"owner_account_id" uuid,
	"at" timestamp with time zone NOT NULL,
	"last_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dream_cursors_space_id_scope_pk" PRIMARY KEY("space_id","scope")
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
ALTER TABLE "dream_cursors" ADD CONSTRAINT "dream_cursors_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_cursors" ADD CONSTRAINT "dream_cursors_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_runs" ADD CONSTRAINT "dream_runs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_runs" ADD CONSTRAINT "dream_runs_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dream_runs_space_id_created_at_index" ON "dream_runs" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dream_suggestions_fingerprint_idx" ON "dream_suggestions" USING btree ("space_id","fingerprint");--> statement-breakpoint
CREATE INDEX "dream_suggestions_space_id_status_created_at_index" ON "dream_suggestions" USING btree ("space_id","status","created_at");--> statement-breakpoint
-- 与其他内容表一样按 app.space_id 强制隔离
ALTER TABLE dream_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dream_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON dream_runs
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE dream_suggestions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dream_suggestions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON dream_suggestions
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE dream_cursors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dream_cursors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON dream_cursors
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);