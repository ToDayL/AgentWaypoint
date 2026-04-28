-- Reconstructed local migration to match applied DB state (non-destructive history repair).
CREATE TABLE "ChannelMessageContext" (
    "id" TEXT NOT NULL,
    "unifiedIdentifier" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerChannelId" TEXT NOT NULL,
    "providerThreadId" TEXT,
    "providerUserId" TEXT,
    "providerMessageId" TEXT,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT,
    "userMessageId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelMessageContext_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelMessageContext_unifiedIdentifier_key" ON "ChannelMessageContext"("unifiedIdentifier");
CREATE UNIQUE INDEX "ChannelMessageContext_integrationId_providerEventId_key" ON "ChannelMessageContext"("integrationId", "providerEventId");
CREATE INDEX "ChannelMessageContext_projectId_sessionId_createdAt_idx" ON "ChannelMessageContext"("projectId", "sessionId", "createdAt");
CREATE INDEX "ChannelMessageContext_turnId_createdAt_idx" ON "ChannelMessageContext"("turnId", "createdAt");
CREATE INDEX "ChannelMessageContext_provider_providerChannelId_providerTh_idx" ON "ChannelMessageContext"("provider", "providerChannelId", "providerThreadId", "createdAt");
