import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { PrismaService } from '../prisma/prisma.service';
import { TerminalProcessFactory, type TerminalProcess } from './terminal-process';
import { terminalLifecycle } from './terminal-lifecycle';

export const UNATTACHED_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const TERMINAL_CLOCK = Symbol('TERMINAL_CLOCK');
export interface TerminalClock {
  now(): number;
  date(): string;
}
export type TerminalState = 'starting' | 'running' | 'closing' | 'exited' | 'failed';
export type CloseReason = 'user' | 'process_exit' | 'unattached_timeout' | 'api_shutdown';
export type TerminalMetadata = {
  id: string;
  apiInstanceId: string;
  sessionId: string;
  projectId: string;
  title: string;
  initialCwd: string;
  shell: string;
  state: TerminalState;
  cols: number;
  rows: number;
  createdAt: string;
  connectedClientCount: number;
  unattachedSince: string | null;
  exitCode?: number;
  closeReason?: CloseReason;
};
type Peer = {
  id: string;
  send: (message: Record<string, unknown>) => void;
  disconnect: () => void;
};
type Entry = {
  meta: TerminalMetadata;
  owner: string;
  process?: TerminalProcess;
  headless: HeadlessTerminal;
  serialize: SerializeAddon;
  peers: Map<string, Peer>;
  writer: string | null;
  unattachedSinceMono: number | null;
  seq: number;
  outputTail: Promise<void>;
  pendingBytes: number;
  closing?: Promise<void>;
};
const require = createRequire(import.meta.url);

