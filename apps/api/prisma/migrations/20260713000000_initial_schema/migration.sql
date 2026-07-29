-- AgentWaypoint SQLite baseline.
--
-- This migration is intentionally idempotent so existing databases created by
-- the previous `prisma db push` startup path can be adopted by Prisma Migrate.
-- On a legacy database the tables and indexes already exist, and startup
-- baselines this migration before applying subsequent migrations.

-- CreateTable
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "role" TEXT NOT NULL DEFAULT 'user',
    "authPolicy" TEXT NOT NULL DEFAULT 'password_or_webauthn',
    "passwordHash" TEXT,
    "lastLoginAt" DATETIME,
    "turnSteerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultWorkspaceRoot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AuthSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sessionTokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "ip" TEXT,
    "userAgent" TEXT,
    CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoPath" TEXT,
    "backend" TEXT NOT NULL DEFAULT 'codex',
    "backendConfig" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Project_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "meta" JSONB,
    "backendThreadId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Turn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "userMessageId" TEXT,
    "assistantMessageId" TEXT,
    "triggerIdentifier" TEXT NOT NULL DEFAULT 'web',
    "triggerProvider" TEXT DEFAULT 'web',
    "triggerIntegrationId" TEXT,
    "triggerMessageId" TEXT,
    "status" TEXT NOT NULL,
    "backend" TEXT,
    "requestedBackendConfig" JSONB,
    "effectiveBackendConfig" JSONB,
    "effectiveRuntimeConfig" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "contextRemainingRatio" REAL,
    "contextRemainingTokens" INTEGER,
    "contextWindowTokens" INTEGER,
    "contextUpdatedAt" DATETIME,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Turn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TurnApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "decision" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "publishedAt" DATETIME,
    "autoApproveAt" DATETIME,
    "pausedAt" DATETIME,
    "pausedRemainingMs" INTEGER,
    CONSTRAINT "TurnApproval_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BotIntegration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "credentialsEncrypted" JSONB,
    "pluginConfig" JSONB,
    "lastSyncAt" DATETIME,
    "lastErrorAt" DATETIME,
    "lastErrorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BotIntegration_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BotMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadRaw" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "claimedBy" TEXT,
    "claimedAt" DATETIME,
    "leaseExpireAt" DATETIME,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "deliveredAt" DATETIME,
    CONSTRAINT "BotMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChannelFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "storageProvider" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChannelFile_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BotAuthSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botIntegrationId" TEXT,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "challengeType" TEXT,
    "challengePayload" JSONB,
    "resultPayload" JSONB,
    "expiresAt" DATETIME,
    "lastPolledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AuthSession_sessionTokenHash_key" ON "AuthSession"("sessionTokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuthSession_userId_expiresAt_revokedAt_idx" ON "AuthSession"("userId", "expiresAt", "revokedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Project_ownerUserId_idx" ON "Project"("ownerUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Session_projectId_idx" ON "Session"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_sessionId_idx" ON "Message"("sessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Turn_sessionId_idx" ON "Turn"("sessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TurnApproval_turnId_status_createdAt_idx" ON "TurnApproval"("turnId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TurnApproval_turnId_requestId_key" ON "TurnApproval"("turnId", "requestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Event_turnId_seq_idx" ON "Event"("turnId", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BotIntegration_ownerUserId_status_updatedAt_idx" ON "BotIntegration"("ownerUserId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BotIntegration_provider_status_updatedAt_idx" ON "BotIntegration"("provider", "status", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BotMessage_projectId_sessionId_createdAt_idx" ON "BotMessage"("projectId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BotMessage_status_nextAttemptAt_createdAt_idx" ON "BotMessage"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BotMessage_status_leaseExpireAt_createdAt_idx" ON "BotMessage"("status", "leaseExpireAt", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChannelFile_projectId_sessionId_createdAt_idx" ON "ChannelFile"("projectId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChannelFile_storageProvider_storageKey_idx" ON "ChannelFile"("storageProvider", "storageKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BotAuthSession_botIntegrationId_status_updatedAt_idx" ON "BotAuthSession"("botIntegrationId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BotAuthSession_provider_status_createdAt_idx" ON "BotAuthSession"("provider", "status", "createdAt");
