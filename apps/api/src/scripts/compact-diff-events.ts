import { Prisma, PrismaClient } from '@prisma/client';
import { summarizeDiffPayload } from '../modules/turns/diff-payload';

const TERMINAL_OUTBOX_STATUSES = new Set(['sent', 'failed']);

type CliInput = {
  apply: boolean;
  turnId?: string;
  batchSize: number;
};

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const totals = { turns: 0, events: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0 };

  try {
    const turns = input.turnId
      ? [{ turnId: input.turnId }]
      : await prisma.event.groupBy({
          by: ['turnId'],
          where: { type: 'diff.updated' },
        });

    for (const { turnId } of turns) {
      const latest = await prisma.event.findFirst({
        where: { turnId, type: 'diff.updated' },
        orderBy: { seq: 'desc' },
        select: { seq: true, payload: true },
      });
      if (!latest) {
        continue;
      }
      totals.turns += 1;

      if (input.apply) {
        const latestPayload = latest.payload as Prisma.InputJsonValue;
        await prisma.$transaction(async (tx) => {
          const existing = await tx.turnDiffSnapshot.findUnique({
            where: { turnId },
            select: { eventSeq: true },
          });
          if (!existing || existing.eventSeq < latest.seq) {
            await tx.turnDiffSnapshot.upsert({
              where: { turnId },
              create: { turnId, eventSeq: latest.seq, payload: latestPayload },
              update: { eventSeq: latest.seq, payload: latestPayload },
            });
          }
        });
      }

      let cursor = 0;
      while (true) {
        const events = await prisma.event.findMany({
          where: { turnId, type: 'diff.updated', seq: { gt: cursor } },
          orderBy: { seq: 'asc' },
          take: input.batchSize,
          select: {
            id: true,
            seq: true,
            payload: true,
            botMessage: { select: { status: true } },
          },
        });
        if (events.length === 0) {
          break;
        }
        cursor = events.at(-1)?.seq ?? cursor;

        const compactable = events.filter(
          (event) => !event.botMessage || TERMINAL_OUTBOX_STATUSES.has(event.botMessage.status),
        );
        totals.skipped += events.length - compactable.length;
        const updates = compactable.map((event) => {
          const summary = summarizeDiffPayload(event.payload as Prisma.InputJsonValue);
          totals.events += 1;
          totals.bytesBefore += jsonSize(event.payload);
          totals.bytesAfter += jsonSize(summary);
          return { id: event.id, payload: summary };
        });

        if (input.apply && updates.length > 0) {
          await prisma.$transaction(
            updates.map((event) =>
              prisma.event.update({
                where: { id: event.id },
                data: { payload: event.payload },
              }),
            ),
          );
        }
      }
    }

    process.stdout.write(
      `${JSON.stringify({ mode: input.apply ? 'apply' : 'dry-run', ...totals }, null, 2)}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

function parseArgs(args: string[]): CliInput {
  let apply = false;
  let turnId: string | undefined;
  let batchSize = 50;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--turn') {
      turnId = requireValue(args, ++index, '--turn');
      continue;
    }
    if (argument === '--batch-size') {
      const value = Number.parseInt(requireValue(args, ++index, '--batch-size'), 10);
      if (!Number.isInteger(value) || value < 1 || value > 200) {
        throw new Error('--batch-size must be an integer between 1 and 200');
      }
      batchSize = value;
      continue;
    }
    if (argument === '--') {
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { apply, turnId, batchSize };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[agent-waypoint] ${message}\n`);
  process.exitCode = 1;
});
