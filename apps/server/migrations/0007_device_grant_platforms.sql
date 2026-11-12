ALTER TABLE "device_grants" ALTER COLUMN "runtime_family" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_grants" ADD COLUMN "platforms" jsonb;--> statement-breakpoint
ALTER TABLE "device_grants" ADD COLUMN "selections" jsonb;--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_platforms_shape" CHECK (("device_grants"."runtime_family" is null) <> ("device_grants"."platforms" is null));