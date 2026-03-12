import { mkdir, stat } from 'node:fs/promises';
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
    const absolutePath = path.resolve(inputPath.trim());
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

  private async assertExistingWorkspaceDirectory(normalizedCwd: string): Promise<string> {
    const absolutePath = path.resolve(normalizedCwd);
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
    const rootsConfig = this.config.allowedRepoRoots?.trim();
    if (!rootsConfig) {
      return;
    }

    const allowedRoots = rootsConfig
      .split(',')
      .map((entry) => path.resolve(entry.trim()))
      .filter((entry) => entry.length > 0);

    const isAllowed = allowedRoots.some(
      (root) => absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`),
    );
    if (!isAllowed) {
      throw new Error(`Project workspace is outside allowed roots: ${absolutePath}`);
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
