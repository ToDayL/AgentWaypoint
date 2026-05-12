import { Injectable } from '@nestjs/common';

@Injectable()
export class QueueSignalService {
  private readonly listeners = new Set<() => void>();

  subscribeOutboundWake(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async publishOutboundWake(): Promise<void> {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // ignore listener-level exceptions
      }
    }
  }
}
