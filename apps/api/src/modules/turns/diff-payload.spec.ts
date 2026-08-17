import { describe, expect, it } from 'vitest';
import { summarizeDiffPayload } from './diff-payload';

describe('summarizeDiffPayload', () => {
  it('keeps metadata and removes cumulative diff text', () => {
    expect(
      summarizeDiffPayload({
        diffAvailable: true,
        unifiedDiff: '--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new',
        diffStat: { filesChanged: 1 },
      }),
    ).toEqual({
      diffAvailable: true,
      files: ['new.ts'],
      snapshotAvailable: true,
      diffStat: { filesChanged: 1 },
    });
  });

  it('normalizes structured file entries to paths', () => {
    expect(
      summarizeDiffPayload({
        files: [{ oldPath: 'old.ts', newPath: 'new.ts' }, 'other.ts'],
        unifiedDiff: 'large diff omitted from summary',
      }),
    ).toMatchObject({
      files: ['new.ts', 'other.ts'],
      snapshotAvailable: true,
    });
  });
});
