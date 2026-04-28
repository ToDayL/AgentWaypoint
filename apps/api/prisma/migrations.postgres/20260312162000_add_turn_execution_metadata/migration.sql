ALTER TABLE "Turn"
ADD COLUMN "requestedCwd" TEXT,
ADD COLUMN "requestedModel" TEXT,
ADD COLUMN "requestedSandbox" TEXT,
ADD COLUMN "requestedApprovalPolicy" TEXT,
ADD COLUMN "effectiveCwd" TEXT,
ADD COLUMN "effectiveModel" TEXT,
ADD COLUMN "effectiveSandbox" TEXT,
ADD COLUMN "effectiveApprovalPolicy" TEXT;
