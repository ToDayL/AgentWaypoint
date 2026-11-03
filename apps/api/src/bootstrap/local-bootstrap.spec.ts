import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from './local-bootstrap';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function config(overrides: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'aw-bootstrap-bind-'));
  homes.push(home);
  const file = path.join(home, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      AGENTWAYPOINT_HOME: home,
      DATABASE_URL: `file:${home}/test.db`,
      JWT_SECRET: 'test-only',
      AUTH_SESSION_COOKIE_NAME: 'aw_session',
      API_PORT: '4000',
      WEB_PORT: '3000',
      DEFAULT_WORKSPACE_ROOT: home,
      RUNNER_MODE: 'mock',
      ...overrides,
    }),
  );
  return file;
}

describe('API and Web listen addresses', () => {
  it.each([undefined, '0.0.0.0', '192.0.2.1', '::'])(
    'keeps the API local with legacy Web address %s',
    (listenIp) => {
      const result = readConfig(config(listenIp ? { LISTEN_IP: listenIp } : {}));
      expect(result.API_LISTEN_IP).toBe('127.0.0.1');
      expect(result.LISTEN_IP).toBe(listenIp ?? '0.0.0.0');
    },
  );
  it.each(['0.0.0.0', '::1'])('allows an explicit API address %s', (apiListenIp) => {
    expect(readConfig(config({ API_LISTEN_IP: apiListenIp })).API_LISTEN_IP).toBe(apiListenIp);
  });
  it.each(['localhost', '', 123, null])('rejects an invalid API address %s', (apiListenIp) => {
    expect(() => readConfig(config({ API_LISTEN_IP: apiListenIp }))).toThrow(
      'invalid API_LISTEN_IP',
    );
  });
});
