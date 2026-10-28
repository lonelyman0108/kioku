CREATE TABLE "conversation_turns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"group_subject_id" uuid,
	"sender_subject_id" uuid NOT NULL,
	"sender_name" text,
	"user_text" text NOT NULL,
	"reply_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_turns_chat_type" CHECK ("conversation_turns"."chat_type" in ('direct', 'group', 'channel')
        and ("conversation_turns"."chat_type" = 'direct') = ("conversation_turns"."group_subject_id" is null))
);
--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_group_fk" FOREIGN KEY ("space_id","group_subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_sender_fk" FOREIGN KEY ("space_id","sender_subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_turns_app_id_session_id_id_index" ON "conversation_turns" USING btree ("app_id","session_id","id");--> statement-breakpoint
CREATE INDEX "conversation_turns_created_at_index" ON "conversation_turns" USING btree ("created_at");--> statement-breakpoint
-- 与其他内容表一样按 app.space_id 强制隔离
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_turns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON conversation_turns
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
