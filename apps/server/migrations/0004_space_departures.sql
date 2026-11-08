-- 离开空间的成员：离开的时间与离开时的成员设置，满 30 天由保留期的清理删掉他在这个空间的本人记忆、凭据与密码库连接。
-- 身份表，和 space_members 一样不进 RLS
CREATE TABLE "space_departures" (
	"space_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"left_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dream_private" boolean NOT NULL,
	"purge_started_at" timestamp with time zone,
	CONSTRAINT "space_departures_space_id_account_id_pk" PRIMARY KEY("space_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "space_departures" ADD CONSTRAINT "space_departures_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_departures" ADD CONSTRAINT "space_departures_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "space_departures_left_at_index" ON "space_departures" USING btree ("left_at");