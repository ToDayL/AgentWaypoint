import { describe, expect, it } from 'vitest';
import { requestId, terminalSocketUrl } from './terminal-client';

describe('HTTP-compatible terminal client', () => {
  it('generates UUIDs without relying on secure-context randomUUID', () => {
    expect(requestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(requestId()).not.toBe(requestId());
  });
  it('uses the browser public host and selects ws/wss', () => {
    expect(terminalSocketUrl({ protocol: 'http:', host: 'localhost:3100' })).toBe(
      'ws://localhost:3100/api/terminals/socket',
    );
    expect(terminalSocketUrl({ protocol: 'https:', host: 'web.test' })).toBe(
      'wss://web.test/api/terminals/socket',
    );
  });
});
