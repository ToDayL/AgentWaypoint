import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';

const CONFIG_FILENAME = 'config.json';
const DB_FILENAME = 'agentwaypoint.db';
const DEFAULT_API_PORT = '4000';
const DEFAULT_WEB_PORT = '3000';

export type AgentWaypointConfig = {
  AGENTWAYPOINT_HOME: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  AUTH_SESSION_COOKIE_NAME: string;
  API_PORT: string;
  WEB_PORT: string;
  DEFAULT_WORKSPACE_ROOT: string;
  RUNNER_MODE: string;
};

export type BootstrapOptions = {
  /** Override resolved home dir (e.g. from `--home <path>`). */
  home?: string | null;
  /** Force interactive prompts even when not a TTY (used only for testing). */
  forceInteractive?: boolean;
};

export type BootstrapResult = {
  config: AgentWaypointConfig;
  /** True when this run created the data dir for the first time. */
  created: boolean;
};

/**
 * Resolve `~/.agentwaypoint`, load existing config or interactively create one,
 * then export every config key into `process.env` so the rest of the API picks
 * them up. Safe to call multiple times.
 */
export async function ensureBootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const home = resolveHome(options.home ?? null);
  const configPath = path.join(home, CONFIG_FILENAME);

  if (fs.existsSync(configPath)) {
    const config = readConfig(configPath);
    applyToEnv(config);
    return { config, created: false };
  }

  const interactive = options.forceInteractive || isInteractive();
  if (!interactive) {
    process.stderr.write(
      `[agent-waypoint] No config at ${configPath} and stdin is not a TTY.\n` +
        `Run \`./agent-waypoint start\` from a terminal to bootstrap, or pre-seed ${configPath}.\n`,
    );
    process.exit(1);
  }

  const config = await runInteractiveBootstrap(home);
  applyToEnv(config);
  await runPrismaPush(config.DATABASE_URL);
  await createAdminUser(home);
  return { config, created: true };
}

function resolveHome(overrideArg: string | null): string {
  const candidate =
    overrideArg ??
    process.env.AGENTWAYPOINT_HOME ??
    path.join(os.homedir(), '.agentwaypoint');
  return path.resolve(candidate);
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function readConfig(configPath: string): AgentWaypointConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const required: (keyof AgentWaypointConfig)[] = [
    'AGENTWAYPOINT_HOME',
    'DATABASE_URL',
    'JWT_SECRET',
    'AUTH_SESSION_COOKIE_NAME',
    'API_PORT',
    'WEB_PORT',
    'DEFAULT_WORKSPACE_ROOT',
    'RUNNER_MODE',
  ];
  for (const key of required) {
    if (typeof parsed[key] !== 'string' || (parsed[key] as string).length === 0) {
      throw new Error(`Config at ${configPath} is missing required field: ${key}`);
    }
  }
  return parsed as AgentWaypointConfig;
}

function applyToEnv(config: AgentWaypointConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

async function runInteractiveBootstrap(defaultHome: string): Promise<AgentWaypointConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('\nWelcome to AgentWaypoint. First-run setup.\n\n');

    const home = path.resolve(
      (await rl.question(`Data directory [${defaultHome}]: `)).trim() || defaultHome,
    );
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(home, 'workspaces'), { recursive: true });

    const email = await promptUntil(
      rl,
      'Admin email: ',
      (raw) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim()),
      'Please enter a valid email address.',
    );
    const password = await promptMaskedUntil(
      rl,
      'Admin password (min 8 chars): ',
      (raw) => raw.length >= 8,
      'Password must be at least 8 characters.',
    );
    const displayName = (await rl.question('Display name [Admin]: ')).trim() || 'Admin';
    const apiPort = (await rl.question(`API port [${DEFAULT_API_PORT}]: `)).trim() || DEFAULT_API_PORT;
    const webPort = (await rl.question(`Web port [${DEFAULT_WEB_PORT}]: `)).trim() || DEFAULT_WEB_PORT;

    const config: AgentWaypointConfig = {
      AGENTWAYPOINT_HOME: home,
      DATABASE_URL: `file:${path.join(home, DB_FILENAME)}`,
      JWT_SECRET: randomBytes(32).toString('hex'),
      AUTH_SESSION_COOKIE_NAME: 'aw_session',
      API_PORT: apiPort,
      WEB_PORT: webPort,
      DEFAULT_WORKSPACE_ROOT: path.join(home, 'workspaces'),
      RUNNER_MODE: 'embedded',
    };

    const configPath = path.join(home, CONFIG_FILENAME);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

    // Stash admin creds for createAdminUser; cleared after use.
    process.env.__AW_BOOTSTRAP_ADMIN_EMAIL = email.trim().toLowerCase();
    process.env.__AW_BOOTSTRAP_ADMIN_PASSWORD = password;
    process.env.__AW_BOOTSTRAP_ADMIN_DISPLAY = displayName;

    process.stdout.write(`\nWrote config to ${configPath}\n`);
    return config;
  } finally {
    rl.close();
  }
}

