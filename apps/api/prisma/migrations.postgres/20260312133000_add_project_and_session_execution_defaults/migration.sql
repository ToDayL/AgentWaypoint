ALTER TABLE "Project"
ADD COLUMN "defaultSandbox" TEXT,
ADD COLUMN "defaultApprovalPolicy" TEXT;

ALTER TABLE "Session"
ADD COLUMN "sandboxOverride" TEXT,
ADD COLUMN "approvalPolicyOverride" TEXT;
