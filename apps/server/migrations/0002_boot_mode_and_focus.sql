ALTER TABLE "entries" ADD COLUMN "boot_mode" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
UPDATE "entries" SET "boot_mode" = 'full' WHERE "is_pinned" = true AND "kind" = 'entry';
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_boot_mode_check" CHECK ("entries"."boot_mode" in ('none', 'index', 'full'));
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_boot_mode_pinned_sync" CHECK ("entries"."is_pinned" = ("entries"."boot_mode" <> 'none'));
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "focus_realms" text[];
--> statement-breakpoint
ALTER TABLE "device_grants" ADD COLUMN "focus_realms" text[];
