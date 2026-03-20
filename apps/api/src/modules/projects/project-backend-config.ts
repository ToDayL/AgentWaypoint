export const DEFAULT_CODEX_MODEL = 'gpt-5-codex';
export const DEFAULT_CODEX_SANDBOX = 'workspace-write';
export const DEFAULT_CODEX_APPROVAL_POLICY = 'on-request';

type CodexDefaults = {
  model: string;
  sandbox: string;
  approvalPolicy: string;
};

type ProjectLikeWithBackendConfig = {
  backend: string;
  backendConfig: unknown;
};

export function buildCodexBackendConfig(input: CodexDefaults): Record<string, string> {
  return {
    model: input.model,
    sandbox: input.sandbox,
    approvalPolicy: input.approvalPolicy,
  };
}

export function resolveProjectCodexDefaults(project: ProjectLikeWithBackendConfig): CodexDefaults {
  if (project.backend !== 'codex') {
    return codexDefaultsFromFallback();
  }

  const fromConfig = readCodexBackendConfig(project.backendConfig) ?? codexDefaultsFromFallback();
  return {
    model: fromConfig.model,
    sandbox: fromConfig.sandbox,
    approvalPolicy: fromConfig.approvalPolicy,
  };
}

export function normalizeNullableString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readCodexBackendConfig(input: unknown): CodexDefaults | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const model = normalizeNullableString(typeof record.model === 'string' ? record.model : null);
  const sandbox = normalizeNullableString(typeof record.sandbox === 'string' ? record.sandbox : null);
  const approvalPolicy = normalizeNullableString(typeof record.approvalPolicy === 'string' ? record.approvalPolicy : null);
  if (!model || !sandbox || !approvalPolicy) {
    return null;
  }
  return {
    model,
    sandbox,
    approvalPolicy,
  };
}

function codexDefaultsFromFallback(): CodexDefaults {
  return {
    model: DEFAULT_CODEX_MODEL,
    sandbox: DEFAULT_CODEX_SANDBOX,
    approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
  };
}

export function readCodexBackendConfigWithFallback(input: unknown): CodexDefaults {
  const parsed = readCodexBackendConfig(input);
  if (parsed) {
    return parsed;
  }
  return codexDefaultsFromFallback();
}

export function ensureCompleteCodexBackendConfig(input: unknown): CodexDefaults {
  const parsed = readCodexBackendConfig(input);
  if (!parsed) {
    return codexDefaultsFromFallback();
  }
  return parsed;
}
