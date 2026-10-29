CREATE TABLE "subject_bind_attempts" (
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subject_bind_attempts_app_id_key_pk" PRIMARY KEY("app_id","key")
);
--> statement-breakpoint
CREATE TABLE "subject_bind_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"previewed_by" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subject_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"from_subject_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"issued_platform" text NOT NULL,
	"issued_external_id" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"account_id" uuid,
	"decided_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	CONSTRAINT "subject_bindings_status" CHECK ("subject_bindings"."status" in ('pending', 'merged', 'confirmed', 'rejected', 'cancelled')
        and ("subject_bindings"."status" = 'pending') = ("subject_bindings"."decided_at" is null)
        and ("subject_bindings"."status" <> 'pending' or "subject_bindings"."expires_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "subject_bind_attempts" ADD CONSTRAINT "subject_bind_attempts_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_attempts" ADD CONSTRAINT "subject_bind_attempts_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_codes" ADD CONSTRAINT "subject_bind_codes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_codes" ADD CONSTRAINT "subject_bind_codes_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bind_codes" ADD CONSTRAINT "subject_bind_codes_subject_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_subject_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_bindings" ADD CONSTRAINT "subject_bindings_from_subject_fk" FOREIGN KEY ("space_id","from_subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subject_bind_attempts_reset_at_index" ON "subject_bind_attempts" USING btree ("reset_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_bind_codes_app_id_code_hash_index" ON "subject_bind_codes" USING btree ("app_id","code_hash");--> statement-breakpoint
CREATE INDEX "subject_bind_codes_subject_id_index" ON "subject_bind_codes" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subject_bind_codes_expires_at_index" ON "subject_bind_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "subject_bindings_subject_id_index" ON "subject_bindings" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "subject_bindings_from_subject_id_index" ON "subject_bindings" USING btree ("from_subject_id");--> statement-breakpoint
CREATE INDEX "subject_bindings_account_id_index" ON "subject_bindings" USING btree ("account_id") WHERE "subject_bindings"."status" = 'pending';--> statement-breakpoint
-- 与其他内容表一样按 app.space_id 强制隔离
ALTER TABLE subject_bind_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subject_bind_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON subject_bind_codes
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE subject_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subject_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON subject_bindings
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE subject_bind_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subject_bind_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON subject_bind_attempts
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
