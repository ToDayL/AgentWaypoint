import { describe, expect, it, vi } from 'vitest';
import { relayEventStream } from '../_stream-proxy';

describe('relayEventStream', () => {
  it('aborts and cancels the upstream stream when the downstream closes', async () => {
    const upstreamCancel = vi.fn();
    const abortUpstream = vi.fn();
    const onFinalize = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      cancel: upstreamCancel,
    });

    const relayed = relayEventStream(upstream, {
      abortUpstream,
      onFinalize,
    });
    await relayed.cancel('client disconnected');

    expect(abortUpstream).toHaveBeenCalledTimes(1);
    expect(upstreamCancel).toHaveBeenCalledWith('client disconnected');
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });

  it('finalizes normally without aborting the upstream stream', async () => {
    const abortUpstream = vi.fn();
    const onFinalize = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const reader = relayEventStream(upstream, {
      abortUpstream,
      onFinalize,
    }).getReader();

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: new Uint8Array([1, 2, 3]),
    });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(abortUpstream).not.toHaveBeenCalled();
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });
});
