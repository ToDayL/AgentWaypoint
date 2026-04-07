ALTER TABLE "Session" ADD COLUMN "meta" JSONB;

UPDATE "Session" AS s
SET "meta" = jsonb_build_object(
  'runtime', jsonb_build_object(
    'backend', p."backend",
    'cwd', p."repoPath",
    'backendConfig', COALESCE(p."backendConfig", '{}'::jsonb)
  ),
  'override', '{}'::jsonb
)
FROM "Project" AS p
WHERE s."projectId" = p."id" AND s."meta" IS NULL;
