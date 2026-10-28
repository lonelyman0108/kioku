CREATE TABLE "app_group_personas" (
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_group_personas_app_id_subject_id_pk" PRIMARY KEY("app_id","subject_id")
);
--> statement-breakpoint
-- 平台账号的外键要引用（空间、对象、种类），先建出这个唯一约束
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_spaceId_id_kind_unique" UNIQUE("space_id","id","kind");--> statement-breakpoint
ALTER TABLE "subject_identities" DROP CONSTRAINT "subject_identities_space_id_subject_id_subjects_space_id_id_fk";
--> statement-breakpoint
DROP INDEX "subject_identities_space_id_platform_external_id_index";--> statement-breakpoint
-- 已有的平台账号按所属对象的种类补上 kind。两张表都开了 FORCE RLS，迁移连接没有设置 app.space_id，
-- 要先临时取消 FORCE 才更新得到（见 0010）
ALTER TABLE "subject_identities" ADD COLUMN "kind" "subject_kind";--> statement-breakpoint
ALTER TABLE subjects NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subject_identities NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE subject_identities AS i SET kind = s.kind FROM subjects AS s WHERE s.id = i.subject_id;--> statement-breakpoint
ALTER TABLE subjects FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subject_identities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subject_identities" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subject_identities" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "app_group_personas" ADD CONSTRAINT "app_group_personas_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_group_personas" ADD CONSTRAINT "app_group_personas_space_id_app_id_apps_space_id_id_fk" FOREIGN KEY ("space_id","app_id") REFERENCES "public"."apps"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_group_personas" ADD CONSTRAINT "app_group_personas_space_id_subject_id_subjects_space_id_id_fk" FOREIGN KEY ("space_id","subject_id") REFERENCES "public"."subjects"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_group_personas" ADD CONSTRAINT "app_group_personas_space_id_persona_id_personas_space_id_id_fk" FOREIGN KEY ("space_id","persona_id") REFERENCES "public"."personas"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_group_personas_persona_id_index" ON "app_group_personas" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "app_group_personas_subject_id_index" ON "app_group_personas" USING btree ("subject_id");--> statement-breakpoint
ALTER TABLE "subject_identities" ADD CONSTRAINT "subject_identities_subject_fk" FOREIGN KEY ("space_id","subject_id","kind") REFERENCES "public"."subjects"("space_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subject_identities_space_id_platform_kind_external_id_index" ON "subject_identities" USING btree ("space_id","platform","kind","external_id");--> statement-breakpoint
-- 与其他内容表一样按 app.space_id 强制隔离
ALTER TABLE app_group_personas ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_group_personas FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY space_isolation ON app_group_personas
  USING (space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
