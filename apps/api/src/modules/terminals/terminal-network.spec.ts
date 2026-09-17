import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TerminalNetwork,
  isOriginAllowed,
  normalizeOrigin,
  validateNetwork,
} from './terminal-network';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
describe('terminal origins', () => {
  it('normalizes exact HTTP origins and rejects wildcard, null, paths and credentials', () => {
    expect(normalizeOrigin('http://Example.test:80')).toBe('http://example.test');
    for (const input of [
      '*',
      'null',
      'ws://a.test',
      'http://a.test/path',
      'http://user@a.test',
      'http://a.test/?a=1',
    ])
      expect(() => normalizeOrigin(input)).toThrow();
  });
  it('defaults old configuration to same-origin and reloads only valid deployment configuration', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'aw-terminal-config-'));
    homes.push(home);
    vi.stubEnv('AGENTWAYPOINT_HOME', home);
    const file = path.join(home, 'config.json');
    writeFileSync(file, JSON.stringify({ JWT_SECRET: 'preserve-me' }));
    const network = new TerminalNetwork();
    expect(network.effective().TERMINAL_ORIGIN_POLICY).toBe('same-origin');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ JWT_SECRET: 'preserve-me' });
    const headers = {
      'x-aw-terminal-key': readFileSync(path.join(home, 'run/terminal-ingress.key'), 'utf8'),
      'x-aw-terminal-external-origin': 'http://localhost:3100',
      origin: 'http://localhost:3100',
    };
    expect(network.check(headers).origin).toBe('http://localhost:3100');
    expect(() => network.check({ ...headers, origin: 'http://evil.test' })).toThrow();
    writeFileSync(
      file,
      JSON.stringify({
        JWT_SECRET: 'preserve-me',
        TERMINAL_ORIGIN_POLICY: 'allowlist',
        TERMINAL_ALLOWED_ORIGINS: 'http://localhost:3100',
      }),
    );
    const revised = network.effective();
    expect(revised.TERMINAL_ORIGIN_POLICY).toBe('allowlist');
    expect(network.check(headers).origin).toBe('http://localhost:3100');
    expect(() => network.check({ ...headers, origin: 'http://other.test' })).toThrow();
    expect(() => network.check({ ...headers, 'x-aw-terminal-key': 'forged' })).toThrow();
    writeFileSync(file, '{broken');
    expect(network.effective()).toEqual(revised);
    writeFileSync(file, JSON.stringify({ TERMINAL_ORIGIN_POLICY: 'allowlist' }));
    expect(network.effective()).toEqual(revised);
    vi.stubEnv('TERMINAL_ORIGIN_POLICY', 'same-origin');
    vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://public.test');
    expect(network.effective().PUBLIC_WEB_ORIGIN).toBe('https://public.test');
    expect(() => network.check(headers)).toThrow();
    expect(network.check({ ...headers, origin: 'https://public.test' }).origin).toBe(
      'https://public.test',
    );
  });
  it('supports a fixed TLS-terminated origin and a strict allowlist', () => {
    const config = validateNetwork({
      TERMINAL_ORIGIN_POLICY: 'same-origin',
      TERMINAL_ALLOWED_ORIGINS: '',
      PUBLIC_WEB_ORIGIN: 'https://web.test',
    });
    expect(isOriginAllowed(config, 'https://web.test', 'http://internal:3000')).toBe(true);
    expect(isOriginAllowed(config, 'http://web.test', 'http://internal:3000')).toBe(false);
    expect(() => validateNetwork({ ...config, TERMINAL_ORIGIN_POLICY: 'allowlist' })).toThrow();
  });
});
