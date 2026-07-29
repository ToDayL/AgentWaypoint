export function relayEventStream(
  upstreamBody: ReadableStream<Uint8Array>,
  options: {
    abortUpstream: () => void;
    onFinalize: () => void;
  },
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  let finalized = false;

  const finalize = (): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    options.onFinalize();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finalize();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      options.abortUpstream();
      try {
        await reader.cancel(reason);
      } catch {
        // Aborting the upstream fetch can reject a pending read/cancel. The
        // downstream has already gone away, so cleanup is the only action left.
      } finally {
        finalize();
      }
    },
  });
}
