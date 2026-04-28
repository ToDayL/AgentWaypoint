CREATE TABLE "TurnApproval" (
    "id" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "decision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "TurnApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TurnApproval_turnId_requestId_key" ON "TurnApproval"("turnId", "requestId");
CREATE INDEX "TurnApproval_turnId_status_createdAt_idx" ON "TurnApproval"("turnId", "status", "createdAt");

ALTER TABLE "TurnApproval"
ADD CONSTRAINT "TurnApproval_turnId_fkey"
FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
