import { PrismaClient } from '@prisma/client';

const mode = process.argv.find((argument) => argument.startsWith('--'))?.slice(2) ?? 'quick-check';
const prisma = new PrismaClient();

async function verify(): Promise<void> {
  try {
    if (mode === 'probe') {
      await prisma.$queryRawUnsafe('SELECT count(*) FROM sqlite_master;');
      return;
    }

    if (mode === 'checkpoint') {
      const result = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA wal_checkpoint(TRUNCATE);');
      const values = Object.values(result[0] ?? {}).map(Number);
      if (result.length !== 1 || values.length !== 3 || values.some((value) => !Number.isInteger(value))) {
        throw new Error(`Unexpected SQLite checkpoint result: ${JSON.stringify(result)}`);
      }
      const [busy, logPages, checkpointedPages] = values;
      const truncated = busy === 0 && logPages === 0 && checkpointedPages === 0;
      const notInWalMode = busy === 0 && logPages === -1 && checkpointedPages === -1;
      if (!truncated && !notInWalMode) {
        throw new Error(
          `SQLite WAL checkpoint did not truncate completely ` +
            `(busy=${busy}, log=${logPages}, checkpointed=${checkpointedPages})`,
        );
      }
      return;
    }

    if (mode === 'quick-check') {
      const result = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA quick_check;');
      const isHealthy = result.length === 1 && Object.values(result[0] ?? {}).includes('ok');
      if (!isHealthy) {
        throw new Error(`SQLite quick_check failed: ${JSON.stringify(result)}`);
      }
      return;
    }

    throw new Error(`Unknown SQLite verification mode: ${mode}`);
  } finally {
    await prisma.$disconnect();
  }
}

void verify().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[agent-waypoint] ${message}\n`);
  process.exit(1);
});
