#!/usr/bin/env node
/**
 * agent-waypoint CLI: start | stop | restart | status | logs
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
const { command, home: homeOverride, commandArgs } = parseArgs(args);

if (!command) {
  printUsage();
  process.exit(1);
}

const dataHome = resolveDataHome(homeOverride);
const pidFile = path.join(dataHome, 'agent-waypoint.pid');
const logsDir = path.join(dataHome, 'logs');
const apiLog = path.join(logsDir, 'api.log');
const webLog = path.join(logsDir, 'web.log');

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
  const out = { command: null, home: null, commandArgs: [] };
  const positional = [];
  for (let i = 0; i < input.length; i += 1) {
    const arg = input[i];
    if (arg === '--home') {
      out.home = input[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--home=')) {
      out.home = arg.slice('--home='.length);
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
      'Usage: agent-waypoint <command> [--home <dir>]',
      '',
      'Commands:',
      '  start     Bootstrap (if needed) and launch API + Web in the background.',
      '  stop      Stop the running services.',
      '  restart   Stop, then start.',
      '  status    Show running PIDs and URL.',
      '  logs [api|web]  Tail the named service log (default: api).',
      '',
      'Options:',
      '  --home <dir>  Override the data directory (default: $AGENTWAYPOINT_HOME or ~/.agentwaypoint).',
      '',
    ].join('\n'),
  );
}

async function cmdStart() {
  const existing = readPidFile();
  if (existing && bothAlive(existing)) {
    process.stdout.write(
      `AgentWaypoint already running (api=${existing.apiPid}, web=${existing.webPid}).\n` +
        `URL: http://localhost:${existing.webPort}\n`,
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

  ensureWebBuild();

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
  ]);

  const apiChild = spawnDetached(apiCmd, apiLog, {
    ...process.env,
    AGENTWAYPOINT_HOME: config.AGENTWAYPOINT_HOME,
    DATABASE_URL: config.DATABASE_URL,
    JWT_SECRET: config.JWT_SECRET,
    AUTH_SESSION_COOKIE_NAME: config.AUTH_SESSION_COOKIE_NAME,
    API_PORT: String(config.API_PORT),
    DEFAULT_WORKSPACE_ROOT: config.DEFAULT_WORKSPACE_ROOT,
    RUNNER_MODE: config.RUNNER_MODE,
  });

  const webChild = spawnDetached(webCmd, webLog, {
    ...process.env,
    AGENTWAYPOINT_HOME: config.AGENTWAYPOINT_HOME,
    NEXT_PUBLIC_API_BASE_URL: `http://localhost:${config.API_PORT}`,
    PORT: String(config.WEB_PORT),
  });

  const record = {
    apiPid: apiChild.pid,
    webPid: webChild.pid,
    apiPort: Number(config.API_PORT),
    webPort: Number(config.WEB_PORT),
    startedAt: new Date().toISOString(),
    home: config.AGENTWAYPOINT_HOME,
  };
  fs.writeFileSync(pidFile, JSON.stringify(record, null, 2));

  apiChild.unref();
  webChild.unref();

  process.stdout.write(
    `AgentWaypoint starting (api PID ${record.apiPid}, web PID ${record.webPid}).\n` +
      `Logs: ${apiLog}\n      ${webLog}\n` +
      `URL:  http://localhost:${record.webPort}\n`,
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
      `Started:  ${record.startedAt}`,
      `URL:      http://localhost:${record.webPort}`,
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

function ensureWebBuild() {
  const nextDir = path.join(REPO_ROOT, 'apps/web/.next');
  if (fs.existsSync(path.join(nextDir, 'BUILD_ID'))) {
    return;
  }
  process.stdout.write('Building web (one-time, takes a minute)...\n');
  const [command, ...args] = pnpmCommand(['--filter', '@agentwaypoint/web', 'build']);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`web build failed with status ${result.status}`);
  }
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
  if (!fs.existsSync(configPath)) {
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
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
