ALTER TABLE "dream_suggestions" DROP CONSTRAINT "dream_suggestions_kind";--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD COLUMN "target_priority" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "sensitive_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "sensitive_credential" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "sensitive_pii" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "sensitive_findings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "privacy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "privacy_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "memories_sensitive_idx" ON "memories" USING btree ("space_id","sensitive_credential","sensitive_pii") WHERE "memories"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD CONSTRAINT "dream_suggestions_kind" CHECK ("dream_suggestions"."kind" in ('merge', 'distill', 'stale', 'review', 'promote'));