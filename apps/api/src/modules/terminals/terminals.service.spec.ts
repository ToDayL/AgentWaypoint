import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { TerminalsService, UNATTACHED_TIMEOUT_MS, SWEEP_INTERVAL_MS } from './terminals.service';
import { TerminalProcessFactory, type TerminalProcess } from './terminal-process';
import type { PrismaService } from '../prisma/prisma.service';
import { terminalLifecycle } from './terminal-lifecycle';

class FakeProcess implements TerminalProcess {
  write = vi.fn();
  resize = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  close = vi.fn(async () => {});
  data = (_data: string) => {};
  exit = (_event: { exitCode: number }) => {};
  onData(listener: (data: string) => void) {
    this.data = listener;
    return { dispose() {} };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exit = listener;
    return { dispose() {} };
  }
}

const services: TerminalsService[] = [];
function setup() {
  vi.stubEnv('RUNNER_MODE', 'embedded');
  let now = 0;
  const processes: FakeProcess[] = [];
  const factory = {
    spawn: vi.fn(async () => {
      const pty = new FakeProcess();
      processes.push(pty);
      return pty;
    }),
    shutdown: vi.fn(async () => {}),
  };
  const prisma = {
    session: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.project.ownerUserId === 'owner'
          ? {
              id: where.id,
              projectId: 'project',
              meta: { runtime: { cwd: tmpdir() } },
              project: { repoPath: tmpdir() },
            }
          : null,
      ),
    },
  };
  const service = new TerminalsService(
    prisma as unknown as PrismaService,
    factory as unknown as TerminalProcessFactory,
    { now: () => now, date: () => new Date(now).toISOString() },
  );
  services.push(service);
  const create = (ensure = false, request = randomUUID()) =>
    service.create('owner', 'session', { requestId: request, cols: 80, rows: 24 }, ensure);
  return {
    service,
    processes,
    factory,
    create,
    setTime: (value: number) => {
      now = value;
    },
  };
}
function peer(id: string) {
  return { id, send: vi.fn(), disconnect: vi.fn() };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.onModuleDestroy();
  expect(terminalLifecycle.resources.size).toBe(0);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('session terminal lifetime', () => {
  it('runs one sweep per hour and cancels it at shutdown', async () => {
    vi.useFakeTimers();
    const { service, create, processes, setTime } = setup();
    await create();
    service.onModuleInit();
    for (let hour = 1; hour <= 11; hour++) {
      setTime(hour * SWEEP_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    }
    expect(processes[0]!.close).not.toHaveBeenCalled();
    setTime(UNATTACHED_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(processes[0]!.close).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ensures atomically, creates multiple explicit tabs, and deduplicates retries', async () => {
    const { create, factory } = setup();
    const [first, second] = await Promise.all([create(true), create(true)]);
    expect(first.id).toBe(second.id);
    const request = randomUUID();
    const next = await create(false, request);
    expect(next.id).not.toBe(first.id);
    expect((await create(false, request)).id).toBe(next.id);
    expect(factory.spawn).toHaveBeenCalledTimes(2);
  });

  it('closes a never-attached terminal only once it has been unattached for 12 hours', async () => {
    const { service, create, processes, setTime } = setup();
    const terminal = await create();
    setTime(UNATTACHED_TIMEOUT_MS - 1);
    await service.sweep();
    expect(processes[0]!.close).not.toHaveBeenCalled();
    setTime(UNATTACHED_TIMEOUT_MS);
    await service.sweep();
    expect(processes[0]!.close).toHaveBeenCalledTimes(1);
    expect((await service.list('owner', 'session')).terminals[0]).toMatchObject({
      id: terminal.id,
      state: 'exited',
      closeReason: 'unattached_timeout',
    });
    await service.sweep();
    expect(processes[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('counts readonly peers, resets on reconnect, and ignores duplicate disconnects', async () => {
    const { service, create, processes, setTime } = setup();
    const terminal = await create();
    await service.attach('owner', terminal.id, peer('writer'));
    await service.attach('owner', terminal.id, peer('viewer'));
    service.detach('owner', terminal.id, 'writer');
    setTime(UNATTACHED_TIMEOUT_MS * 2);
    await service.sweep();
    expect(processes[0]!.close).not.toHaveBeenCalled();
    service.detach('owner', terminal.id, 'viewer');
    setTime(UNATTACHED_TIMEOUT_MS * 3 - 1);
    service.detach('owner', terminal.id, 'viewer');
    await service.sweep();
    await service.attach('owner', terminal.id, peer('new'));
    service.detach('owner', terminal.id, 'new');
    setTime(UNATTACHED_TIMEOUT_MS * 4 - 2);
    await service.sweep();
    expect(processes[0]!.close).not.toHaveBeenCalled();
    setTime(UNATTACHED_TIMEOUT_MS * 4 - 1);
    await service.sweep();
    expect(processes[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('does not extend retention for background output or list requests', async () => {
    const { service, create, processes, setTime } = setup();
    const terminal = await create();
    setTime(UNATTACHED_TIMEOUT_MS);
    processes[0]!.data('still working\r\n');
    await service.list('owner', 'session');
    await service.sweep();
    expect(service.get('owner', terminal.id).meta.closeReason).toBe('unattached_timeout');
  });

  it('rejects another owner, readonly input and reattach after closing starts', async () => {
    const { service, create, processes } = setup();
    const terminal = await create();
    expect(() => service.get('stranger', terminal.id)).toThrow();
    await service.attach('owner', terminal.id, peer('writer'));
    await service.attach('owner', terminal.id, peer('viewer'));
    expect(() => service.input('owner', terminal.id, 'viewer', 'bad')).toThrow();
    service.takeControl('owner', terminal.id, 'viewer');
    service.input('owner', terminal.id, 'viewer', 'ok');
    expect(processes[0]!.write).toHaveBeenCalledWith('ok');
    const closing = service.close('owner', terminal.id);
    await expect(service.attach('owner', terminal.id, peer('late'))).rejects.toThrow('closing');
    await closing;
    expect((await service.list('owner', 'session')).terminals).toEqual([]);
  });

  it('blocks deletion while a PTY is active, and allows deleting exited metadata', async () => {
    const { service, create } = setup();
    const terminal = await create();
    expect(() => terminalLifecycle.assertDeletable('project', 'session')).toThrow();
    await service.close('owner', terminal.id, 'process_exit');
    expect(() => terminalLifecycle.assertDeletable('project', 'session')).not.toThrow();
    terminalLifecycle.discard('project', 'session');
    expect((await service.list('owner', 'session')).terminals).toEqual([]);
  });

  it('keeps rendering state for reconnect and does not respawn on natural exit', async () => {
    const { service, create, processes, factory } = setup();
    const terminal = await create();
    processes[0]!.data('\x1b[31mhello\x1b[0m\r\n');
    const viewer = peer('viewer');
    await service.attach('owner', terminal.id, viewer);
    expect(
      viewer.send.mock.calls.some(
        ([message]) => message.type === 'snapshot' && String(message.data).includes('hello'),
      ),
    ).toBe(true);
    processes[0]!.exit({ exitCode: 0 });
    await vi.waitFor(() => expect(service.get('owner', terminal.id).meta.state).toBe('exited'));
    expect(factory.spawn).toHaveBeenCalledTimes(1);
  });
});
