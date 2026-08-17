import { describe, expect, it } from 'vitest';
import { ContextUpdateStreamTracker } from './context-update-stream';

describe('ContextUpdateStreamTracker', () => {
  it('emits a minimal snapshot and suppresses changes within the same displayed percent', () => {
    const tracker = new ContextUpdateStreamTracker();
    const updatedAt = new Date('2026-08-17T07:22:52.935Z');

    expect(
      tracker.next('turn-1', { contextRemainingRatio: 0.8456, contextUpdatedAt: updatedAt }, { now: 1_000 }),
    ).toEqual({
      turnId: 'turn-1',
      remainingRatio: 0.8456,
      updatedAt: updatedAt.toISOString(),
    });
    expect(
      tracker.next('turn-1', { contextRemainingRatio: 0.8461, contextUpdatedAt: updatedAt }, { now: 2_000 }),
    ).toBeNull();
  });

  it('rate limits displayed-percent changes and emits the latest value after the interval', () => {
    const tracker = new ContextUpdateStreamTracker(1_000);

    expect(
      tracker.next('turn-1', { contextRemainingRatio: 0.85, contextUpdatedAt: null }, { now: 1_000 }),
    ).not.toBeNull();
    expect(
      tracker.next('turn-1', { contextRemainingRatio: 0.83, contextUpdatedAt: null }, { now: 1_500 }),
    ).toBeNull();
    expect(
      tracker.next('turn-1', { contextRemainingRatio: 0.82, contextUpdatedAt: null }, { now: 2_000 }),
    ).toMatchObject({ remainingRatio: 0.82 });
  });

  it('allows a terminal flush to bypass the rate limit', () => {
    const tracker = new ContextUpdateStreamTracker(1_000);
    tracker.next('turn-1', { contextRemainingRatio: 0.85, contextUpdatedAt: null }, { now: 1_000 });

    expect(
      tracker.next(
        'turn-1',
        { contextRemainingRatio: 0.8, contextUpdatedAt: null },
        { force: true, now: 1_100 },
      ),
    ).toMatchObject({ remainingRatio: 0.8 });
  });
});
