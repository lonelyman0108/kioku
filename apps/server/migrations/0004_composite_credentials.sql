ALTER TABLE "credentials" ADD COLUMN "kind" text DEFAULT 'secret' NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "primary_field" text DEFAULT 'value' NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "field_meta" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "passkey_manual_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "provider" text DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "dream_suggestions" ADD COLUMN "secret_warnings" jsonb;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_kind_check" CHECK ("credentials"."kind" in ('secret', 'login', 'api', 'database', 'ssh'));--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_provider_check" CHECK ("credentials"."provider" in ('builtin', 'bitwarden', '1password'));--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_primary_field_format" CHECK ("credentials"."primary_field" ~ '^[a-z0-9][a-z0-9_-]{0,63}$');