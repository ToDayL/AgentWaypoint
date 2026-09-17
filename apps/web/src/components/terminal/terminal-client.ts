export type TerminalInfo = {
  id: string;
  apiInstanceId: string;
  sessionId: string;
  title: string;
  state: 'starting' | 'running' | 'closing' | 'exited' | 'failed';
  initialCwd: string;
  cols: number;
  rows: number;
  closeReason?: string;
  exitCode?: number;
};

// randomUUID is not available in every browser's HTTP (non-secure) context.
export function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function terminalRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error?.message ?? `Terminal request failed (${response.status})`);
  return body as T;
}

export function terminalSocketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminals/socket`;
}
