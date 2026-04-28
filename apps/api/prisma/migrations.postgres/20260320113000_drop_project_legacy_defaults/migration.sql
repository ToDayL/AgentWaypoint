-- Ensure codex backendConfig is hydrated from legacy columns before dropping them.
UPDATE "Project"
SET "backendConfig" = jsonb_strip_nulls(
  jsonb_build_object(
    'model',
    COALESCE(NULLIF(BTRIM("backendConfig"->>'model'), ''), NULLIF(BTRIM("defaultModel"), '')),
    'sandbox',
    COALESCE(NULLIF(BTRIM("backendConfig"->>'sandbox'), ''), NULLIF(BTRIM("defaultSandbox"), '')),
    'approvalPolicy',
    COALESCE(NULLIF(BTRIM("backendConfig"->>'approvalPolicy'), ''), NULLIF(BTRIM("defaultApprovalPolicy"), ''))
  )
)
WHERE "backend" = 'codex';

ALTER TABLE "Project"
DROP COLUMN "defaultModel",
DROP COLUMN "defaultSandbox",
DROP COLUMN "defaultApprovalPolicy";
