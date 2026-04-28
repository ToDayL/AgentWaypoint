-- Add persisted Codex thread mapping per session for runner resume flow
ALTER TABLE "Session"
ADD COLUMN IF NOT EXISTS "codexThreadId" TEXT;
