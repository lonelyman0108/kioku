ALTER TABLE "entries" ADD COLUMN "summary" text;
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "last_change_summary" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "entries_fts_idx";
--> statement-breakpoint
ALTER TABLE "entries" DROP COLUMN "fts";
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "fts" "tsvector" GENERATED ALWAYS AS (
	setweight(to_tsvector('kioku_zh'::regconfig, coalesce(title, '')), 'A') ||
	setweight(to_tsvector('kioku_zh'::regconfig, coalesce(summary, '') || ' ' || coalesce(disclosure, '') || ' ' || coalesce(search_tags, '')), 'B') ||
	setweight(to_tsvector('kioku_zh'::regconfig, content), 'C')
) STORED;
--> statement-breakpoint
CREATE INDEX "entries_fts_idx" ON "entries" USING gin ("fts");
--> statement-breakpoint
ALTER TABLE "entry_events" ADD COLUMN "change_summary" text;
--> statement-breakpoint
ALTER TABLE "entry_events" ADD COLUMN "diff_meta" jsonb;
--> statement-breakpoint
ALTER TABLE "entry_events" ADD COLUMN "occurred_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "entry_events" DROP CONSTRAINT "entry_events_type_check";
--> statement-breakpoint
ALTER TABLE "entry_events" ADD CONSTRAINT "entry_events_type_check" CHECK ("entry_events"."event_type" in ('create', 'update', 'delete', 'undelete', 'restore', 'archive_note'));
--> statement-breakpoint
ALTER TABLE "entry_links" ADD COLUMN "relation" text;
--> statement-breakpoint
ALTER TABLE "entry_links" ADD COLUMN "context_snippet" text;
--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD COLUMN "proposed_summary" text;
--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD COLUMN "proposed_change_summary" text;
--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD COLUMN "archived_notes" jsonb;
--> statement-breakpoint
ALTER TABLE "dream_suggestions" DROP CONSTRAINT "dream_suggestions_kind_check";
--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_kind_check" CHECK ("dream_suggestions"."kind" in ('distill_episode', 'merge_duplicates', 'mark_stale', 'update', 'tidy'));
