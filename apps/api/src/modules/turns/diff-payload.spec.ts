import { describe, expect, it } from 'vitest';
import { summarizeDiffPayload } from './diff-payload';

describe('summarizeDiffPayload', () => {
  it('keeps bounded metadata and removes cumulative diff text and file lists', () => {
    expect(
      summarizeDiffPayload({
        diffAvailable: true,
        unifiedDiff: '--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new',
        diffStat: { filesChanged: 1 },
      }),
    ).toEqual({
      diffAvailable: true,
      snapshotAvailable: true,
      diffStat: { filesChanged: 1 },
    });
  });

  it('drops structured file entries', () => {
    expect(
      summarizeDiffPayload({
        files: [{ oldPath: 'old.ts', newPath: 'new.ts' }, 'other.ts'],
        unifiedDiff: 'large diff omitted from summary',
      }),
    ).toEqual({
      diffAvailable: true,
      snapshotAvailable: true,
    });
  });
});
