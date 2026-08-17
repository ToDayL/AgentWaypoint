import { Prisma } from '@prisma/client';

export function summarizeDiffPayload(payload: Prisma.InputJsonValue): Prisma.InputJsonValue {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { diffAvailable: false, snapshotAvailable: true };
  }
  const record = payload as Record<string, unknown>;
  const diffText =
    (typeof record.unifiedDiff === 'string' && record.unifiedDiff) ||
    (typeof record.diff === 'string' && record.diff) ||
    '';
  const summary: Record<string, Prisma.InputJsonValue> = {
    diffAvailable: record.diffAvailable === true || diffText.length > 0,
    snapshotAvailable: true,
  };
  if (record.diffStat && typeof record.diffStat === 'object') {
    summary.diffStat = JSON.parse(JSON.stringify(record.diffStat)) as Prisma.InputJsonValue;
  }
  return summary as Prisma.InputJsonValue;
}
