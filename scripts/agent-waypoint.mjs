#!/usr/bin/env node
/**
 * agent-waypoint CLI: start | stop | restart | status | logs | cleanup-db
 *
 * Manages the lightweight AgentWaypoint stack (API + Next.js Web) as
 * background processes. All state lives under the data directory
 * (default ~/.agentwaypoint/, override with --home <path>).
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageManager = resolvePackageManager();

const args = process.argv.slice(2);
const { command, home: homeOverride, commandArgs, rebuild: forceRebuild } = parseArgs(args);

if (!command) {
  printUsage();
  process.exit(1);
}

const dataHome = resolveDataHome(homeOverride);
const pidFile = path.join(dataHome, 'agent-waypoint.pid');
const logsDir = path.join(dataHome, 'logs');
const apiLog = path.join(logsDir, 'api.log');
const webLog = path.join(logsDir, 'web.log');
const STARTUP_TIMEOUT_MS = 60_000;

switch (command) {
  case 'start':
    await cmdStart();
    break;
  case 'stop':
    await cmdStop();
    break;
  case 'restart':
    await cmdStop();
    await cmdStart();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'logs':
    cmdLogs(commandArgs);
    break;
  case 'cleanup-db':
    await cmdCleanupDb();
    break;
  case 'help':
  case '--help':
  case '-h':
    printUsage();
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n`);
    printUsage();
    process.exit(1);
}

function parseArgs(input) {
  const out = { command: null, home: null, commandArgs: [], rebuild: false };
  const positional = [];
  for (let i = 0; i < input.length; i += 1) {
    const arg = input[i];
    if (arg === '--home') {
      out.home = input[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--home=')) {
      out.home = arg.slice('--home='.length);
    } else if (arg === '--rebuild') {
      out.rebuild = true;
    } else {
      positional.push(arg);
    }
  }
  out.command = positional[0] ?? null;
  out.commandArgs = positional.slice(1);
  return out;
}

function resolveDataHome(override) {
  const candidate =
    override ??
    process.env.AGENTWAYPOINT_HOME ??
    path.join(os.homedir(), '.agentwaypoint');
  return path.resolve(candidate);
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: agent-waypoint <command> [--home <dir>] [--rebuild]',
      '',
      'Commands:',
      '  start     Bootstrap (if needed) and launch API + Web in the background.',
      '  stop      Stop the running services.',
      '  restart   Stop, then start.',
      '  status    Show running PIDs and URL.',
      '  logs [api|web]  Tail the named service log (default: api).',
      '  cleanup-db  Backup, VACUUM/optimize the SQLite DB, then delete the backup.',
      '',
      'Options:',
      '  --home <dir>  Override the data directory (default: $AGENTWAYPOINT_HOME or ~/.agentwaypoint).',
      '  --rebuild     Force a web rebuild before start/restart.',
      '',
    ].join('\n'),
  );
}

async function cmdStart() {
  const existing = readPidFile();
  if (existing && bothAlive(existing)) {
    process.stdout.write(
      `AgentWaypoint already running (api=${existing.apiPid}, web=${existing.webPid}).\n` +
        `URL: ${webUrl(existing.listenIp, existing.webPort)}\n`,
    );
    return;
  }
  if (existing) {
    // Stale PID file; clean it up before starting fresh.
    fs.rmSync(pidFile, { force: true });
  }

  // Run bootstrap synchronously in the foreground so prompts work.
  ensureDirs();
  const config = await runBootstrapForeground();

  ensureWebBuild({ force: forceRebuild });

  const apiCmd = pnpmCommand(['--filter', '@agentwaypoint/api', 'start']);
  // Skip web's package.json `start` script (it hardcodes -p 3000); call next directly.
  const webCmd = pnpmCommand([
    '--filter',
    '@agentwaypoint/web',
    'exec',
    'next',
    'start',
    '-p',
    String(config.WEB_PORT),
    '-H',
    String(config.LISTEN_IP),
  ]);

  const apiChild = spawnDetached(apiCmd, apiLog, {
    ...process.env,
    AGENTWAYPOINT_HOME: config.AGENTWAYPOINT_HOME,
    DATABASE_URL: config.DATABASE_URL,
    JWT_SECRET: config.JWT_SECRET,
    AUTH_SESSION_COOKIE_NAME: config.AUTH_SESSION_COOKIE_NAME,
    API_PORT: String(config.API_PORT),
    LISTEN_IP: String(config.LISTEN_IP),
    DEFAULT_WORKSPACE_ROOT: config.DEFAULT_WORKSPACE_ROOT,
    RUNNER_MODE: config.RUNNER_MODE,
  });

  const webChild = spawnDetached(webCmd, webLog, {
    ...process.env,
    AGENTWAYPOINT_HOME: config.AGENTWAYPOINT_HOME,
    API_BASE_URL: apiUrl(config.LISTEN_IP, config.API_PORT),
    NEXT_PUBLIC_API_BASE_URL: apiUrl(config.LISTEN_IP, config.API_PORT),
    PORT: String(config.WEB_PORT),
  });

  const record = {
    apiPid: apiChild.pid,
    webPid: webChild.pid,
    apiPort: Number(config.API_PORT),
    webPort: Number(config.WEB_PORT),
    listenIp: String(config.LISTEN_IP),
    startedAt: new Date().toISOString(),
    home: config.AGENTWAYPOINT_HOME,
  };
  fs.writeFileSync(pidFile, JSON.stringify(record, null, 2));

  apiChild.unref();
  webChild.unref();

  await waitForStartup(record);

  process.stdout.write(
    `AgentWaypoint started (api PID ${record.apiPid}, web PID ${record.webPid}).\n` +
      `Logs: ${apiLog}\n      ${webLog}\n` +
      `URL:  ${webUrl(record.listenIp, record.webPort)}\n`,
  );
}

async function cmdStop() {
  const record = readPidFile();
  if (!record) {
    process.stdout.write('Not running.\n');
    return;
  }
  const pids = [record.apiPid, record.webPid].filter((pid) => Number.isInteger(pid));
  for (const pid of pids) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore; process may have just exited
      }
    }
  }

  // Wait up to 10s for graceful exit.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) {
      break;
    }
    await sleep(200);
  }
  for (const pid of pids) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }
  fs.rmSync(pidFile, { force: true });
  process.stdout.write('Stopped.\n');
}

function cmdStatus() {
  const record = readPidFile();
  if (!record) {
    process.stdout.write('Not running.\n');
    return;
  }
  const apiAlive = isAlive(record.apiPid);
  const webAlive = isAlive(record.webPid);
  process.stdout.write(
    [
      `Home:     ${record.home}`,
      `API:      PID ${record.apiPid} ${apiAlive ? '(alive)' : '(DEAD)'} :${record.apiPort}`,
      `Web:      PID ${record.webPid} ${webAlive ? '(alive)' : '(DEAD)'} :${record.webPort}`,
      `Listen IP: ${record.listenIp ?? '0.0.0.0'}`,
      `Started:  ${record.startedAt}`,
      `URL:      ${webUrl(record.listenIp, record.webPort)}`,
      '',
    ].join('\n'),
  );
  if (!apiAlive || !webAlive) {
    process.exit(1);
  }
}

function cmdLogs(rawArgs) {
  const target = rawArgs[0] ?? 'api';
  const file = target === 'web' ? webLog : apiLog;
  if (!fs.existsSync(file)) {
    process.stderr.write(`No log file at ${file} yet.\n`);
    process.exit(1);
  }
  const tail = spawn('tail', ['-f', file], { stdio: 'inherit' });
  tail.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdCleanupDb() {
  const record = readPidFile();
  if (record && (isAlive(record.apiPid) || isAlive(record.webPid))) {
    throw new Error(
      `Stop AgentWaypoint before cleaning the database: ` +
        `./agent-waypoint stop --home ${shellQuote(dataHome)}`,
    );
  }
  if (!commandExists('sqlite3')) {
    throw new Error('sqlite3 is required for cleanup-db but was not found on PATH.');
  }

  const databasePath = resolveDatabasePathForHome(dataHome);
  if (!fs.existsSync(databasePath)) {
    throw new Error(`SQLite database not found at ${databasePath}`);
  }

  const backupPath = buildBackupPath(databasePath);
  let cleanupSucceeded = false;
  const before = readDatabaseStats(databasePath);

  process.stdout.write(
    `Database: ${databasePath}\n` +
      `Before:   ${formatDatabaseStats(before)}\n` +
      `Backup:   ${backupPath}\n`,
  );

  try {
    runSqlite(databasePath, `.backup ${sqliteCliQuote(backupPath)}`);
    assertQuickCheckOk(backupPath, 'backup');
    assertQuickCheckOk(databasePath, 'database');

    process.stdout.write('Cleaning: VACUUM + PRAGMA optimize\n');
    runSqlite(databasePath, 'VACUUM; PRAGMA optimize;');
    assertQuickCheckOk(databasePath, 'database');

    const after = readDatabaseStats(databasePath);
    fs.rmSync(backupPath, { force: true });
    cleanupSucceeded = true;

    process.stdout.write(
      `After:    ${formatDatabaseStats(after)}\n` +
        `Backup deleted: ${backupPath}\n` +
        'Database cleanup completed.\n',
    );
  } finally {
    if (!cleanupSucceeded && fs.existsSync(backupPath)) {
      process.stderr.write(`Cleanup failed; backup retained at ${backupPath}\n`);
    }
  }
}

function readPidFile() {
  if (!fs.existsSync(pidFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  } catch {
    return null;
  }
}

function bothAlive(record) {
  return isAlive(record.apiPid) && isAlive(record.webPid);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureDirs() {
  fs.mkdirSync(dataHome, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
}

function ensureWebBuild(options = {}) {
  const buildReason = getWebBuildReason(options);
  if (!buildReason) {
    return;
  }
  process.stdout.write(`Building web (${buildReason}, takes a minute)...\n`);
  const [command, ...args] = pnpmCommand(['--filter', '@agentwaypoint/web', 'build']);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`web build failed with status ${result.status}`);
  }
}

function getWebBuildReason(options = {}) {
  if (options.force) {
    return 'forced';
  }

  const buildMarker = path.join(REPO_ROOT, 'apps/web/.next/BUILD_ID');
  const buildMarkerMtime = readMtimeMs(buildMarker);
  if (buildMarkerMtime === null) {
    return 'missing build';
  }

  const newestInput = findNewestWebBuildInputMtime();
  if (newestInput !== null && newestInput > buildMarkerMtime) {
    return 'source changed';
  }
  return null;
}

function findNewestWebBuildInputMtime() {
  const inputs = [
    'package.json',
    'pnpm-lock.yaml',
    'apps/web/package.json',
    'apps/web/next.config.js',
    'apps/web/next.config.mjs',
    'apps/web/tsconfig.json',
    'apps/web/src',
    'apps/web/public',
    'packages/shared/package.json',
    'packages/shared/src',
  ];
  let newest = null;
  for (const input of inputs) {
    const mtime = findNewestMtimeMs(path.join(REPO_ROOT, input));
    if (mtime !== null && (newest === null || mtime > newest)) {
      newest = mtime;
    }
  }
  return newest;
}

function findNewestMtimeMs(targetPath) {
  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return null;
  }

  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (shouldSkipBuildInput(entry.name)) {
      continue;
    }
    const childNewest = findNewestMtimeMs(path.join(targetPath, entry.name));
    if (childNewest !== null && childNewest > newest) {
      newest = childNewest;
    }
  }
  return newest;
}

function readMtimeMs(targetPath) {
  try {
    return fs.statSync(targetPath).mtimeMs;
  } catch {
    return null;
  }
}

function shouldSkipBuildInput(name) {
  return name === 'node_modules' || name === '.next' || name === 'dist' || name === '.turbo';
}

function resolveDatabasePathForHome(home) {
  const configPath = path.join(home, 'config.json');
  if (!fs.existsSync(configPath)) {
    return path.join(home, 'agentwaypoint.db');
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const databaseUrl = typeof parsed.DATABASE_URL === 'string' ? parsed.DATABASE_URL : '';
  return resolveSqliteDatabasePath(databaseUrl, home);
}

function resolveSqliteDatabasePath(databaseUrl, home) {
  if (!databaseUrl.startsWith('file:')) {
    return path.join(home, 'agentwaypoint.db');
  }
  const withoutPrefix = databaseUrl.slice('file:'.length);
  const withoutQuery = withoutPrefix.split('?')[0] ?? '';
  const decoded = decodeURIComponent(withoutQuery);
  return path.isAbsolute(decoded) ? decoded : path.resolve(home, decoded);
}

function buildBackupPath(databasePath) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  return `${databasePath}.cleanup-${timestamp}.bak`;
}

function runSqlite(databasePath, sql) {
  const result = spawnSync('sqlite3', [databasePath, sql], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`sqlite3 failed with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return (result.stdout ?? '').trim();
}

function assertQuickCheckOk(databasePath, label) {
  const output = runSqlite(databasePath, 'PRAGMA quick_check;').trim();
  if (output !== 'ok') {
    throw new Error(`SQLite quick_check failed for ${label}: ${output || '(no output)'}`);
  }
}

function readDatabaseStats(databasePath) {
  const output = runSqlite(
    databasePath,
    [
      'PRAGMA page_size;',
      'PRAGMA page_count;',
      'PRAGMA freelist_count;',
    ].join(' '),
  );
  const [pageSizeRaw, pageCountRaw, freelistCountRaw] = output.split(/\s+/);
  const pageSize = Number(pageSizeRaw);
  const pageCount = Number(pageCountRaw);
  const freelistCount = Number(freelistCountRaw);
  const fileSize = fs.statSync(databasePath).size;
  return {
    fileSize,
    pageSize,
    pageCount,
    freelistCount,
    reusableBytes: Number.isFinite(pageSize) && Number.isFinite(freelistCount) ? pageSize * freelistCount : 0,
  };
}

function formatDatabaseStats(stats) {
  return (
    `${formatBytes(stats.fileSize)} file, ` +
    `${formatBytes(stats.reusableBytes)} reusable, ` +
    `${stats.pageCount} pages, ${stats.freelistCount} free pages`
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'unknown';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function sqliteCliQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function spawnDetached(argv, logFilePath, env) {
  const out = fs.openSync(logFilePath, 'a');
  const err = fs.openSync(logFilePath, 'a');
  const child = spawn(argv[0], argv.slice(1), {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', out, err],
  });
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the bootstrap step in a child node process so its stdin/stdout are
 * inherited (interactive prompts work). Reads the resulting config.json.
 */
