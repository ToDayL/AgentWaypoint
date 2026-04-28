UPDATE "Project"
SET "backendConfig" = jsonb_build_object(
  'model',
  COALESCE(NULLIF(BTRIM("backendConfig"->>'model'), ''), 'gpt-5-codex'),
  'sandbox',
  COALESCE(NULLIF(BTRIM("backendConfig"->>'sandbox'), ''), 'workspace-write'),
  'approvalPolicy',
  COALESCE(NULLIF(BTRIM("backendConfig"->>'approvalPolicy'), ''), 'on-request')
)
WHERE "backend" = 'codex';
