-- Add backend-specific runtime snapshot and normalize effectiveBackendConfig to abstract config.
ALTER TABLE "Turn"
ADD COLUMN "effectiveRuntimeConfig" JSONB;

-- Backfill runtime snapshot from existing effectiveBackendConfig when available.
UPDATE "Turn"
SET "effectiveRuntimeConfig" = "effectiveBackendConfig"
WHERE "effectiveRuntimeConfig" IS NULL
  AND "effectiveBackendConfig" IS NOT NULL;

-- Normalize effectiveBackendConfig to {cwd, model, executionMode}.
UPDATE "Turn"
SET "effectiveBackendConfig" = jsonb_strip_nulls(
  jsonb_build_object(
    'cwd', NULLIF(BTRIM("effectiveBackendConfig"->>'cwd'), ''),
    'model', NULLIF(BTRIM("effectiveBackendConfig"->>'model'), ''),
    'executionMode',
    CASE
      WHEN NULLIF(BTRIM("effectiveBackendConfig"->>'executionMode'), '') IN ('read-only', 'safe-write', 'yolo')
        THEN NULLIF(BTRIM("effectiveBackendConfig"->>'executionMode'), '')
      WHEN NULLIF(BTRIM("effectiveBackendConfig"->>'sandbox'), '') = 'read-only'
        THEN 'read-only'
      WHEN NULLIF(BTRIM("effectiveBackendConfig"->>'sandbox'), '') = 'danger-full-access'
        OR NULLIF(BTRIM("effectiveBackendConfig"->>'approvalPolicy'), '') = 'never'
        THEN 'yolo'
      WHEN "effectiveBackendConfig" ? 'sandbox' OR "effectiveBackendConfig" ? 'approvalPolicy'
        THEN 'safe-write'
      ELSE NULL
    END
  )
)
WHERE "effectiveBackendConfig" IS NOT NULL;
