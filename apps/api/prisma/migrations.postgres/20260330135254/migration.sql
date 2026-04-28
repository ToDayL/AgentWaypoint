-- AlterTable
ALTER TABLE "BotMessage" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "leaseExpireAt" TIMESTAMP(3),
ADD COLUMN     "providerMessageId" TEXT;

-- CreateIndex
CREATE INDEX "BotMessage_status_leaseExpireAt_createdAt_idx" ON "BotMessage"("status", "leaseExpireAt", "createdAt");
