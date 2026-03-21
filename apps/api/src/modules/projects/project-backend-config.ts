export const DEFAULT_CODEX_MODEL = 'gpt-5-codex';
export const DEFAULT_CODEX_EXECUTION_MODE = 'safe-write';
export type CodexExecutionMode = 'read-only' | 'safe-write' | 'yolo';

export type CodexDefaults = {
  model: string;
  executionMode: CodexExecutionMode;
};

type ProjectLikeWithBackendConfig = {
  backend: string;
  backendConfig: unknown;
};

export function buildCodexBackendConfig(input: CodexDefaults): Record<string, string> {
  return {
    model: input.model,
    executionMode: input.executionMode,
  };
}

export function resolveProjectCodexDefaults(project: ProjectLikeWithBackendConfig): CodexDefaults {
  if (project.backend !== 'codex') {
    return codexDefaultsFromFallback();
  }

  const fromConfig = readCodexBackendConfig(project.backendConfig) ?? codexDefaultsFromFallback();
  return {
    model: fromConfig.model,
    executionMode: fromConfig.executionMode,
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
  const executionMode = readCodexExecutionMode(record);
  if (!model || !executionMode) {
    return null;
  }
  return {
    model,
    executionMode,
  };
}

function codexDefaultsFromFallback(): CodexDefaults {
  return {
    model: DEFAULT_CODEX_MODEL,
    executionMode: DEFAULT_CODEX_EXECUTION_MODE,
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

function readCodexExecutionMode(record: Record<string, unknown>): CodexExecutionMode | null {
  const explicit = normalizeNullableString(typeof record.executionMode === 'string' ? record.executionMode : null);
  if (explicit === 'read-only' || explicit === 'safe-write' || explicit === 'yolo') {
    return explicit;
  }
  return null;
}
