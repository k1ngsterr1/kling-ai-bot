/*
  Warnings:

  - Added the required column `name` to the `kling_config` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."kling_config" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT 'Primary',
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- Update existing records to have a proper name and set as default
UPDATE "public"."kling_config" SET "name" = 'Primary', "isDefault" = true, "priority" = 10 WHERE "id" = (SELECT MIN("id") FROM "public"."kling_config");

-- Remove the default from name column after data migration
ALTER TABLE "public"."kling_config" ALTER COLUMN "name" DROP DEFAULT;
