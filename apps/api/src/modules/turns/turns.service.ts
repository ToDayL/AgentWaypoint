import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_ADAPTER, RunnerAdapter } from '../runner/runner.types';
import { CreateTurnBody } from './turns.schemas';

const ACTIVE_TURN_STATUSES = ['queued', 'running'];

@Injectable()
export class TurnsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNNER_ADAPTER) private readonly runnerAdapter: RunnerAdapter,
  ) {}

  async createTurnForSession(userId: string, sessionId: string, input: CreateTurnBody) {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        project: {
          ownerUserId: userId,
        },
      },
      select: { id: true },
    });
    if (!session) {
      throw new NotFoundException({ message: 'Session not found' });
    }

    const activeTurn = await this.prisma.turn.findFirst({
      where: {
        sessionId,
        status: { in: ACTIVE_TURN_STATUSES },
      },
      select: { id: true },
    });
    if (activeTurn) {
      throw new ConflictException({ message: 'An active turn already exists for this session' });
    }

    const turn = await this.prisma.$transaction(async (tx) => {
      const userMessage = await tx.message.create({
        data: {
          sessionId,
          role: 'user',
          content: input.content,
        },
      });

      return tx.turn.create({
        data: {
          sessionId,
          userMessageId: userMessage.id,
          status: 'queued',
        },
      });
    });

    void this.runnerAdapter.startTurn({
      turnId: turn.id,
      sessionId,
      content: input.content,
    });

    return {
      turnId: turn.id,
      status: turn.status,
    };
  }

  async cancelTurnForUser(userId: string, turnId: string) {
    await this.getTurnForUser(userId, turnId);
    await this.runnerAdapter.cancelTurn({ turnId });

    return this.prisma.turn.findUnique({
      where: { id: turnId },
    });
  }

  async getEventsForTurn(userId: string, turnId: string, sinceSeq: number) {
    await this.getTurnForUser(userId, turnId);
    return this.prisma.event.findMany({
      where: {
        turnId,
        seq: {
          gt: sinceSeq,
        },
      },
      orderBy: { seq: 'asc' },
    });
  }

  async getTurnForUser(userId: string, turnId: string) {
    const turn = await this.prisma.turn.findFirst({
      where: {
        id: turnId,
        session: {
          project: {
            ownerUserId: userId,
          },
        },
      },
    });

    if (!turn) {
      throw new NotFoundException({ message: 'Turn not found' });
    }

    return turn;
  }
}
