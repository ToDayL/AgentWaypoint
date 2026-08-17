import { describe, expect, it } from 'vitest';
import {
  resolveEventToolDetailRef,
  summarizeTimelineEventPayload,
} from './timeline-event-payload';

describe('summarizeTimelineEventPayload', () => {
  it('removes command output from delta and completed lifecycle events', () => {
    expect(
      summarizeTimelineEventPayload('tool.output', {
        itemId: 'command-1',
        kind: 'command_execution',
        stream: 'stdout',
        text: 'secret command output',
      }),
    ).toEqual({
      itemId: 'command-1',
      kind: 'command_execution',
      stream: 'stdout',
      detailRef: 'item:command-1',
      outputAvailable: true,
      outputBytes: 21,
    });

    const completed = summarizeTimelineEventPayload('tool.completed', {
      phase: 'completed',
      itemId: 'command-1',
      kind: 'commandExecution',
      item: {
        id: 'command-1',
        type: 'commandExecution',
        aggregatedOutput: 'secret command output',
        exitCode: 0,
      },
    });
    expect(completed).toMatchObject({
      itemId: 'command-1',
      kind: 'commandExecution',
      detailRef: 'item:command-1',
      exitCode: 0,
      outputAvailable: true,
    });
    expect(JSON.stringify(completed)).not.toContain('secret command output');
    expect(completed).not.toHaveProperty('item');
  });

  it('removes diff text, file lists, and file change items', () => {
    expect(
      summarizeTimelineEventPayload('diff.updated', {
        diffAvailable: true,
        files: ['one.ts', 'two.ts'],
        unifiedDiff: 'large diff',
      }),
    ).toEqual({ diffAvailable: true, snapshotAvailable: true });

    const completed = summarizeTimelineEventPayload('tool.completed', {
      itemId: 'change-1',
      kind: 'fileChange',
      item: {
        id: 'change-1',
        type: 'fileChange',
        changes: [{ path: 'one.ts', diff: 'large diff' }],
      },
    });
    expect(JSON.stringify(completed)).not.toContain('one.ts');
    expect(JSON.stringify(completed)).not.toContain('large diff');

    const approval = summarizeTimelineEventPayload('turn.approval.requested', {
      requestId: 'approval-1',
      kind: 'file_change',
      reason: 'Review changes',
      changes: { 'one.ts': { diff: 'large diff' } },
      item: { changes: [{ path: 'one.ts' }] },
    });
    expect(approval).toEqual({
      requestId: 'approval-1',
      kind: 'file_change',
      reason: 'Review changes',
    });
  });

  it('only creates detail references from stable tool identifiers', () => {
    expect(resolveEventToolDetailRef({ toolCallId: 'call-1', kind: 'Bash' })).toBe('call:call-1');
    expect(resolveEventToolDetailRef({ item: { id: 'item-1' }, kind: 'commandExecution' })).toBe(
      'item:item-1',
    );
    expect(resolveEventToolDetailRef({ title: 'Repeated command', kind: 'command_execution' })).toBeNull();
  });

  it('keeps non-command tool progress text', () => {
    expect(
      summarizeTimelineEventPayload('tool.output', {
        toolCallId: 'task-1',
        kind: 'task',
        output: 'Running (1.0s)',
      }),
    ).toMatchObject({
      toolCallId: 'task-1',
      kind: 'task',
      output: 'Running (1.0s)',
      outputAvailable: true,
    });
  });
});
