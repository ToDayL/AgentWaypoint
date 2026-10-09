import { describe, expect, it } from 'vitest';
import { normalizeTurnEventPage } from './turn-event-history';

const event = {
  seq: 251, type: 'tool.completed', payload: { itemId: 'command-1', exitCode: 0 },
  createdAt: '2026-10-09T00:00:00.000Z',
};

describe('turn event history pages', () => {
  it('restores the enclosing turn without changing cursors or event payloads', () => {
    const page = normalizeTurnEventPage({ turnId: 'turn-1', events: [event] }, 'fallback');
    expect(page).toEqual({ events: [{ ...event, turnId: 'turn-1' }], eventCount: 1 });
    expect(normalizeTurnEventPage({ turnId: 'turn-1', events: [] }, 'fallback')).toEqual({
      events: [], eventCount: 0,
    });
  });

  it('accepts legacy array responses during a staggered deployment', () => {
    expect(normalizeTurnEventPage([{ ...event, turnId: 'legacy-turn' }], 'fallback').events).toEqual([
      { ...event, turnId: 'legacy-turn' },
    ]);
  });

  it('retains the raw page size when filtering invalid events for pagination', () => {
    const page = normalizeTurnEventPage({
      turnId: 'turn-1', events: [{ ...event, seq: Number.NaN }, event],
    }, 'fallback');
    expect(page.eventCount).toBe(2);
    expect(page.events.map((entry) => entry.seq)).toEqual([251]);
  });
});
