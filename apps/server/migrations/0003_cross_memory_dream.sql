ALTER TABLE "dream_suggestions" DROP CONSTRAINT "dream_suggestions_kind_check";
--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_kind_check" CHECK ("dream_suggestions"."kind" in ('distill_episode', 'merge_duplicates', 'mark_stale', 'update', 'tidy', 'link_entries', 'adjust_boot_mode'));
--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD COLUMN "proposed_links" jsonb;
--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD COLUMN "proposed_boot_mode" text;
--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_boot_mode_check" CHECK ("dream_suggestions"."proposed_boot_mode" is null or "dream_suggestions"."proposed_boot_mode" in ('none', 'index', 'full'));
