import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export type SqliteTestDatabase = {
  home: string;
  databaseUrl: string;
  defaultWorkspaceRoot: string;
  cleanup: () => Promise<void>;
};

export async function setupSqliteTestDatabase(prefix: string): Promise<SqliteTestDatabase> {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const defaultWorkspaceRoot = path.join(home, 'workspaces');
  const databaseUrl = `file:${path.join(home, 'agentwaypoint-test.db')}`;

  await mkdir(defaultWorkspaceRoot, { recursive: true });
  process.env.AGENTWAYPOINT_HOME = home;
  process.env.DATABASE_URL = databaseUrl;
  process.env.DEFAULT_WORKSPACE_ROOT = defaultWorkspaceRoot;

  runPnpm(['--filter', '@agentwaypoint/api', 'exec', 'prisma', 'db', 'push', '--skip-generate'], {
    DATABASE_URL: databaseUrl,
  });

  return {
    home,
    databaseUrl,
    defaultWorkspaceRoot,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

export function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

function runPnpm(args: string[], env: Record<string, string>): void {
  const repoRoot = findRepoRoot();
  const candidates: Array<{ command: string; args: string[] }> = [];
  if (process.env.npm_execpath) {
    candidates.push({ command: process.execPath, args: [process.env.npm_execpath, ...args] });
  }
  candidates.push({ command: 'pnpm', args });
  candidates.push({ command: 'corepack', args: ['pnpm', ...args] });

  let lastFailure = 'pnpm was not found';
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
      lastFailure = `${candidate.command} not found`;
      continue;
    }
    if (result.status === 0) {
      return;
    }
    lastFailure = `${candidate.command} exited with status ${result.status}`;
    break;
  }

  throw new Error(`Failed to prepare SQLite test database: ${lastFailure}`);
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const workspacePath = path.join(dir, 'pnpm-workspace.yaml');
    if (existsSync(workspacePath)) {
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
