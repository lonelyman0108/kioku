CREATE TABLE "device_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_hash" text NOT NULL,
	"user_hash" text NOT NULL,
	"runtime_family" text NOT NULL,
	"client_name" text,
	"client_address" text,
	"client_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"space_id" uuid,
	"app_id" uuid,
	"key_name" text,
	"scopes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	CONSTRAINT "device_grants_deviceHash_unique" UNIQUE("device_hash"),
	CONSTRAINT "device_grants_userHash_unique" UNIQUE("user_hash")
);
--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_approved_by_accounts_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_grants_expires_at_index" ON "device_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "device_grants_client_key_index" ON "device_grants" USING btree ("client_key");