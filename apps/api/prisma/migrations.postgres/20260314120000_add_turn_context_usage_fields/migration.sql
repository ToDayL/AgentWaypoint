-- Persist latest context usage snapshot for each turn
ALTER TABLE "Turn"
ADD COLUMN IF NOT EXISTS "contextRemainingRatio" DECIMAL(5,4),
ADD COLUMN IF NOT EXISTS "contextRemainingTokens" INTEGER,
ADD COLUMN IF NOT EXISTS "contextWindowTokens" INTEGER,
ADD COLUMN IF NOT EXISTS "contextUpdatedAt" TIMESTAMP(3);
