UPDATE "Session" AS s
SET
  "cwdOverride" = COALESCE(s."cwdOverride", p."repoPath"),
  "modelOverride" = COALESCE(s."modelOverride", p."defaultModel"),
  "sandboxOverride" = COALESCE(s."sandboxOverride", p."defaultSandbox"),
  "approvalPolicyOverride" = COALESCE(s."approvalPolicyOverride", p."defaultApprovalPolicy")
FROM "Project" AS p
WHERE s."projectId" = p."id";