async function runBootstrapForeground() {
  const configPath = path.join(dataHome, 'config.json');
  const [command, ...args] = pnpmCommand([
    '--filter',
    '@agentwaypoint/api',
    'exec',
    'tsx',
    'src/bootstrap/run-bootstrap.ts',
  ]);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, AGENTWAYPOINT_HOME: dataHome },
  });
  if (result.status !== 0) {
    throw new Error(`Bootstrap failed with status ${result.status}`);
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Bootstrap exited cleanly but did not write ${configPath}. ` +
        `Re-run \`./agent-waypoint start\` from a real terminal.`,
    );
  }
  // Configs created before LISTEN_IP existed retain the historical bind-all
  // behavior without requiring a manual migration.
  return { LISTEN_IP: '0.0.0.0', ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
}

async function waitForStartup(record) {
  await waitForHttpOk({
    name: 'API',
    url: `${apiUrl(record.listenIp, record.apiPort)}/api/health`,
    timeoutMs: STARTUP_TIMEOUT_MS,
    logFilePath: apiLog,
  });
  await waitForHttpOk({
    name: 'Web',
    url: webUrl(record.listenIp, record.webPort),
    timeoutMs: STARTUP_TIMEOUT_MS,
    logFilePath: webLog,
  });
}

function formatHost(host) {
  const normalized = host || '0.0.0.0';
  if (normalized === '0.0.0.0') return '127.0.0.1';
  if (normalized === '::') return '[::1]';
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}

function apiUrl(listenIp, port) {
  return `http://${formatHost(listenIp)}:${port}`;
}

function webUrl(listenIp, port) {
  return `http://${formatHost(listenIp)}:${port}`;
}

async function waitForHttpOk({ name, url, timeoutMs, logFilePath }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`${name} did not become ready within ${timeoutMs / 1000}s. Check ${logFilePath}.${detail}`);
}

function resolvePackageManager() {
  if (commandExists('pnpm')) {
    return { command: 'pnpm', prefixArgs: [] };
  }
  return { command: 'corepack', prefixArgs: ['pnpm'] };
}

function pnpmCommand(args) {
  return [packageManager.command, ...packageManager.prefixArgs, ...args];
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}
