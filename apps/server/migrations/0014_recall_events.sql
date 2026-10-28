CREATE TABLE "memory_recall_stats" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"count" integer NOT NULL,
	"last_recalled_at" timestamp with time zone NOT NULL
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
ALTER TABLE "memory_recall_stats" ADD CONSTRAINT "memory_recall_stats_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_recall_stats" ADD CONSTRAINT "memory_recall_stats_memory_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_event_hits" ADD CONSTRAINT "recall_event_hits_event_id_recall_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."recall_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_event_hits" ADD CONSTRAINT "recall_event_hits_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_event_hits" ADD CONSTRAINT "recall_event_hits_memory_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_events" ADD CONSTRAINT "recall_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_events" ADD CONSTRAINT "recall_events_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recall_event_hits_space_id_memory_id_index" ON "recall_event_hits" USING btree ("space_id","memory_id");--> statement-breakpoint
CREATE INDEX "recall_events_space_id_created_at_index" ON "recall_events" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "recall_events_app_id_created_at_index" ON "recall_events" USING btree ("app_id","created_at");--> statement-breakpoint
-- 与其他内容表一样按 app.space_id 强制隔离
ALTER TABLE recall_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recall_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON recall_events
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE recall_event_hits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recall_event_hits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON recall_event_hits
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE memory_recall_stats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memory_recall_stats FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON memory_recall_stats
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
