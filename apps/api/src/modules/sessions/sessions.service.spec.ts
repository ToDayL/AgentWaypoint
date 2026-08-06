import { describe, expect, it, vi } from 'vitest';
import { SessionsService } from './sessions.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ProjectsService } from '../projects/projects.service.js';
import type { RunnerAdapter } from '../runner/runner.types.js';

function sessionWithModel(model: string) {
  return {
    id: 'session-1',
    meta: {
      runtime: {
        backend: 'codex',
        cwd: null,
        backendConfig: { model, executionMode: 'safe-write' },
        autoApprove: false,
        autoApproveTimeoutSeconds: 10,
      },
      override: {},
    },
  };
}

describe('session model updates', () => {
  it('rejects a model change when the session model has disappeared from the live list', async () => {
    const update = vi.fn();
    const listModels = vi.fn().mockResolvedValue([{ model: 'available-model' }]);
    const service = new SessionsService(
      {
        session: {
          findFirst: vi.fn().mockResolvedValue(sessionWithModel('retired-model')),
          update,
        },
      } as unknown as PrismaService,
      {} as ProjectsService,
      { listModels } as unknown as RunnerAdapter,
    );

    await expect(
      service.updateByIdForUser('user-1', 'session-1', {
        backendConfig: {
          model: 'available-model',
          executionMode: 'safe-write',
        },
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(listModels).toHaveBeenCalledWith({ backend: 'codex' });
    expect(update).not.toHaveBeenCalled();
  });
});
