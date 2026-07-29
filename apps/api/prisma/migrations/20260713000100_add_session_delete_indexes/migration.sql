-- Add indexes used by SQLite foreign-key cascade checks when deleting one
-- session. Without these, deleting a session scans the full BotMessage and
-- ChannelFile tables.

CREATE INDEX IF NOT EXISTS "BotMessage_sessionId_idx" ON "BotMessage"("sessionId");

CREATE INDEX IF NOT EXISTS "ChannelFile_sessionId_idx" ON "ChannelFile"("sessionId");
