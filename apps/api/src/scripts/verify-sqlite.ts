import { PrismaClient } from '@prisma/client';

const checkpoint = process.argv.includes('--checkpoint');
const prisma = new PrismaClient();

async function verify(): Promise<void> {
  try {
    if (checkpoint) {
      await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);');
    }

    const result = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA quick_check;');
    const isHealthy = result.length === 1 && Object.values(result[0] ?? {}).includes('ok');
    if (!isHealthy) {
      throw new Error(`SQLite quick_check failed: ${JSON.stringify(result)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void verify().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[agent-waypoint] ${message}\n`);
  process.exit(1);
});
