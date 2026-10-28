DROP INDEX "subjects_space_id_index";--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "name_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "subjects_space_id_created_at_id_index" ON "subjects" USING btree ("space_id","created_at","id");