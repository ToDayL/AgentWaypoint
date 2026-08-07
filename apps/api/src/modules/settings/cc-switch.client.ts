import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);
const CC_SWITCH_TIMEOUT_MS = 5_000;
const CODEX_MODEL_CATALOG_CONFIG = 'model_catalog_json = "cc-switch-model-catalog.json"';

export type CcSwitchApp = 'codex' | 'claude';

export type CcSwitchProvider = {
  id: string;
  name: string;
  current: boolean;
};

export type CcSwitchState = {
  available: boolean;
  canSwitch: boolean;
  reason: string | null;
  providers: Record<CcSwitchApp, CcSwitchProvider[]>;
};

export interface CcSwitchClient {
  discover(): Promise<CcSwitchState>;
  switchProvider(app: CcSwitchApp, id: string): Promise<void>;
}

export const CC_SWITCH_CLIENT = Symbol('CC_SWITCH_CLIENT');

@Injectable()
export class LocalCcSwitchClient implements CcSwitchClient {
  private readonly binary = process.env.CC_SWITCH_BIN?.trim() || 'cc-switch';
  private commandQueue: Promise<void> = Promise.resolve();

  async discover(): Promise<CcSwitchState> {
    try {
      await this.run(['--version']);
    } catch (error: unknown) {
      return unavailableState(
        error instanceof Error && isMissingCommand(error) ? 'cc-switch is not installed' : 'cc-switch is unavailable',
      );
    }

    try {
      const [codex, claude] = await Promise.all([this.listProviders('codex'), this.listProviders('claude')]);
      return {
        available: true,
        canSwitch: true,
        reason: null,
        providers: { codex, claude },
      };
    } catch {
      // Do not expose command output: cc-switch's detailed commands may include credentials.
      return unavailableState('Unable to read cc-switch providers');
    }
  }

  async switchProvider(app: CcSwitchApp, id: string): Promise<void> {
    await this.run(['provider', 'switch', '--app', app, id]);
    if (app === 'codex' && !id.trim().startsWith('codex-official')) {
      await ensureCodexModelCatalogJson();
    }
  }

  private async listProviders(app: CcSwitchApp): Promise<CcSwitchProvider[]> {
    const { stdout } = await this.run(['provider', 'list', '--app', app]);
    const providers = parseProviderList(stdout);
    if (providers.length === 0) {
      throw new Error(`cc-switch returned no ${app} providers`);
    }
    return providers;
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const command = this.commandQueue.then(() =>
      execFileAsync(this.binary, args, {
        timeout: CC_SWITCH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
    );
    // Continue the queue after failures so a transient cc-switch lease error
    // does not permanently block future discovery or switch requests.
    this.commandQueue = command.then(
      () => undefined,
      () => undefined,
    );
    return command;
  }
}

/**
 * cc-switch can occasionally omit its model catalog reference when writing a
 * third-party Codex provider. Keep the reference at the TOML root so Codex
 * can discover the generated catalog on the next startup.
 */
export async function ensureCodexModelCatalogJson(
  configPath = resolveCodexConfigPath(),
): Promise<void> {
  let configText = '';
  try {
    configText = await readFile(configPath, 'utf8');
  } catch (error: unknown) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }

  const updatedConfigText = ensureCodexModelCatalogJsonInText(configText);
  if (updatedConfigText === configText) {
    return;
  }

  const configDir = path.dirname(configPath);
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, updatedConfigText, 'utf8');
}

export function ensureCodexModelCatalogJsonInText(configText: string): string {
  if (hasTopLevelTomlKey(configText, 'model_catalog_json')) {
    return configText;
  }

  const bom = configText.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = configText.slice(bom.length);
  const lineEnding = body.includes('\r\n') ? '\r\n' : '\n';
  return `${bom}${CODEX_MODEL_CATALOG_CONFIG}${lineEnding}${body}`;
}

export function parseProviderList(output: string): CcSwitchProvider[] {
  const providers: CcSwitchProvider[] = [];
  const seen = new Set<string>();
  const ansiFree = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');

  for (const line of ansiFree.split(/\r?\n/)) {
    if (!line.includes('┆')) {
      continue;
    }
    const columns = line.split('┆').map((column) => column.replaceAll('│', '').trim());
    if (columns.length < 3) {
      continue;
    }
    const marker = columns[0] ?? '';
    const id = columns[1] ?? '';
    const name = columns[2] ?? '';
    if (!id || id === 'ID' || !/^[A-Za-z0-9._:-]+$/.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    providers.push({
      id,
      name: name || id,
      current: marker.includes('✓'),
    });
  }

  return providers;
}

function unavailableState(reason: string): CcSwitchState {
  return {
    available: false,
    canSwitch: false,
    reason,
    providers: {
      codex: [{ id: 'codex-official', name: 'codex-official', current: true }],
      claude: [{ id: 'claude-official', name: 'claude-official', current: true }],
    },
  };
}

function isMissingCommand(error: Error): boolean {
  return 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function resolveCodexConfigPath(): string {
  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  if (configuredCodexHome) {
    return path.join(configuredCodexHome, 'config.toml');
  }

  const testHome = process.env.CC_SWITCH_TEST_HOME?.trim();
  const home = testHome || homedir();
  return path.join(home, '.codex', 'config.toml');
}

function hasTopLevelTomlKey(configText: string, key: string): boolean {
  let insideTable = false;
  for (const line of configText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    if (trimmed.startsWith('[')) {
      insideTable = true;
      continue;
    }
    if (!insideTable && new RegExp(`^(?:${key}|"${key}")\\s*=`).test(trimmed)) {
      return true;
    }
  }
  return false;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
