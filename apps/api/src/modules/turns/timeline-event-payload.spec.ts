import { describe, expect, it } from 'vitest';
import {
  resolveEventToolDetailRef,
  summarizeTimelineEventPayload,
} from './timeline-event-payload';

describe('summarizeTimelineEventPayload', () => {
  it('replaces long commands with a short start preview and a completion patch', () => {
    const command = `python3 - <<'PY'\n${'print("long command")\n'.repeat(300)}PY`;
    const payload = {
      itemId: 'command-1', kind: 'commandExecution', title: command, command,
      cwd: '/workspace', status: 'inProgress',
    };
    const started = summarizeTimelineEventPayload('tool.started', payload) as Record<string, unknown>;
    expect((started.title as string).length).toBe(120);
    expect(started.title).not.toContain('\n');
    expect(started).toMatchObject({ itemId: 'command-1', detailRef: 'item:command-1', cwd: '/workspace' });
    expect(started).not.toHaveProperty('command');

    const completed = summarizeTimelineEventPayload('tool.completed', {
      ...payload, status: 'completed', exitCode: 0, durationMs: 10,
    });
    expect(completed).toMatchObject({
      itemId: 'command-1', detailRef: 'item:command-1', status: 'completed', exitCode: 0, durationMs: 10,
    });
    expect(completed).not.toHaveProperty('command');
    expect(completed).not.toHaveProperty('title');
    expect(completed).not.toHaveProperty('cwd');
    // The durable payload is still available to the command detail endpoint.
    expect(payload.command).toBe(command);
  });

  it('keeps command text when a legacy event cannot reference a detail record', () => {
    expect(summarizeTimelineEventPayload('tool.completed', {
      kind: 'Bash', title: 'echo hello', command: 'echo hello',
    })).toMatchObject({ title: 'echo hello', command: 'echo hello' });
  });

  it('sends final message content once and keeps history ordering and range metadata', () => {
    const message = {
      id: 'message-1', sessionId: 'session-1', turnId: 'turn-1', backendItemId: 'item-1',
      role: 'assistant', content: 'Final answer', tokenCount: null,
      createdAt: '2026-10-09T00:00:00.000Z', historySeq: 4, state: 'completed',
      phase: 'final_answer', startEventSeq: 2, endEventSeq: 5, timelineStartSeq: 1,
    };
    const summary = summarizeTimelineEventPayload('assistant.message.completed', {
      itemId: 'item-1', messageId: 'message-1', text: message.content, message,
    }) as Record<string, unknown>;
    expect(summary).not.toHaveProperty('text');
    expect(summary.message).toEqual({
      id: 'message-1', role: 'assistant', content: 'Final answer',
      createdAt: message.createdAt, historySeq: 4, state: 'completed', phase: 'final_answer',
      startEventSeq: 2, endEventSeq: 5, timelineStartSeq: 1,
    });
    expect(message).toHaveProperty('sessionId', 'session-1');
    const accepted = summarizeTimelineEventPayload('user.message.accepted', {
      itemId: 'item-1', content: message.content, message: { ...message, role: 'user' },
    });
    expect(accepted).not.toHaveProperty('content');
    expect(accepted).toHaveProperty('message.content', 'Final answer');
  });

  it('keeps error text and item associations when terminal events close multiple messages', () => {
    const summary = summarizeTimelineEventPayload('turn.failed', {
      message: 'Connection failed',
      messages: [{ id: 'message-1', turnId: 'turn-1', backendItemId: 'item-1', content: 'Draft', state: 'interrupted' }],
    });
    expect(summary).toEqual({
      message: 'Connection failed',
      messages: [{ id: 'message-1', backendItemId: 'item-1', content: 'Draft', state: 'interrupted' }],
    });
  });

  it('preserves output availability when the web outbox summarizes an event again', () => {
    for (const type of ['tool.output', 'tool.completed']) {
      const summary = summarizeTimelineEventPayload(type, {
        itemId: 'command-1', kind: 'command_execution', text: 'output',
        item: { aggregatedOutput: 'output' },
      });
      expect(summary).toMatchObject({ outputAvailable: true, outputBytes: 6 });
      expect(summarizeTimelineEventPayload(type, summary)).toEqual(summary);
    }
  });

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