async function promptUntil(
  rl: readline.Interface,
  question: string,
  validate: (raw: string) => boolean,
  errorMessage: string,
): Promise<string> {
  for (;;) {
    const raw = await rl.question(question);
    if (validate(raw)) {
      return raw;
    }
    process.stdout.write(`${errorMessage}\n`);
  }
}

async function promptMaskedUntil(
  rl: readline.Interface,
  question: string,
  validate: (raw: string) => boolean,
  errorMessage: string,
): Promise<string> {
  for (;;) {
    const raw = await askMasked(rl, question);
    if (validate(raw)) {
      return raw;
    }
    process.stdout.write(`${errorMessage}\n`);
  }
}

/**
 * Prompt via the existing readline interface but echo `*` instead of the
 * typed characters. Modern Node.js stores `_writeToOutput` as a Symbol on the
 * Interface prototype; we look it up by description so this works across
 * Node versions without relying on a stable internal Symbol export.
 */
function askMasked(rl: readline.Interface, prompt: string): Promise<string> {
  type WriteFn = (s: string) => void;
  const target = rl as unknown as Record<symbol, WriteFn | undefined>;
  const writeSymbol = findInternalSymbol(rl, '_writeToOutput');
  const existing = writeSymbol ? target[writeSymbol] : undefined;
  if (!writeSymbol || !existing) {
    // Fallback: no override possible — read plaintext.
    return rl.question(prompt);
  }
  const original: WriteFn = existing.bind(rl);
  let promptWritten = false;
  target[writeSymbol] = (s: string): void => {
    if (!promptWritten) {
      original(s);
      promptWritten = true;
      return;
    }
    if (s === '\n' || s === '\r\n' || s === '\r') {
      original(s);
      return;
    }
    original('*'.repeat(s.length));
  };
  return rl.question(prompt).finally(() => {
    target[writeSymbol] = original;
  });
}

function findInternalSymbol(target: object, description: string): symbol | null {
  let proto: object | null = target;
  while (proto) {
    for (const key of Reflect.ownKeys(proto)) {
      if (typeof key === 'symbol' && key.description === description) {
        return key;
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}


async function runPrismaPush(databaseUrl: string): Promise<void> {
  const repoRoot = findRepoRoot();
  const prismaSchema = path.join(repoRoot, 'apps/api/prisma/schema.prisma');
  if (!fs.existsSync(prismaSchema)) {
    throw new Error(`Cannot find Prisma schema at ${prismaSchema}`);
  }
  const result = spawnSync(
    'pnpm',
    ['--filter', '@agentwaypoint/api', 'exec', 'prisma', 'db', 'push', '--skip-generate'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
  if (result.status !== 0) {
    throw new Error(`prisma db push failed with status ${result.status}`);
  }
}

async function createAdminUser(home: string): Promise<void> {
  const email = process.env.__AW_BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.__AW_BOOTSTRAP_ADMIN_PASSWORD;
  const displayName = process.env.__AW_BOOTSTRAP_ADMIN_DISPLAY ?? 'Admin';
  if (!email || !password) {
    throw new Error('Missing admin credentials in environment after bootstrap');
  }

  // Defer imports so they pick up the freshly-set DATABASE_URL.
  const { PrismaClient } = await import('@prisma/client');
  const { hashPassword } = await import('../modules/auth/auth.service.js');

  const prisma = new PrismaClient();
  try {
    const passwordHash = await hashPassword(password);
    await prisma.user.upsert({
      where: { email },
      update: {
        displayName,
        isActive: true,
        role: 'admin',
        authPolicy: 'password_or_webauthn',
        passwordHash,
      },
      create: {
        email,
        displayName,
        isActive: true,
        role: 'admin',
        authPolicy: 'password_or_webauthn',
        passwordHash,
      },
    });
    process.stdout.write(`Created admin user ${email}.\n`);
  } finally {
    await prisma.$disconnect();
    delete process.env.__AW_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.__AW_BOOTSTRAP_ADMIN_PASSWORD;
    delete process.env.__AW_BOOTSTRAP_ADMIN_DISPLAY;
    void home;
  }
}

function findRepoRoot(): string {
  // The compiled bootstrap lives at apps/api/dist/bootstrap/local-bootstrap.js
  // or apps/api/src/bootstrap/local-bootstrap.ts during dev. Walk up looking
  // for pnpm-workspace.yaml.
  let dir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('Unable to locate repository root (pnpm-workspace.yaml not found)');
}
