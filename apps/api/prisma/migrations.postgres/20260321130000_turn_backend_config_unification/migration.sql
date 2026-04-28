-- Unify turn execution fields into backend + backendConfig snapshots.
ALTER TABLE "Turn"
ADD COLUMN "backend" TEXT,
ADD COLUMN "requestedBackendConfig" JSONB,
ADD COLUMN "effectiveBackendConfig" JSONB;

UPDATE "Turn" t
SET "backend" = COALESCE(NULLIF(BTRIM(p."backend"), ''), 'codex')
FROM "Session" s
JOIN "Project" p ON p."id" = s."projectId"
WHERE s."id" = t."sessionId";

UPDATE "Turn"
SET "requestedBackendConfig" = jsonb_strip_nulls(
  jsonb_build_object(
    'cwd', NULLIF(BTRIM("requestedCwd"), ''),
    'model', NULLIF(BTRIM("requestedModel"), ''),
    'sandbox', NULLIF(BTRIM("requestedSandbox"), ''),
    'approvalPolicy', NULLIF(BTRIM("requestedApprovalPolicy"), '')
  )
),
"effectiveBackendConfig" = jsonb_strip_nulls(
  jsonb_build_object(
    'cwd', NULLIF(BTRIM("effectiveCwd"), ''),
    'model', NULLIF(BTRIM("effectiveModel"), ''),
    'sandbox', NULLIF(BTRIM("effectiveSandbox"), ''),
    'approvalPolicy', NULLIF(BTRIM("effectiveApprovalPolicy"), '')
  )
);

ALTER TABLE "Turn"
DROP COLUMN "requestedCwd",
DROP COLUMN "requestedModel",
DROP COLUMN "requestedSandbox",
DROP COLUMN "requestedApprovalPolicy",
DROP COLUMN "effectiveCwd",
DROP COLUMN "effectiveModel",
DROP COLUMN "effectiveSandbox",
DROP COLUMN "effectiveApprovalPolicy";
