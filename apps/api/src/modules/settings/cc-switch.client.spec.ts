import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from './settings.service.js';
import { CcSwitchClient, CcSwitchState, parseProviderList } from './cc-switch.client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RunnerAdapter } from '../runner/runner.types.js';

const providerTable = `
┌───┬────────────────┬─────────────────┐
│ ✓ ┆ codex-official ┆ OpenAI Official │
│   ┆ internal       ┆ Internal        │
└───┴────────────────┴─────────────────┘`;

function availableState(): CcSwitchState {
  return {
    available: true,
    canSwitch: true,
    reason: null,
    providers: {
      codex: [
        { id: 'codex-official', name: 'OpenAI Official', current: true },
        { id: 'internal', name: 'Internal', current: false },
      ],
      claude: [{ id: 'claude-official', name: 'Claude Official', current: true }],
    },
  };
}

function createProviderSwitchPrisma(activeTurn: { id: string } | null = null) {
  const control = {
    id: 'provider-switch',
    providerSwitchInProgress: false,
    providerSwitchOwner: null as string | null,
    providerSwitchLeaseExpires: null as Date | null,
  };
  const runtimeControl = {
    upsert: vi.fn().mockImplementation(async () => ({ ...control })),
    update: vi.fn().mockImplementation(async ({ data }: { data: Partial<typeof control> }) => {
      Object.assign(control, data);
      return { ...control };
    }),
    updateMany: vi.fn().mockImplementation(async ({ data }: { data: Partial<typeof control> }) => {
      Object.assign(control, data);
      return { count: 1 };
    }),
  };
  const turn = { findFirst: vi.fn().mockResolvedValue(activeTurn) };
  const tx = { runtimeControl, turn };
  return {
    turn,
    runtimeControl,
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaService;
}

describe('cc-switch integration', () => {
  it('parses provider tables without executing the CLI', () => {
    expect(parseProviderList(providerTable)).toEqual([
      { id: 'codex-official', name: 'OpenAI Official', current: true },
      { id: 'internal', name: 'Internal', current: false },
    ]);
  });

  it('switches with a fake client and resets workers only after a changed provider', async () => {
    const discover = vi.fn().mockResolvedValue(availableState());
    const switchProvider = vi.fn().mockResolvedValue(undefined);
    const resetWorkers = vi.fn().mockResolvedValue(undefined);
    const service = new SettingsService(
      createProviderSwitchPrisma(),
      { resetWorkers } as unknown as RunnerAdapter,
      { discover, switchProvider } as CcSwitchClient,
    );

    await expect(
      service.updateCcSwitchProviders({
        codexProviderId: 'internal',
        expectedCurrent: { codex: 'codex-official' },
      }),
    ).resolves.toMatchObject({ available: true });

    expect(switchProvider).toHaveBeenCalledTimes(1);
    expect(switchProvider).toHaveBeenCalledWith('codex', 'internal');
    expect(resetWorkers).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the fake client switch while any turn is active', async () => {
    const switchProvider = vi.fn();
    const service = new SettingsService(
      createProviderSwitchPrisma({ id: 'running-turn' }),
      { resetWorkers: vi.fn() } as unknown as RunnerAdapter,
      {
        discover: vi.fn().mockResolvedValue(availableState()),
        switchProvider,
      } as CcSwitchClient,
    );

    await expect(
      service.updateCcSwitchProviders({
        codexProviderId: 'internal',
        expectedCurrent: { codex: 'codex-official' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(switchProvider).not.toHaveBeenCalled();
  });

  it('does not reset the Codex worker when only Claude changes', async () => {
    const state = availableState();
    state.providers.claude.push({ id: 'claude-internal', name: 'Claude Internal', current: false });
    const resetWorkers = vi.fn();
    const service = new SettingsService(
      createProviderSwitchPrisma(),
      { resetWorkers } as unknown as RunnerAdapter,
      {
        discover: vi.fn().mockResolvedValue(state),
        switchProvider: vi.fn().mockResolvedValue(undefined),
      } as CcSwitchClient,
    );

    await service.updateCcSwitchProviders({
      claudeProviderId: 'claude-internal',
      expectedCurrent: { claude: 'claude-official' },
    });

    expect(resetWorkers).not.toHaveBeenCalled();
  });

  it('rejects stale expected providers without overwriting an external change', async () => {
    const switchProvider = vi.fn();
    const service = new SettingsService(
      createProviderSwitchPrisma(),
      { resetWorkers: vi.fn() } as unknown as RunnerAdapter,
      { discover: vi.fn().mockResolvedValue(availableState()), switchProvider } as CcSwitchClient,
    );

    await expect(
      service.updateCcSwitchProviders({
        codexProviderId: 'internal',
        expectedCurrent: { codex: 'different-provider' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(switchProvider).not.toHaveBeenCalled();
  });

  it('rejects turn creation while another API instance holds an unexpired switch lease', async () => {
    const service = new SettingsService(
      {} as PrismaService,
      {} as RunnerAdapter,
      {} as CcSwitchClient,
    );
    const tx = {
      runtimeControl: {
        upsert: vi.fn().mockResolvedValue({
          providerSwitchInProgress: true,
          providerSwitchLeaseExpires: new Date(Date.now() + 60_000),
        }),
        update: vi.fn(),
      },
    };

    await expect(service.assertProviderSwitchAllowsTurn(tx as never)).rejects.toMatchObject({ status: 409 });
  });
});
