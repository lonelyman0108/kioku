CREATE TABLE "legacy_api_keys" (
	"prefix" text PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"name" text NOT NULL,
	"owner_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_api_keys" ADD CONSTRAINT "legacy_api_keys_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
