ALTER TABLE "credentials" ADD COLUMN "key_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "key_id" text;--> statement-breakpoint
CREATE INDEX "credentials_key_id_idx" ON "credentials" USING btree ("space_id","key_id") WHERE "credentials"."wrapped_key" is not null;--> statement-breakpoint
CREATE INDEX "memories_key_id_idx" ON "memories" USING btree ("space_id","key_id") WHERE "memories"."wrapped_key" is not null;