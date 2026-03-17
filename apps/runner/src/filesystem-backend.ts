import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

type FilesystemBackendConfig = {
  allowedRepoRoots: string | null;
};

export class FilesystemBackend {
  constructor(private readonly config: FilesystemBackendConfig) {}

  async resolveWorkspaceCwd(inputCwd: string | null | undefined): Promise<string> {
    const normalizedCwd = inputCwd?.trim() ?? '';
    if (!normalizedCwd) {
      throw new Error('Project workspace is not configured (repoPath is required)');
    }

    return this.assertExistingWorkspaceDirectory(normalizedCwd);
  }

  async ensureWorkspaceDirectory(inputPath: string): Promise<{ path: string; created: boolean }> {
    const absolutePath = path.resolve(expandHomeToken(inputPath.trim()));
    this.assertWorkspaceAllowed(absolutePath);

    try {
      const info = await stat(absolutePath);
      if (!info.isDirectory()) {
        throw new Error(`Project workspace is not a directory: ${absolutePath}`);
      }
      return { path: absolutePath, created: false };
    } catch (error: unknown) {
      if (isMissingPathError(error)) {
        await mkdir(absolutePath, { recursive: true });
        return { path: absolutePath, created: true };
      }
      throw error;
    }
  }

  async suggestWorkspaceDirectories(inputPrefix: string, limit = 12): Promise<string[]> {
    const sanitizedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 12;
    const prefix = inputPrefix.trim();
    const resolvedPrefix = path.resolve(expandHomeToken(prefix.length > 0 ? prefix : '.'));
    const hasTrailingSeparator = /[\\/]+$/.test(prefix);
    const scanDirectory = hasTrailingSeparator ? resolvedPrefix : path.dirname(resolvedPrefix);
    const segmentPrefix = hasTrailingSeparator ? '' : path.basename(resolvedPrefix);

    if (!this.isPathPotentiallyAllowed(scanDirectory)) {
      return [];
    }

    let entries;
    try {
      entries = await readdir(scanDirectory, { withFileTypes: true, encoding: 'utf8' });
    } catch (error: unknown) {
      if (isMissingPathError(error) || isPermissionDeniedError(error)) {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(segmentPrefix))
      .map((entry) => path.join(scanDirectory, entry.name))
      .filter((candidate) => this.isPathPotentiallyAllowed(candidate))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, sanitizedLimit);
  }

  async listWorkspaceTree(inputPath: string, limit = 200): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
    const absolutePath = await this.assertExistingWorkspaceDirectory(inputPath.trim());
    const sanitizedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 200;

    const entries = await readdir(absolutePath, { withFileTypes: true, encoding: 'utf8' });
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: path.join(absolutePath, entry.name),
        isDirectory: entry.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, sanitizedLimit);
  }

  private async assertExistingWorkspaceDirectory(normalizedCwd: string): Promise<string> {
    const absolutePath = path.resolve(expandHomeToken(normalizedCwd));
    this.assertWorkspaceAllowed(absolutePath);

    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      throw new Error(`Project workspace does not exist: ${absolutePath}`);
    }

    if (!info.isDirectory()) {
      throw new Error(`Project workspace is not a directory: ${absolutePath}`);
    }

    return absolutePath;
  }

  private assertWorkspaceAllowed(absolutePath: string): void {
    if (!this.isPathWithinAllowedRoots(absolutePath)) {
      throw new Error(`Project workspace is outside allowed roots: ${absolutePath}`);
    }
  }

  private isPathPotentiallyAllowed(absolutePath: string): boolean {
    const allowedRoots = this.readAllowedRoots();
    if (allowedRoots.length === 0) {
      return true;
    }

    return allowedRoots.some(
      (root) =>
        absolutePath === root ||
        absolutePath.startsWith(`${root}${path.sep}`) ||
        root.startsWith(`${absolutePath}${path.sep}`),
    );
  }

  private isPathWithinAllowedRoots(absolutePath: string): boolean {
    const allowedRoots = this.readAllowedRoots();
    if (allowedRoots.length === 0) {
      return true;
    }

    return allowedRoots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`));
  }

  private readAllowedRoots(): string[] {
    const rootsConfig = this.config.allowedRepoRoots?.trim();
    if (!rootsConfig) {
      return [];
    }
    return rootsConfig
      .split(',')
      .map((entry) => path.resolve(entry.trim()))
      .filter((entry) => entry.length > 0);
  }
}

function expandHomeToken(inputPath: string): string {
  if (!inputPath) {
    return inputPath;
  }

  const homePath = process.env.HOME?.trim() || homedir().trim();
  if (!homePath) {
    return inputPath;
  }

  if (inputPath === '~' || inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(homePath, inputPath.slice(1));
  }
  if (
    inputPath === '$HOME' ||
    inputPath.startsWith(`$HOME${path.sep}`) ||
    inputPath.startsWith('$HOME/') ||
    inputPath.startsWith('$HOME\\')
  ) {
    return path.join(homePath, inputPath.slice('$HOME'.length));
  }

  return inputPath;
}

function isMissingPathError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function isPermissionDeniedError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EACCES';
}
