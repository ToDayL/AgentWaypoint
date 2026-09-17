import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const children: ChildProcess[] = [];
const ownedPids: number[] = [];
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function start() {
  const child = fork(
    fileURLToPath(new URL('./__fixtures__/runtime-probe.mjs', import.meta.url)),
    [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  children.push(child);
  let errors = '';
  child.stderr?.on('data', (data) => {
    errors += data.toString();
  });
  const ready = await new Promise<{ pid: number; childPid: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`PTY probe timed out: ${errors}`)), 20_000);
    child.once('message', (message: any) => {
      clearTimeout(timeout);
      ownedPids.push(message.pid, message.childPid);
      resolve(message);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(`PTY probe exited: ${errors}`));
    });
  });
  return { child, ...ready };
}
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const pid of ownedPids.splice(0))
    if (running(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
});

describe.skipIf(process.platform !== 'linux')('real PTY cleanup without systemd/cgroups', () => {
  it('closes the shell and a background job through the guardian', async () => {
    const { child, pid, childPid } = await start();
    expect(running(pid)).toBe(true);
    expect(running(childPid)).toBe(true);
    child.send('close');
    await vi.waitFor(
      () => {
        expect(running(pid)).toBe(false);
        expect(running(childPid)).toBe(false);
      },
      { timeout: 8000 },
    );
  }, 30_000);

  it('cleans PTYs after the API process receives SIGKILL, without restarting it', async () => {
    const { child, pid, childPid } = await start();
    child.kill('SIGKILL');
    await vi.waitFor(
      () => {
        expect(running(pid)).toBe(false);
        expect(running(childPid)).toBe(false);
      },
      { timeout: 8000 },
    );
    expect(child.signalCode).toBe('SIGKILL');
  }, 30_000);
});
