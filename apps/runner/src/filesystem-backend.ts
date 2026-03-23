import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

type FilesystemBackendConfig = {
  allowedRepoRoots: string | null;
};

const WORKSPACE_FILE_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const WORKSPACE_UPLOAD_MAX_SIZE_BYTES = 20 * 1024 * 1024;

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

  async listWorkspaceTree(
    inputPath: string,
    limit = 200,
    includeHidden = false,
  ): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
    const absolutePath = await this.assertExistingWorkspaceDirectory(inputPath.trim());
    const sanitizedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 200;

    const entries = await readdir(absolutePath, { withFileTypes: true, encoding: 'utf8' });
    const resolvedEntries = await Promise.all(
      entries
        .filter((entry) => includeHidden || !entry.name.startsWith('.'))
        .map(async (entry) => {
          const entryPath = path.join(absolutePath, entry.name);
          let isDirectory = entry.isDirectory();
          if (!isDirectory && entry.isSymbolicLink()) {
            try {
              isDirectory = (await stat(entryPath)).isDirectory();
            } catch {
              isDirectory = false;
            }
          }
          return {
            name: entry.name,
            path: entryPath,
            isDirectory,
          };
        }),
    );

    return resolvedEntries
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, sanitizedLimit);
  }

  async readWorkspaceFile(inputPath: string, maxBytes = 256 * 1024): Promise<{ path: string; content: string; truncated: boolean }> {
    const absolutePath = path.resolve(expandHomeToken(inputPath.trim()));
    this.assertWorkspaceAllowed(absolutePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new Error(`Path is not a file: ${absolutePath}`);
    }
    if (info.size > WORKSPACE_FILE_MAX_SIZE_BYTES) {
      throw new Error(`File is too large to preview (>10MB): ${absolutePath}`);
    }

    const sanitizedMaxBytes = Number.isFinite(maxBytes)
      ? Math.min(Math.max(Math.trunc(maxBytes), 1024), 1024 * 1024)
      : 256 * 1024;
    const contentBuffer = await readFile(absolutePath);
    if (contentBuffer.includes(0)) {
      throw new Error(`File appears to be binary and cannot be previewed: ${absolutePath}`);
    }
    const truncated = contentBuffer.length > sanitizedMaxBytes;
    const content = (truncated ? contentBuffer.subarray(0, sanitizedMaxBytes) : contentBuffer).toString('utf8');
    return {
      path: absolutePath,
      content,
      truncated,
    };
  }

  async readWorkspaceFileBinary(
    inputPath: string,
  ): Promise<{ path: string; content: Buffer; mimeType: string; size: number }> {
    const absolutePath = path.resolve(expandHomeToken(inputPath.trim()));
    this.assertWorkspaceAllowed(absolutePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new Error(`Path is not a file: ${absolutePath}`);
    }
    if (info.size > WORKSPACE_FILE_MAX_SIZE_BYTES) {
      throw new Error(`File is too large to preview (>10MB): ${absolutePath}`);
    }

    const content = await readFile(absolutePath);
    return {
      path: absolutePath,
      content,
      mimeType: resolveMimeTypeFromPath(absolutePath),
      size: content.byteLength,
    };
  }

  async saveWorkspaceUpload(input: {
    workspacePath: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
  }): Promise<{ path: string; relativePath: string; size: number; mimeType: string }> {
    const workspaceRoot = await this.assertExistingWorkspaceDirectory(input.workspacePath.trim());
    const byteLength = input.content.byteLength;
    if (byteLength <= 0) {
      throw new Error('Uploaded file is empty');
    }
    if (byteLength > WORKSPACE_UPLOAD_MAX_SIZE_BYTES) {
      throw new Error('Uploaded file exceeds 20MB limit');
    }

    const uploadsDirectory = path.join(workspaceRoot, 'uploads');
    await mkdir(uploadsDirectory, { recursive: true });

    const safeName = sanitizeUploadFileName(input.fileName);
    let attempt = 0;
    while (attempt < 10000) {
      const candidateName = appendNumericSuffix(safeName, attempt);
      const absolutePath = path.join(uploadsDirectory, candidateName);
      try {
        await writeFile(absolutePath, input.content, { flag: 'wx' });
        return {
          path: absolutePath,
          relativePath: `uploads/${candidateName}`,
          size: byteLength,
          mimeType: input.mimeType,
        };
      } catch (error: unknown) {
        if (isAlreadyExistsError(error)) {
          attempt += 1;
          continue;
        }
        throw error;
      }
    }

    throw new Error('Failed to allocate a unique file name in uploads');
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

function isAlreadyExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EEXIST';
}

function sanitizeUploadFileName(input: string): string {
  const trimmed = path.basename(input.trim());
  const sanitized = trimmed
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized.length > 0) {
    return sanitized.slice(0, 255);
  }
  return `upload-${Date.now()}.bin`;
}

function appendNumericSuffix(fileName: string, attempt: number): string {
  if (attempt <= 0) {
    return fileName;
  }
  const ext = path.extname(fileName);
  const base = ext.length > 0 ? fileName.slice(0, -ext.length) : fileName;
  return `${base}-${attempt}${ext}`;
}

function resolveMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}
