import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

export const NETWORK_KEYS = [
  'TERMINAL_ORIGIN_POLICY',
  'TERMINAL_ALLOWED_ORIGINS',
  'PUBLIC_WEB_ORIGIN',
] as const;
type NetworkKey = (typeof NETWORK_KEYS)[number];
type Headers = Record<string, string | string[] | undefined>;
type Config = Record<NetworkKey, string>;
const defaults: Config = {
  TERMINAL_ORIGIN_POLICY: 'same-origin',
  TERMINAL_ALLOWED_ORIGINS: '',
  PUBLIC_WEB_ORIGIN: '',
};

export function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new BadRequestException(
      'Expected an HTTP/HTTPS Origin without path, credentials, query or fragment',
    );
  }
}

export function validateNetwork(config: Config): Config {
  if (!['same-origin', 'allowlist'].includes(config.TERMINAL_ORIGIN_POLICY))
    throw new BadRequestException('Invalid terminal Origin policy');
  const origins = [
    ...new Set(
      config.TERMINAL_ALLOWED_ORIGINS.split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map(normalizeOrigin),
    ),
  ];
  if (config.TERMINAL_ORIGIN_POLICY === 'allowlist' && !origins.length)
    throw new BadRequestException('Origin allowlist must not be empty');
  return {
    ...config,
    TERMINAL_ALLOWED_ORIGINS: origins.join(','),
    PUBLIC_WEB_ORIGIN: config.PUBLIC_WEB_ORIGIN ? normalizeOrigin(config.PUBLIC_WEB_ORIGIN) : '',
  };
}

export function isOriginAllowed(config: Config, origin: string, external: string): boolean {
  return config.TERMINAL_ORIGIN_POLICY === 'allowlist'
    ? config.TERMINAL_ALLOWED_ORIGINS.split(',').includes(origin)
    : origin === (config.PUBLIC_WEB_ORIGIN || external);
}

@Injectable()
export class TerminalNetwork {
  private lastGood: Config | null = null;
  private credential: string | null = null;

  constructor() {
    if (process.env.AGENTWAYPOINT_HOME) this.key();
  }

  private configPath() {
    if (!process.env.AGENTWAYPOINT_HOME)
      throw new Error('AGENTWAYPOINT_HOME is required for terminals');
    return path.join(process.env.AGENTWAYPOINT_HOME, 'config.json');
  }

  private read() {
    return JSON.parse(fs.readFileSync(this.configPath(), 'utf8')) as Record<string, unknown>;
  }

  private resolve(values: Record<string, unknown>): Config {
    return validateNetwork(
      Object.fromEntries(
        NETWORK_KEYS.map((key) => {
          const value = process.env[key] ?? values[key] ?? defaults[key];
          if (typeof value !== 'string') throw new BadRequestException(`Invalid ${key}`);
          return [key, value];
        }),
      ) as Config,
    );
  }

  effective(): Config {
    try {
      this.lastGood = this.resolve(this.read());
    } catch (error) {
      if (!this.lastGood) throw error;
    }
    return this.lastGood!;
  }

  private key(): string {
    if (this.credential) return this.credential;
    const directory = path.join(path.dirname(this.configPath()), 'run');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'terminal-ingress.key');
    try {
      fs.writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.credential = fs.readFileSync(file, 'utf8').trim();
    return this.credential;
  }

  check(headers: Headers, requireOrigin = true): { origin: string; external: string } {
    const key = headers['x-aw-terminal-key'];
    const expected = this.key();
    if (
      typeof key !== 'string' ||
      Buffer.byteLength(key) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(expected))
    )
      throw new ForbiddenException('Terminal requests must use the Web entrypoint');
    const external = normalizeOrigin(String(headers['x-aw-terminal-external-origin'] ?? ''));
    const rawOrigin = headers.origin;
    if (requireOrigin && typeof rawOrigin !== 'string')
      throw new ForbiddenException('Terminal Origin is required');
    const origin = typeof rawOrigin === 'string' ? normalizeOrigin(rawOrigin) : external;
    if (!isOriginAllowed(this.effective(), origin, external))
      throw new ForbiddenException('Terminal Origin is not allowed');
    return { origin, external };
  }
}
