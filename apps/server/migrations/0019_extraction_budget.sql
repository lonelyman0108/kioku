ALTER TABLE "extraction_runs" ADD COLUMN "summary_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD COLUMN "limited" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "extraction_monthly_tokens" integer DEFAULT 2000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "extraction_daily_writes" integer DEFAULT 20 NOT NULL;