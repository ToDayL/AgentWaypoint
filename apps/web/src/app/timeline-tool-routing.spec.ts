import { describe, expect, it } from 'vitest';
import { findTargetToolTimelineIndex, resolveToolKey } from './timeline-tool-routing';

describe('timeline tool event routing', () => {
  it('uses the Codex item id consistently across lifecycle events', () => {
    const startedKey = resolveToolKey({
      seq: 1,
      payload: { itemId: 'item-123', title: 'Run command', kind: 'commandExecution' },
    });
    const outputKey = resolveToolKey({
      seq: 2,
      payload: { itemId: 'item-123', kind: 'command_execution', text: 'output' },
    });

    expect(startedKey).toBe('item-123');
    expect(outputKey).toBe(startedKey);
  });

  it('does not attach unmatched output to an unrelated running tool', () => {
    const events = [
      { kind: 'tool', toolKey: 'item-a' },
      { kind: 'reasoning' },
      { kind: 'tool', toolKey: 'item-b' },
    ];

    expect(findTargetToolTimelineIndex(events, 'item-missing')).toBe(-1);
    expect(findTargetToolTimelineIndex(events, 'item-a')).toBe(0);
  });
});
