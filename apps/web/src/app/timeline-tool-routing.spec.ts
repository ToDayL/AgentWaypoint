import { describe, expect, it } from 'vitest';
import {
  findTargetToolTimelineIndex,
  isCommandToolKind,
  resolveToolDetailRef,
  resolveToolKey,
} from './timeline-tool-routing';

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

  it('routes tools with an explicit detail reference without falling back to a colliding key', () => {
    const events = [
      { kind: 'tool', toolKey: 'Bash', detailRef: 'call:first' },
      { kind: 'tool', toolKey: 'Bash', detailRef: 'call:second' },
    ];

    expect(findTargetToolTimelineIndex(events, 'Bash', 'call:first')).toBe(0);
    expect(findTargetToolTimelineIndex(events, 'Bash', 'call:missing')).toBe(-1);
    expect(resolveToolDetailRef({ seq: 3, payload: { detailRef: 'call:first' } })).toBe('call:first');
    expect(resolveToolDetailRef({ seq: 4, payload: { kind: 'Bash', title: 'Bash' } })).toBeUndefined();
  });

  it('recognizes command kinds from Codex and Claude', () => {
    expect(isCommandToolKind('commandExecution')).toBe(true);
    expect(isCommandToolKind('command_execution')).toBe(true);
    expect(isCommandToolKind('Bash')).toBe(true);
    expect(isCommandToolKind('local_command')).toBe(true);
    expect(isCommandToolKind('fileChange')).toBe(false);
    expect(isCommandToolKind('task')).toBe(false);
  });
});
