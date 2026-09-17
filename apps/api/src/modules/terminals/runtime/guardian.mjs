// This process owns no PTY and no recoverable terminal state. IPC EOF from the
// API is the crash signal; it survives the API's death solely to clean up.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const entries = new Map();
const directory =
  process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'aw-terminal-'));
const socketPath = directory
  ? path.join(directory, 'guardian.sock')
  : `\\\\.\\pipe\\aw-terminal-${randomUUID()}`;
let stopping = false;
let sampling = false;

async function processes() {
  if (process.platform === 'win32') return [];
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pgid=,sess=,stat='], {
    timeout: 3000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, pgid, session, state] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), session, state };
    });
}

function identity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    if (process.platform === 'darwin') {
      return (
        execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined
      );
    }
    // A start-time fingerprint prevents taskkill from targeting a reused PID.
    // The command includes only our validated integer, never user shell input.
    return (
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function remember(entry, rows) {
  if (!entry.pid) return;
  // Do not discover a new process tree under a reused PID.
  if (
    identity(entry.pid) !== undefined &&
    entry.known.has(entry.pid) &&
    identity(entry.pid) !== entry.known.get(entry.pid)
  )
    return;
  const root = rows.find((row) => row.pid === entry.pid);
  if (root && root.session !== '0' && root.session !== '-') entry.session ??= root.session;
  const descendants = new Set([entry.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (
        !descendants.has(row.pid) &&
        (descendants.has(row.ppid) || (entry.session && row.session === entry.session))
      ) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  for (const pid of descendants) {
    if (pid > 1 && pid !== process.pid) {
      const start = identity(pid);
      if (start !== undefined) entry.known.set(pid, start);
    }
  }
}

async function sample() {
  if (sampling || stopping || process.platform === 'win32') return;
  sampling = true;
  try {
    const rows = await processes();
    for (const entry of entries.values()) remember(entry, rows);
  } catch {
    /* A close retries discovery and reports failure to the API. */
  } finally {
    sampling = false;
  }
}

function signalKnown(entry, signal) {
  for (const [pid, start] of [...entry.known].reverse()) {
    if (identity(pid) !== start) continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

async function cleanup(entry) {
  if (entry.closing) return entry.closing;
  entry.closing = (async () => {
    if (!entry.pid) return;
    if (process.platform === 'win32') {
      if (identity(entry.pid) !== entry.known.get(entry.pid)) return;
      // Use an argument array, never a command string containing shell input.
      try {
        await run('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F'], { timeout: 10_000 });
      } catch (error) {
        if (error.code !== 128) throw error;
      }
      return;
    }
    remember(entry, await processes());
    signalKnown(entry, 'SIGCONT');
    signalKnown(entry, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    remember(entry, await processes());
    signalKnown(entry, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (true) {
      const rows = await processes();
      const alive = rows.some(
        (row) =>
          entry.known.has(row.pid) &&
          !row.state?.startsWith('Z') &&
          identity(row.pid) === entry.known.get(row.pid),
      );
      if (!alive) break;
      if (Date.now() >= deadline) throw new Error('Terminal processes did not exit after SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  try {
    await entry.closing;
  } catch (error) {
    entry.closing = null;
    throw error;
  }
}

const server = net.createServer((socket) => {
  socket.setTimeout(5000, () => socket.destroy());
  let body = '';
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > 4096) return socket.destroy();
    if (!body.includes('\n')) return;
    try {
      const { id, token, pid } = JSON.parse(body.slice(0, body.indexOf('\n')));
      const entry = entries.get(id);
      if (
        stopping ||
        !process.connected ||
        !entry ||
        entry.token !== token ||
        entry.pid ||
        !Number.isInteger(pid) ||
        pid <= 1
      ) {
        socket.destroy();
        return;
      }
      const start = identity(pid);
      if (start === undefined) {
        socket.destroy();
        return;
      }
      entry.pid = pid;
      entry.known.set(pid, start);
      // A Linux PTY's session ID equals the spawn root even if it exits before
      // the next ps sample; this also finds orphaned foreground job groups.
      if (process.platform === 'linux') entry.session = String(pid);
      process.send?.({ type: 'registered', id, pid });
      socket.end('ok\n');
      void sample();
    } catch {
      socket.destroy();
    }
  });
});

const timer = setInterval(() => void sample(), 1000);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close();
  const results = await Promise.allSettled([...entries.values()].map(cleanup));
  if (directory) {
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    try {
      fs.rmdirSync(directory);
    } catch {}
  }
  process.exit(results.some((result) => result.status === 'rejected') ? 1 : 0);
}
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.on('message', (message) => {
  if (message.type === 'prepare' && !stopping) {
    entries.set(message.id, {
      token: message.token,
      pid: null,
      session: null,
      known: new Map(),
      closing: null,
    });
    process.send?.({ type: 'prepared', id: message.id });
  }
  if (message.type === 'close') {
    const entry = entries.get(message.id);
    void (entry ? cleanup(entry) : Promise.resolve()).then(
      () => {
        entries.delete(message.id);
        if (process.connected) process.send?.({ type: 'closed', id: message.id });
      },
      (error) => {
        if (process.connected)
          process.send?.({ type: 'error', id: message.id, message: error.message });
      },
    );
  }
  if (message.type === 'shutdown') void stop();
});
server.listen(socketPath, async () => {
  try {
    if (process.platform === 'win32') {
      if (identity(process.pid) === undefined)
        throw new Error('Windows PowerShell process identity checks are unavailable');
      await run('taskkill.exe', ['/?'], { timeout: 5000 });
    } else if (!(await processes()).some((row) => row.pid === process.pid)) {
      throw new Error('Unable to inspect processes with ps');
    }
    process.send?.({ type: 'ready', socketPath });
  } catch (error) {
    process.stderr.write(`Terminal guardian unavailable: ${error.message}\n`);
    void stop();
  }
});
server.on('error', (error) => {
  process.stderr.write(`Terminal guardian: ${error.message}\n`);
  void stop();
});
