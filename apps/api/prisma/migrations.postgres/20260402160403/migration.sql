-- AlterTable
ALTER TABLE "Turn" ADD COLUMN     "triggerIntegrationId" TEXT,
ADD COLUMN     "triggerProvider" TEXT DEFAULT 'web';
