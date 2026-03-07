import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CancelTurnInput, RunnerAdapter, StartTurnInput } from './runner.types';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

@Injectable()
export class MockRunnerAdapter implements RunnerAdapter {
  private readonly logger = new Logger(MockRunnerAdapter.name);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>[]>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async startTurn(input: StartTurnInput): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: input.turnId },
      select: { status: true },
    });
    if (!turn || TERMINAL_STATUSES.has(turn.status)) {
      return;
    }

    await this.prisma.turn.update({
      where: { id: input.turnId },
      data: { status: 'running', startedAt: new Date() },
    });
    await this.appendEvent(input.turnId, 'turn.started', {});

    const assistantText = `Echo: ${input.content}`;
    const chunks = chunkText(assistantText, 12);
    const scheduled: ReturnType<typeof setTimeout>[] = [];

    chunks.forEach((chunk, index) => {
      const timer = setTimeout(() => {
        void this.handleDelta(input.turnId, chunk).catch((error: unknown) => {
          this.logError('Failed to emit assistant delta event', error);
        });
      }, 120 + index * 120);
      scheduled.push(timer);
    });

    const finalizeDelay = 200 + chunks.length * 120;
    const finalizeTimer = setTimeout(() => {
      void this.finalizeTurn(input.turnId, assistantText).catch((error: unknown) => {
        this.logError('Failed to finalize turn', error);
      });
    }, finalizeDelay);
    scheduled.push(finalizeTimer);

    // Keep track so cancel can interrupt in-flight mock execution.
    this.timers.set(input.turnId, scheduled);
  }

  async cancelTurn(input: CancelTurnInput): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: input.turnId },
      select: { status: true },
    });
    if (!turn || TERMINAL_STATUSES.has(turn.status)) {
      return;
    }

    this.clearTurnTimers(input.turnId);

    await this.prisma.turn.update({
      where: { id: input.turnId },
      data: { status: 'cancelled', endedAt: new Date() },
    });
    await this.appendEvent(input.turnId, 'turn.cancelled', {});
  }

  private async handleDelta(turnId: string, chunk: string): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: { status: true },
    });
    if (!turn || TERMINAL_STATUSES.has(turn.status)) {
      return;
    }

    await this.appendEvent(turnId, 'assistant.delta', { text: chunk });
  }

  private async finalizeTurn(turnId: string, content: string): Promise<void> {
    const turn = await this.prisma.turn.findUnique({
      where: { id: turnId },
      select: { status: true, sessionId: true },
    });
    if (!turn || TERMINAL_STATUSES.has(turn.status)) {
      this.clearTurnTimers(turnId);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const assistantMessage = await tx.message.create({
        data: {
          sessionId: turn.sessionId,
          role: 'assistant',
          content,
        },
      });

      await tx.turn.update({
        where: { id: turnId },
        data: {
          assistantMessageId: assistantMessage.id,
          status: 'completed',
          endedAt: new Date(),
        },
      });
    });

    await this.appendEvent(turnId, 'turn.completed', {});
    this.clearTurnTimers(turnId);
  }

  private async appendEvent(turnId: string, type: string, payload: Prisma.InputJsonValue): Promise<void> {
    const latest = await this.prisma.event.findFirst({
      where: { turnId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });

    await this.prisma.event.create({
      data: {
        turnId,
        seq: (latest?.seq ?? 0) + 1,
        type,
        payload,
      },
    });
  }

  private clearTurnTimers(turnId: string): void {
    const pending = this.timers.get(turnId);
    if (!pending) {
      return;
    }
    pending.forEach((timer) => clearTimeout(timer));
    this.timers.delete(turnId);
  }

  private logError(message: string, error: unknown): void {
    if (error instanceof Error) {
      this.logger.error(message, error.stack);
      return;
    }
    this.logger.error(message);
  }
}

function chunkText(text: string, size: number): string[] {
  if (!text) {
    return [''];
  }

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}
