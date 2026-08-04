import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurrentUser } from '../auth/auth.types';
import { WebPluginAppController } from '../channels/plugins/web/web-app.controller';
import { WebPlugin } from '../channels/plugins/web/web.plugin';
import { TurnsController } from './turns.controller';
import { TurnsService } from './turns.service';

type TestReply = {
  chunks: string[];
  handlers: Record<'close' | 'error', Array<() => void>>;
  raw: {
    destroyed?: boolean;
    writableEnded?: boolean;
    setHeader: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    flushHeaders: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  };
};

const user = { id: 'user-1' } as CurrentUser;

function createReply(): TestReply {
  const chunks: string[] = [];
  const handlers: TestReply['handlers'] = { close: [], error: [] };
  return {
    chunks,
    handlers,
    raw: {
      setHeader: vi.fn(),
      write: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
      end: vi.fn(),
      flushHeaders: vi.fn(),
      once: vi.fn((event: 'close' | 'error', handler: () => void) => {
        handlers[event].push(handler);
      }),
    },
  };
}

function createRequest() {
  return {
    raw: {
      on: vi.fn(),
    },
  };
}

describe('turn stream error handling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes the core turn stream when polling events fails', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const turnsService = {
      getTurnForUser: vi.fn().mockResolvedValue({ status: 'running', sessionId: 'session-1' }),
      getEventsForTurn: vi.fn().mockRejectedValue(new Error('database timeout')),
    };
    const controller = new TurnsController(turnsService as unknown as TurnsService);
    const reply = createReply();

    await controller.streamTurn(user, { id: 'turn-1' }, {}, undefined, createRequest(), reply);

    await vi.waitFor(() => expect(reply.raw.end).toHaveBeenCalledTimes(1));
    expect(reply.chunks.join('')).toContain('event: stream.error');
    expect(reply.chunks.join('')).toContain('"code":"STREAM_POLL_FAILED"');
  });

  it('closes the web plugin turn stream when polling events fails', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const webPlugin = {
      getTurnForUser: vi.fn().mockResolvedValue({ status: 'running', sessionId: 'session-1' }),
      getEventsForTurn: vi.fn().mockRejectedValue(new Error('database timeout')),
      getDispatchedEventsForSessionTurn: vi.fn().mockReturnValue([]),
    };
    const controller = new WebPluginAppController(webPlugin as unknown as WebPlugin);
    const reply = createReply();

    await controller.streamTurn(user, { id: 'turn-1' }, {}, undefined, createRequest(), reply);

    await vi.waitFor(() => expect(reply.raw.end).toHaveBeenCalledTimes(1));
    expect(reply.chunks.join('')).toContain('event: stream.error');
    expect(reply.chunks.join('')).toContain('"code":"STREAM_POLL_FAILED"');
  });

  it('stops core stream polling when the response connection closes', async () => {
    vi.useFakeTimers();
    const turnsService = {
      getTurnForUser: vi.fn().mockResolvedValue({ status: 'running', sessionId: 'session-1' }),
      getEventsForTurn: vi.fn().mockResolvedValue([]),
    };
    const controller = new TurnsController(turnsService as unknown as TurnsService);
    const reply = createReply();

    await controller.streamTurn(user, { id: 'turn-1' }, {}, undefined, createRequest(), reply);
    await vi.advanceTimersByTimeAsync(0);
    expect(turnsService.getEventsForTurn).toHaveBeenCalledTimes(1);

    expect(reply.handlers.close).toHaveLength(1);
    reply.handlers.close[0]?.();
    await vi.advanceTimersByTimeAsync(1200);

    expect(turnsService.getEventsForTurn).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).not.toHaveBeenCalled();
  });

  it('stops web plugin stream polling when the response connection closes', async () => {
    vi.useFakeTimers();
    const webPlugin = {
      getTurnForUser: vi.fn().mockResolvedValue({ status: 'running', sessionId: 'session-1' }),
      getEventsForTurn: vi.fn().mockResolvedValue([]),
      getDispatchedEventsForSessionTurn: vi.fn().mockReturnValue([]),
    };
    const controller = new WebPluginAppController(webPlugin as unknown as WebPlugin);
    const reply = createReply();

    await controller.streamTurn(user, { id: 'turn-1' }, {}, undefined, createRequest(), reply);
    await vi.advanceTimersByTimeAsync(0);
    expect(webPlugin.getEventsForTurn).toHaveBeenCalledTimes(1);

    expect(reply.handlers.close).toHaveLength(1);
    reply.handlers.close[0]?.();
    await vi.advanceTimersByTimeAsync(1200);

    expect(webPlugin.getEventsForTurn).toHaveBeenCalledTimes(1);
    expect(reply.raw.end).not.toHaveBeenCalled();
  });

  it('ends a completed core turn stream with an explicit end event', async () => {
    vi.useFakeTimers();
    const turnsService = {
      getTurnForUser: vi.fn().mockResolvedValue({ status: 'completed', sessionId: 'session-1' }),
      getEventsForTurn: vi.fn().mockResolvedValue([]),
    };
    const controller = new TurnsController(turnsService as unknown as TurnsService);
    const reply = createReply();

    await controller.streamTurn(user, { id: 'turn-1' }, { since: 12 }, undefined, createRequest(), reply);
    await vi.advanceTimersByTimeAsync(300);

    expect(reply.chunks.join('')).toContain('retry: 2000');
    expect(reply.chunks.join('')).toContain('event: stream.end');
    expect(reply.chunks.join('')).toContain('"status":"completed"');
    expect(reply.chunks.join('')).toContain('"cursor":12');
    expect(reply.raw.end).toHaveBeenCalledTimes(1);
  });

  it('ends a completed web plugin stream with an explicit end event', async () => {
    vi.useFakeTimers();
    const webPlugin = {
      getTurnForUser: vi.fn().mockResolvedValue({ status: 'completed', sessionId: 'session-1' }),
      getEventsForTurn: vi.fn().mockResolvedValue([]),
      getDispatchedEventsForSessionTurn: vi.fn().mockReturnValue([]),
    };
    const controller = new WebPluginAppController(webPlugin as unknown as WebPlugin);
    const reply = createReply();

    await controller.streamTurn(user, { id: 'turn-1' }, { since: 12 }, undefined, createRequest(), reply);
    await vi.advanceTimersByTimeAsync(300);

    expect(reply.chunks.join('')).toContain('retry: 2000');
    expect(reply.chunks.join('')).toContain('event: stream.end');
    expect(reply.chunks.join('')).toContain('"status":"completed"');
    expect(reply.chunks.join('')).toContain('"cursor":12');
    expect(reply.raw.end).toHaveBeenCalledTimes(1);
  });
});
