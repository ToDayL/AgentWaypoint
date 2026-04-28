-- Add backend metadata to projects.
ALTER TABLE "Project"
ADD COLUMN "backend" TEXT NOT NULL DEFAULT 'codex',
ADD COLUMN "backendConfig" JSONB;

-- Backfill codex configuration from legacy default columns.
UPDATE "Project"
SET "backendConfig" = jsonb_strip_nulls(
  jsonb_build_object(
    'model',
    NULLIF(BTRIM("defaultModel"), ''),
    'sandbox',
    NULLIF(BTRIM("defaultSandbox"), ''),
    'approvalPolicy',
    NULLIF(BTRIM("defaultApprovalPolicy"), '')
  )
)
WHERE COALESCE(BTRIM("defaultModel"), '') <> ''
   OR COALESCE(BTRIM("defaultSandbox"), '') <> ''
   OR COALESCE(BTRIM("defaultApprovalPolicy"), '') <> '';
