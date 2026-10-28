CREATE TABLE "extraction_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"subject_ids" uuid[] NOT NULL,
	"turns" integer NOT NULL,
	"model" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"dropped" integer DEFAULT 0 NOT NULL,
	"summarized" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_runs_space_id_created_at_index" ON "extraction_runs" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "extraction_runs_subject_ids_index" ON "extraction_runs" USING gin ("subject_ids");--> statement-breakpoint
-- 与其他内容表一样按 app.space_id 强制隔离
ALTER TABLE extraction_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE extraction_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON extraction_runs
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
