-- AlterTable
ALTER TABLE "Project" ADD COLUMN "defaultModel" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "modelOverride" TEXT;
