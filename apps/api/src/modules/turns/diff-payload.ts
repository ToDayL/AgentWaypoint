import { Prisma } from '@prisma/client';

export function summarizeDiffPayload(payload: Prisma.InputJsonValue): Prisma.InputJsonValue {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { diffAvailable: false, files: [] };
  }
  const record = payload as Record<string, unknown>;
  const diffText =
    (typeof record.unifiedDiff === 'string' && record.unifiedDiff) ||
    (typeof record.diff === 'string' && record.diff) ||
    '';
  const files = extractDiffFilePaths(record.files, diffText);
  const summary: Record<string, Prisma.InputJsonValue> = {
    diffAvailable: record.diffAvailable === true || diffText.length > 0,
    files,
    snapshotAvailable: true,
  };
  if (record.diffStat && typeof record.diffStat === 'object') {
    summary.diffStat = JSON.parse(JSON.stringify(record.diffStat)) as Prisma.InputJsonValue;
  }
  return summary as Prisma.InputJsonValue;
}

function extractDiffFilePaths(filesValue: unknown, diffText: string): string[] {
  const files: string[] = [];
  if (Array.isArray(filesValue)) {
    for (const entry of filesValue) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        files.push(entry.trim());
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const path = [record.path, record.newPath, record.oldPath].find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
      );
      if (path) {
        files.push(path.trim());
      }
    }
  }
  if (files.length === 0 && diffText.length > 0) {
    for (const line of diffText.split('\n')) {
      const match = line.match(/^\+\+\+\s+b\/(.+)$/);
      if (match?.[1]) {
        files.push(match[1].trim());
      }
    }
  }
  return Array.from(new Set(files));
}
