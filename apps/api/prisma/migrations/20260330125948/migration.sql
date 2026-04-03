-- CreateTable
CREATE TABLE "BotIntegration" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "credentialsEncrypted" JSONB,
    "pluginConfig" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotMessage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadRaw" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "BotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelFile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "storageProvider" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotAuthSession" (
    "id" TEXT NOT NULL,
    "botIntegrationId" TEXT,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "challengeType" TEXT,
    "challengePayload" JSONB,
    "resultPayload" JSONB,
    "expiresAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotIntegration_ownerUserId_status_updatedAt_idx" ON "BotIntegration"("ownerUserId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "BotIntegration_provider_status_updatedAt_idx" ON "BotIntegration"("provider", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "BotMessage_projectId_sessionId_createdAt_idx" ON "BotMessage"("projectId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "BotMessage_status_nextAttemptAt_createdAt_idx" ON "BotMessage"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelFile_projectId_sessionId_createdAt_idx" ON "ChannelFile"("projectId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelFile_storageProvider_storageKey_idx" ON "ChannelFile"("storageProvider", "storageKey");

-- CreateIndex
CREATE INDEX "BotAuthSession_botIntegrationId_status_updatedAt_idx" ON "BotAuthSession"("botIntegrationId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "BotAuthSession_provider_status_createdAt_idx" ON "BotAuthSession"("provider", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "BotIntegration" ADD CONSTRAINT "BotIntegration_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelFile" ADD CONSTRAINT "ChannelFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelFile" ADD CONSTRAINT "ChannelFile_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
