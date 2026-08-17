const DEFAULT_CONTEXT_UPDATE_MIN_INTERVAL_MS = 1_000;

export type ContextUpdateSource = {
  contextRemainingRatio: number | null;
  contextUpdatedAt: Date | null;
};

export type ContextUpdatePayload = {
  turnId: string;
  remainingRatio: number;
  updatedAt: string | null;
};

export class ContextUpdateStreamTracker {
  private lastDisplayPercent: number | null = null;
  private lastSentAt = 0;

  constructor(private readonly minIntervalMs = DEFAULT_CONTEXT_UPDATE_MIN_INTERVAL_MS) {}

  next(
    turnId: string,
    source: ContextUpdateSource,
    options?: { force?: boolean; now?: number },
  ): ContextUpdatePayload | null {
    const ratio = normalizeRatio(source.contextRemainingRatio);
    if (ratio === null) {
      return null;
    }

    const displayPercent = Math.round(ratio * 100);
    if (displayPercent === this.lastDisplayPercent) {
      return null;
    }

    const now = options?.now ?? Date.now();
    if (!options?.force && this.lastSentAt > 0 && now - this.lastSentAt < this.minIntervalMs) {
      return null;
    }

    this.lastDisplayPercent = displayPercent;
    this.lastSentAt = now;
    return {
      turnId,
      remainingRatio: ratio,
      updatedAt: source.contextUpdatedAt?.toISOString() ?? null,
    };
  }
}

function normalizeRatio(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}
