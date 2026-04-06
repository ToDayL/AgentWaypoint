import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisClientType, createClient } from 'redis';

const OUTBOUND_WAKE_CHANNEL = 'channels:outbound:wake';

@Injectable()
export class QueueSignalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueSignalService.name);
  private readonly listeners = new Set<() => void>();
  private publisher: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;

  async onModuleInit(): Promise<void> {
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!redisUrl) {
      return;
    }
    try {
      this.publisher = createClient({ url: redisUrl });
      this.subscriber = createClient({ url: redisUrl });

      this.publisher.on('error', (error) => {
        this.logger.warn(`Redis publisher error: ${error.message}`);
      });
      this.subscriber.on('error', (error) => {
        this.logger.warn(`Redis subscriber error: ${error.message}`);
      });

      await this.publisher.connect();
      await this.subscriber.connect();
      await this.subscriber.subscribe(OUTBOUND_WAKE_CHANNEL, () => {
        this.emitLocalWake();
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown redis init error';
      this.logger.warn(`Queue signal service fallback to local-only mode: ${message}`);
      await this.safeClose(this.publisher);
      await this.safeClose(this.subscriber);
      this.publisher = null;
      this.subscriber = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.safeClose(this.subscriber);
    await this.safeClose(this.publisher);
    this.subscriber = null;
    this.publisher = null;
    this.listeners.clear();
  }

  subscribeOutboundWake(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async publishOutboundWake(): Promise<void> {
    this.emitLocalWake();
    if (!this.publisher) {
      return;
    }
    try {
      await this.publisher.publish(OUTBOUND_WAKE_CHANNEL, '1');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown publish error';
      this.logger.warn(`Failed to publish outbound wake signal: ${message}`);
    }
  }

  private emitLocalWake(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // ignore listener-level exceptions
      }
    }
  }

  private async safeClose(client: RedisClientType | null): Promise<void> {
    if (!client) {
      return;
    }
    try {
      if (client.isOpen) {
        await client.quit();
      }
    } catch {
      // ignore client shutdown errors
    }
  }
}
