-- Normalize codex backendConfig to model + executionMode and remove legacy keys.
UPDATE "Project"
SET "backendConfig" = jsonb_build_object(
  'model',
  COALESCE(NULLIF(BTRIM("backendConfig"->>'model'), ''), 'gpt-5-codex'),
  'executionMode',
  CASE
    WHEN NULLIF(BTRIM("backendConfig"->>'executionMode'), '') IN ('read-only', 'safe-write', 'yolo')
      THEN NULLIF(BTRIM("backendConfig"->>'executionMode'), '')
    WHEN NULLIF(BTRIM("backendConfig"->>'sandbox'), '') = 'read-only'
      THEN 'read-only'
    WHEN NULLIF(BTRIM("backendConfig"->>'sandbox'), '') = 'danger-full-access'
      OR NULLIF(BTRIM("backendConfig"->>'approvalPolicy'), '') = 'never'
      THEN 'yolo'
    ELSE 'safe-write'
  END
)
WHERE "backend" = 'codex';
