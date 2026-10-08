-- Additive migration: existing replies retain their turn-sized bodies.
ALTER TABLE "Turn" ADD COLUMN "historyVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Turn" ADD COLUMN "backendTurnId" TEXT;
ALTER TABLE "Turn" ADD COLUMN "runnerCursor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Message" ADD COLUMN "turnId" TEXT;
ALTER TABLE "Message" ADD COLUMN "backendItemId" TEXT;
ALTER TABLE "Message" ADD COLUMN "historySeq" INTEGER;
ALTER TABLE "Message" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE "Message" ADD COLUMN "phase" TEXT;
ALTER TABLE "Message" ADD COLUMN "startEventSeq" INTEGER;
ALTER TABLE "Message" ADD COLUMN "endEventSeq" INTEGER;
ALTER TABLE "Message" ADD COLUMN "timelineStartSeq" INTEGER;
ALTER TABLE "BotMessage" ADD COLUMN "messageId" TEXT;

WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "sessionId" ORDER BY "createdAt", "id") AS position
  FROM "Message"
)
UPDATE "Message" SET "historySeq" = (SELECT position FROM ordered WHERE ordered.id = "Message".id);
UPDATE "Message" SET "turnId" = (
  SELECT "id" FROM "Turn" WHERE "userMessageId" = "Message".id OR "assistantMessageId" = "Message".id LIMIT 1
);

CREATE UNIQUE INDEX "Message_sessionId_historySeq_key" ON "Message"("sessionId", "historySeq");
CREATE UNIQUE INDEX "Message_turnId_backendItemId_key" ON "Message"("turnId", "backendItemId");
CREATE UNIQUE INDEX "BotMessage_messageId_key" ON "BotMessage"("messageId");

CREATE TABLE "TurnInput" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "turnId" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "messageId" TEXT,
  "backendItemId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" DATETIME,
  "acceptedAt" DATETIME,
  "errorMessage" TEXT,
  CONSTRAINT "TurnInput_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TurnInput_turnId_clientRequestId_key" ON "TurnInput"("turnId", "clientRequestId");
CREATE INDEX "TurnInput_turnId_status_createdAt_idx" ON "TurnInput"("turnId", "status", "createdAt");