@Injectable()
export class TerminalsService implements OnModuleInit, OnModuleDestroy {
  readonly apiInstanceId = randomUUID();
  private readonly logger = new Logger(TerminalsService.name);
  private readonly entries = new Map<string, Entry>();
  private readonly requests = new Map<string, { id: string; expires: number }>();
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  private stopping = false;
  private clock: TerminalClock;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TerminalProcessFactory) private readonly factory: TerminalProcessFactory,
    @Optional() @Inject(TERMINAL_CLOCK) clock?: TerminalClock,
  ) {
    this.clock = clock ?? { now: () => performance.now(), date: () => new Date().toISOString() };
  }

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.sweep().catch((error) => this.logger.error(error)),
      SWEEP_INTERVAL_MS,
    );
    this.timer.unref();
  }

  capabilities() {
    const enabled =
      (process.env.RUNNER_MODE ?? 'embedded') === 'embedded' &&
      ['linux', 'darwin', 'win32'].includes(process.platform);
    return {
      enabled,
      apiInstanceId: this.apiInstanceId,
      reason: enabled
        ? null
        : 'Terminal requires a local embedded runner on Linux, macOS or Windows',
      unattendedTimeoutMs: UNATTACHED_TIMEOUT_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
    };
  }

  private async session(userId: string, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, project: { ownerUserId: userId } },
      include: { project: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  async list(userId: string, sessionId: string) {
    await this.session(userId, sessionId);
    return {
      apiInstanceId: this.apiInstanceId,
      terminals: [...this.entries.values()]
        .filter((entry) => entry.owner === userId && entry.meta.sessionId === sessionId)
        .map((entry) => this.metadata(entry)),
    };
  }

  private metadata(entry: Entry): TerminalMetadata {
    return { ...entry.meta, connectedClientCount: entry.peers.size };
  }

  get(userId: string, id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== userId) throw new NotFoundException('Terminal not found');
    return entry;
  }

  async create(
    userId: string,
    sessionId: string,
    input: { requestId: string; cols: number; rows: number; preferredId?: string },
    ensure = false,
  ): Promise<TerminalMetadata> {
    const session = await this.session(userId, sessionId);
    return terminalLifecycle.withProject(session.projectId, async () => {
      const currentSession = await this.session(userId, sessionId);
      if (this.stopping || !this.capabilities().enabled)
        throw new ServiceUnavailableException('Terminal is unavailable');
      for (const [key, value] of this.requests)
        if (value.expires <= this.clock.now()) this.requests.delete(key);
      const requestKey = `${userId}:${sessionId}:${input.requestId}`;
      const existingId = this.requests.get(requestKey)?.id;
      if (existingId) {
        const existing = this.entries.get(existingId);
        if (!existing)
          throw new ConflictException(
            'This creation request has already completed; use a new requestId',
          );
        return this.metadata(existing);
      }
      const matching = [...this.entries.values()].filter(
        (entry) => entry.meta.sessionId === sessionId,
      );
      if (ensure) {
        const active = matching.filter((entry) =>
          ['starting', 'running'].includes(entry.meta.state),
        );
        const reuse = active.find((entry) => entry.meta.id === input.preferredId) ?? active[0];
        if (reuse) return this.metadata(reuse);
      }
      if (matching.length >= 16 || this.entries.size >= 128)
        throw new ConflictException('Terminal limit reached. Close unused tabs first.');
      const runtime = (currentSession.meta as { runtime?: { cwd?: unknown } } | null)?.runtime;
      const cwdValue = runtime?.cwd ?? currentSession.project.repoPath;
      if (typeof cwdValue !== 'string' || !cwdValue.trim())
        throw new BadRequestException('Session has no working directory');
      const cwd = path.resolve(cwdValue);
      try {
        if (!(await stat(cwd)).isDirectory()) throw new Error();
        await access(cwd, constants.R_OK | constants.X_OK);
      } catch {
        throw new BadRequestException(
          'Session working directory is not accessible on the API host',
        );
      }
      const shell =
        process.platform === 'win32'
          ? process.env.COMSPEC || 'cmd.exe'
          : process.env.SHELL || '/bin/bash';
      const args =
        process.platform === 'win32'
          ? []
          : ['bash', 'zsh'].includes(path.basename(shell))
            ? ['-il']
            : ['-i'];
      const id = randomUUID();
      const headless: HeadlessTerminal = new (require('@xterm/headless').Terminal)({
        cols: input.cols,
        rows: input.rows,
        scrollback: 2000,
        allowProposedApi: true,
      });
      const serialize: SerializeAddon = new (require('@xterm/addon-serialize').SerializeAddon)();
      headless.loadAddon(serialize);
      const entry: Entry = {
        meta: {
          id,
          apiInstanceId: this.apiInstanceId,
          sessionId,
          projectId: session.projectId,
          title: `Terminal ${matching.length + 1}`,
          initialCwd: cwd,
          shell,
          state: 'starting',
          cols: input.cols,
          rows: input.rows,
          createdAt: this.clock.date(),
          connectedClientCount: 0,
          unattachedSince: null,
        },
        owner: userId,
        headless,
        serialize,
        peers: new Map(),
        writer: null,
        unattachedSinceMono: null,
        seq: 0,
        outputTail: Promise.resolve(),
        pendingBytes: 0,
      };
      this.entries.set(id, entry);
      terminalLifecycle.resources.set(id, {
        projectId: session.projectId,
        sessionId,
        state: 'starting',
        dispose: () => this.dispose(entry),
      });
      try {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key, value]) =>
              value !== undefined &&
              !/^(JWT_SECRET|DATABASE_URL|AW_TERMINAL_|TERMINAL_INGRESS_KEY|NODE_OPTIONS)/.test(
                key,
              ),
          ),
        ) as Record<string, string>;
        entry.process = await this.factory.spawn(id, shell, args, {
          name: 'xterm-256color',
          cwd,
          cols: input.cols,
          rows: input.rows,
          env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        });
        this.state(entry, 'running');
        entry.unattachedSinceMono = this.clock.now();
        entry.meta.unattachedSince = this.clock.date();
        entry.process.onData((data) => this.output(entry, data));
        entry.process.onExit(({ exitCode }) => {
          entry.meta.exitCode = exitCode;
          if (entry.meta.state === 'running')
            void this.close(userId, id, 'process_exit').catch((error) => this.logger.error(error));
        });
        this.requests.set(requestKey, { id, expires: this.clock.now() + 5 * 60_000 });
        return this.metadata(entry);
      } catch (error) {
        this.dispose(entry);
        throw new ServiceUnavailableException(
          `Failed to start terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    });
  }

  private state(entry: Entry, state: TerminalState): void {
    entry.meta.state = state;
    const resource = terminalLifecycle.resources.get(entry.meta.id);
    if (resource) resource.state = state;
  }

  private output(entry: Entry, data: string): void {
    const bytes = Buffer.byteLength(data);
    entry.pendingBytes += bytes;
    if (entry.pendingBytes > 1024 * 1024) entry.process?.pause();
    entry.outputTail = entry.outputTail
      .then(
        () =>
          new Promise<void>((resolve) => {
            entry.headless.write(data, () => {
              entry.pendingBytes -= bytes;
              if (entry.pendingBytes < 256 * 1024) entry.process?.resume();
              this.broadcast(entry, { type: 'output', seq: ++entry.seq, data });
              resolve();
            });
          }),
      )
      .catch((error) => this.logger.error(error));
  }

  private broadcast(entry: Entry, message: Record<string, unknown>): void {
    for (const peer of entry.peers.values()) peer.send(message);
  }

  async attach(userId: string, id: string, peer: Peer): Promise<void> {
    const entry = this.get(userId, id);
    // This synchronous transition is shared with sweep's pre-close check.
    if (this.stopping || !['running', 'exited'].includes(entry.meta.state))
      throw new ConflictException('Terminal is closing');
    if (entry.peers.size >= 8) throw new ConflictException('Too many terminal connections');
    entry.peers.set(peer.id, peer);
    if (entry.meta.state === 'running') {
      entry.unattachedSinceMono = null;
      entry.meta.unattachedSince = null;
      entry.writer ??= peer.id;
    }
    // Queue snapshot at an exact output boundary. No live output is delivered
    // to this peer until ready; other peers are not paused.
    const send = peer.send;
    peer.send = () => {};
    entry.outputTail = entry.outputTail.then(() => {
      if (!entry.peers.has(peer.id)) return;
      send({
        type: 'ready',
        terminal: this.metadata(entry),
        writerId: entry.writer,
        connectionId: peer.id,
      });
      send({
        type: 'snapshot',
        seq: entry.seq,
        cols: entry.meta.cols,
        rows: entry.meta.rows,
        data: entry.serialize.serialize(),
      });
      peer.send = send;
      if (entry.meta.state === 'exited') send({ type: 'exit', terminal: this.metadata(entry) });
    });
    await entry.outputTail;
  }

  detach(userId: string, id: string, peerId: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== userId || !entry.peers.delete(peerId)) return;
    if (entry.writer === peerId) {
      entry.writer = null;
      this.broadcast(entry, { type: 'controlChanged', writerId: null });
    }
    if (entry.peers.size === 0 && entry.meta.state === 'running') {
      entry.unattachedSinceMono = this.clock.now();
      entry.meta.unattachedSince = this.clock.date();
    }
  }

  input(userId: string, id: string, peerId: string, data: string | Buffer): void {
    const entry = this.get(userId, id);
    if (entry.meta.state !== 'running' || entry.writer !== peerId || !entry.peers.has(peerId))
      throw new ConflictException('This connection does not control terminal input');
    entry.process!.write(data);
  }

  resize(userId: string, id: string, peerId: string, cols: number, rows: number): void {
    const entry = this.get(userId, id);
    if (entry.meta.state !== 'running' || entry.writer !== peerId) return;
    entry.outputTail = entry.outputTail
      .then(() => {
        if (entry.meta.state !== 'running' || entry.writer !== peerId) return;
        entry.process!.resize(cols, rows);
        entry.headless.resize(cols, rows);
        entry.meta.cols = cols;
        entry.meta.rows = rows;
        this.broadcast(entry, { type: 'resized', seq: ++entry.seq, cols, rows });
      })
      .catch((error) => this.logger.error(error));
  }

  takeControl(userId: string, id: string, peerId: string): void {
    const entry = this.get(userId, id);
    if (entry.meta.state !== 'running' || !entry.peers.has(peerId)) return;
    entry.writer = peerId;
    this.broadcast(entry, { type: 'controlChanged', writerId: peerId });
  }

  rename(userId: string, id: string, title: string): TerminalMetadata {
    const entry = this.get(userId, id);
    entry.meta.title = title;
    return this.metadata(entry);
  }

  async close(userId: string, id: string, reason: CloseReason = 'user'): Promise<void> {
    const entry = this.get(userId, id);
    if (entry.closing) {
      await entry.closing;
      if (reason === 'user') this.dispose(entry);
      return;
    }
    if (entry.meta.state === 'exited') {
      if (reason === 'user') this.dispose(entry);
      return;
    }
    // No await before marking closing: attach and sweep cannot interleave.
    this.state(entry, 'closing');
    entry.meta.closeReason = reason;
    entry.writer = null;
    this.broadcast(entry, { type: 'closing', reason });
    entry.closing = (async () => {
      await entry.process?.close();
      await entry.outputTail;
      this.state(entry, 'exited');
      entry.unattachedSinceMono = null;
      entry.meta.unattachedSince = null;
      this.broadcast(entry, { type: 'exit', terminal: this.metadata(entry) });
      for (const peer of entry.peers.values()) peer.disconnect();
      entry.peers.clear();
      if (reason === 'user' || reason === 'api_shutdown') this.dispose(entry);
    })();
    try {
      await entry.closing;
    } catch (error) {
      entry.closing = undefined;
      throw error;
    }
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      for (const entry of this.entries.values()) {
        if (this.stopping) break;
        const retry =
          entry.meta.state === 'closing' &&
          entry.meta.closeReason === 'unattached_timeout' &&
          !entry.closing;
        if (
          retry ||
          (entry.meta.state === 'running' &&
            entry.peers.size === 0 &&
            entry.unattachedSinceMono !== null &&
            this.clock.now() - entry.unattachedSinceMono >= UNATTACHED_TIMEOUT_MS)
        ) {
          try {
            await this.close(entry.owner, entry.meta.id, 'unattached_timeout');
          } catch (error) {
            this.logger.error(error);
          }
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  private dispose(entry: Entry): void {
    for (const peer of entry.peers.values()) peer.disconnect();
    entry.peers.clear();
    entry.headless.dispose();
    this.entries.delete(entry.meta.id);
    terminalLifecycle.resources.delete(entry.meta.id);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled(
      [...this.entries.values()].map((entry) =>
        this.close(entry.owner, entry.meta.id, 'api_shutdown'),
      ),
    );
    await this.factory.shutdown();
    for (const entry of this.entries.values()) this.dispose(entry);
  }
}
