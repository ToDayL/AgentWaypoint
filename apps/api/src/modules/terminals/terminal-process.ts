import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IPty, IPtyForkOptions } from 'node-pty';

export interface TerminalProcess {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
  close(): Promise<void>;
}

export class TerminalProcessFactory {
  private guardian: ChildProcess | null = null;
  private ready: Promise<string> | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private readonly children = new Set<IPty>();
  private stopped = false;
  private readonly runtime = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime');

  async start(): Promise<string> {
    if (this.stopped) throw new Error('Terminal process manager has stopped');
    if (this.ready) return this.ready;
    if (process.platform !== 'win32' && typeof process.execve !== 'function')
      throw new Error('Terminal requires Node >= 22.15');
    const child = fork(path.join(this.runtime, 'guardian.mjs'), [], {
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    this.guardian = child;
    this.ready = this.wait('ready');
    child.on('message', (message: any) => {
      const key = message.type === 'ready' ? 'ready' : `${message.type}:${message.id}`;
      this.pending.get(key)?.resolve(message.socketPath ?? message.pid);
      if (message.type === 'error')
        this.pending.get(`closed:${message.id}`)?.reject(new Error(message.message));
    });
    const failed = () => {
      this.stopped = true;
      for (const pending of this.pending.values())
        pending.reject(new Error('Terminal cleanup guardian exited'));
      for (const pty of this.children) {
        try {
          pty.kill();
        } catch {}
      }
    };
    child.once('exit', failed);
    child.once('error', failed);
    return this.ready;
  }

  private wait(key: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Terminal guardian timeout: ${key}`));
      }, 15_000);
      this.pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          this.pending.delete(key);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(key);
          reject(error);
        },
      });
    });
  }

  async spawn(
    id: string,
    shell: string,
    args: string[],
    options: IPtyForkOptions,
  ): Promise<TerminalProcess> {
    const socket = await this.start();
    const token = randomBytes(32).toString('hex');
    const prepared = this.wait(`prepared:${id}`);
    this.guardian!.send({ type: 'prepare', id, token });
    await prepared;
    const registered = this.wait(`registered:${id}`);
    // Observe a possible spawn failure without an unhandled registration timeout.
    void registered.catch(() => {});
    let pty: IPty;
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number }) => void>();
    const initialOutput: string[] = [];
    let initialBytes = 0;
    let exited: { exitCode: number } | undefined;
    try {
      const nodePty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
      pty = nodePty.spawn(
        process.execPath,
        [path.join(this.runtime, 'pty-gate.mjs'), socket, id, token, shell, ...args],
        options,
      );
      this.children.add(pty);
      pty.onData((data) => {
        if (dataListeners.size) {
          for (const listener of dataListeners) listener(data);
        } else {
          initialOutput.push(data);
          initialBytes += Buffer.byteLength(data);
          if (initialBytes > 256 * 1024) pty.pause();
        }
      });
      pty.onExit((event) => {
        this.children.delete(pty);
        exited = event;
        for (const listener of exitListeners) listener(event);
      });
      const registeredPid = await registered;
      if (registeredPid !== pty.pid) throw new Error('Terminal guardian PID mismatch');
    } catch (error) {
      await this.close(id).catch(() => {});
      throw error;
    }
    return {
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      pause: () => pty.pause(),
      resume: () => pty.resume(),
      onData: (listener) => {
        dataListeners.add(listener);
        for (const data of initialOutput.splice(0)) listener(data);
        initialBytes = 0;
        pty.resume();
        return {
          dispose: () => {
            dataListeners.delete(listener);
          },
        };
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        if (exited) queueMicrotask(() => listener(exited!));
        return {
          dispose: () => {
            exitListeners.delete(listener);
          },
        };
      },
      close: async () => {
        await this.close(id);
        try {
          pty.kill();
        } catch {}
      },
    };
  }

  private async close(id: string): Promise<void> {
    if (!this.guardian?.connected) throw new Error('Terminal guardian unavailable');
    const done = this.wait(`closed:${id}`);
    this.guardian.send({ type: 'close', id });
    await done;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const child = this.guardian;
    if (!child?.connected) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.disconnect();
        resolve();
      }, 15_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.send({ type: 'shutdown' });
    });
  }
}
