-- 账号的停用时间，管理员新建的账号在设置密码之前没有密码哈希；会话记下客户端地址、User-Agent 与最近活动；
-- 设置与重置密码的一次性链接（只存令牌的哈希，不进全实例备份）。已有的会话把最近活动记为迁移的时刻
CREATE TYPE "public"."account_link_purpose" AS ENUM('setup', 'reset');--> statement-breakpoint
CREATE TABLE "account_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" "account_link_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "account_links_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "client_address" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_links_account_id_index" ON "account_links" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_links_expires_at_index" ON "account_links" USING btree ("expires_at");