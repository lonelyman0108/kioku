CREATE TABLE "memory_embeddings" (
	"space_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_embeddings_memory_id_model_pk" PRIMARY KEY("memory_id","model")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('kioku_zh'::regconfig, coalesce(domain, '') || ' ' || coalesce(path, '') || ' ' || coalesce(disclosure, '') || ' ' || coalesce(content, ''))) STORED;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_space_id_memory_id_memories_space_id_id_fk" FOREIGN KEY ("space_id","memory_id") REFERENCES "public"."memories"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_embeddings_hnsw_idx" ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_fts_idx" ON "memories" USING gin ("fts");