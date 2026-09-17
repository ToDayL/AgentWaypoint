import { test, expect, type Page } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';

let server: ChildProcess;
let fixture: { url: string; sessionId: string; email: string; password: string };
async function expectTerminalReady(page: Page) {
  const panel = page.getByLabel('Session terminal', { exact: true });
  // Snapshot completion focuses the writable terminal; no visible status label is needed.
  await expect(panel.locator('.xterm-helper-textarea')).toBeFocused({ timeout: 20_000 });
  await expect(panel.locator('.terminal-status')).toHaveCount(0);
  await expect(panel.locator('.terminal-cwd')).toHaveCount(0);
  await expect(panel.getByText('Connected', { exact: true })).toHaveCount(0);
}
test.beforeAll(async () => {
  server = fork(path.resolve('apps/api/src/test-utils/terminal-browser-server.ts'), [], {
    cwd: path.resolve('apps/api'),
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  server.stdout?.on('data', (data) => {
    output += data.toString();
  });
  server.stderr?.on('data', (data) => {
    output += data.toString();
  });
  fixture = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Terminal fixture timeout: ${output}`)),
      50_000,
    );
    server.once('message', (message: any) => {
      clearTimeout(timeout);
      resolve(message);
    });
    server.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(`Terminal fixture exited: ${output}`));
    });
  });
});
test.afterAll(async () => {
  if (server?.connected) {
    const closed = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    server.send('stop');
    await closed;
  }
});

test.describe('mobile fullscreen terminal', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('fills the screen, returns without closing the PTY, and supports rotation and tabs', async ({
    page,
  }) => {
    await page.request.post(`${fixture.url}/api/auth/login/password`, {
      data: { email: fixture.email, password: fixture.password },
    });
    await page.goto(fixture.url);
    const toggle = page.getByRole('button', { name: 'Toggle Terminal', exact: true });
    await toggle.tap();
    const panel = page.getByRole('dialog', { name: 'Session terminal' });
    await expectTerminalReady(page);
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(panel).toHaveCSS('position', 'fixed');
    await expect(panel).toHaveCSS('height', '844px');
    expect(await panel.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await expect(panel.getByRole('separator', { includeHidden: true })).toBeHidden();
    await expect(
      panel.getByRole('button', { name: 'Hide terminal panel', includeHidden: true }),
    ).toBeHidden();
    expect(
      await page.locator('.shell-header').evaluate((element) => (element as HTMLElement).inert),
    ).toBe(true);
    const close = panel.getByRole('button', { name: 'Close Terminal 1', exact: true });
    const closeBounds = (await close.boundingBox())!;
    expect(closeBounds.width).toBeGreaterThanOrEqual(44);
    expect(closeBounds.height).toBeGreaterThanOrEqual(44);
    const url = `${fixture.url}/api/sessions/${fixture.sessionId}/terminals`;
    const initial = await (await page.request.get(url)).json();
    expect(initial.terminals).toHaveLength(1);
    await page.keyboard.type('printf "AW_%s\\n" "MOBILE_OK"');
    await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('AW_MOBILE_OK');

    await panel.getByRole('button', { name: 'Back to chat' }).tap();
    await expect(panel).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      await page.locator('.shell-header').evaluate((element) => (element as HTMLElement).inert),
    ).toBe(false);
    await expect
      .poll(
        async () => (await (await page.request.get(url)).json()).terminals[0].connectedClientCount,
      )
      .toBe(0);
    expect((await (await page.request.get(url)).json()).terminals[0]).toMatchObject({
      id: initial.terminals[0].id,
      state: 'running',
    });

    await toggle.tap();
    await expectTerminalReady(page);
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('AW_MOBILE_OK');
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(panel).toHaveCSS('height', '390px');
    expect(await panel.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
    await expect(panel.getByRole('separator', { includeHidden: true })).toBeHidden();
    expect((await (await page.request.get(url)).json()).terminals[0].id).toBe(
      initial.terminals[0].id,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toHaveCSS('height', '844px');
    await panel.getByRole('button', { name: 'New terminal', exact: true }).tap();
    await expect(panel.getByRole('tab')).toHaveCount(2);
    await expectTerminalReady(page);
    await panel.getByRole('button', { name: 'Close Terminal 2', exact: true }).tap();
    await expect(panel.getByRole('tab')).toHaveCount(1);
    await close.tap();
    await expect(panel).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect((await (await page.request.get(url)).json()).terminals).toEqual([]);
  });

  test('follows keyboard viewport changes without overwriting the desktop height', async ({
    page,
  }) => {
    await page.addInitScript(
      ({ preference }) => {
        localStorage.setItem(preference, '360');
        // Emulation cannot open a real phone keyboard. Exercise the same resize
        // and pan events explicitly, including browsers that pan the viewport.
        const viewport = new EventTarget();
        const rect = { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 };
        for (const key of Object.keys(rect) as Array<keyof typeof rect>)
          Object.defineProperty(viewport, key, { get: () => rect[key] });
        Object.defineProperty(viewport, 'scale', { value: 1 });
        Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
        window.addEventListener('aw-test-terminal-viewport', (event) => {
          Object.assign(rect, (event as CustomEvent).detail);
          viewport.dispatchEvent(new Event('resize'));
          viewport.dispatchEvent(new Event('scroll'));
        });
      },
      { preference: `aw-terminal-height:${fixture.email}` },
    );
    await page.request.post(`${fixture.url}/api/auth/login/password`, {
      data: { email: fixture.email, password: fixture.password },
    });
    await page.goto(fixture.url);
    await page.getByRole('button', { name: 'Toggle Terminal', exact: true }).tap();
    const panel = page.getByRole('dialog', { name: 'Session terminal' });
    await expectTerminalReady(page);
    const url = `${fixture.url}/api/sessions/${fixture.sessionId}/terminals`;
    await expect
      .poll(async () => (await (await page.request.get(url)).json()).terminals[0].rows)
      .toBeGreaterThan(30);
    const initial = (await (await page.request.get(url)).json()).terminals[0];
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('aw-test-terminal-viewport', {
          detail: { height: 350, offsetTop: 64 },
        }),
      ),
    );
    await expect(panel).toHaveCSS('height', '350px');
    expect(await panel.boundingBox()).toEqual({ x: 0, y: 64, width: 390, height: 350 });
    await expect
      .poll(async () => (await (await page.request.get(url)).json()).terminals[0].rows)
      .toBeLessThan(initial.rows);
    await page.keyboard.type('printf "AW_%s\\n" "KEYBOARD_OK"');
    await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('AW_KEYBOARD_OK');
    const cursor = await panel.locator('.xterm-cursor').boundingBox();
    expect(cursor).not.toBeNull();
    expect(cursor!.y + cursor!.height).toBeLessThanOrEqual(414);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        `aw-terminal-height:${fixture.email}`,
      ),
    ).toBe('360');

    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('aw-test-terminal-viewport', {
          detail: { height: 844, offsetTop: 0 },
        }),
      ),
    );
    await expect(panel).toHaveCSS('height', '844px');
    // Returning to desktop restores the saved size and normal non-modal UI.
    await page.setViewportSize({ width: 1200, height: 900 });
    const desktopPanel = page.getByRole('region', { name: 'Session terminal' });
    await expect(desktopPanel).toHaveCSS('position', 'relative');
    await expect(desktopPanel).toHaveCSS('height', '360px');
    await expect(desktopPanel.getByRole('separator')).toBeVisible();
    expect(
      await page.locator('.shell-header').evaluate((element) => (element as HTMLElement).inert),
    ).toBe(false);
    expect((await (await page.request.get(url)).json()).terminals[0].id).toBe(initial.id);
    await desktopPanel.getByRole('button', { name: 'Close Terminal 1', exact: true }).click();
    await expect(desktopPanel).toHaveCount(0);
  });
});

test('real HTTP terminal: input, resize, reconnect and closing the last tab hides the panel', async ({
  page,
}) => {
  let hmrConnected = false;
  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      if (socket.url().includes('/_next/webpack-hmr')) hmrConnected = true;
      try {
        const message = JSON.parse(frame.payload.toString());
        if (message.type === 'error') console.error('Terminal protocol error:', message.message);
      } catch {}
    });
    socket.on('socketerror', (error) => console.error('Terminal socket error:', error));
  });
  const login = await page.request.post(`${fixture.url}/api/auth/login/password`, {
    data: { email: fixture.email, password: fixture.password },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto(fixture.url);
  if (process.env.AW_TERMINAL_TEST_WEB_DEV) await expect.poll(() => hmrConnected).toBe(true);
  const toggle = page.getByRole('button', { name: 'Toggle Terminal', exact: true });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  const panel = page.getByRole('region', { name: 'Session terminal' });
  await expectTerminalReady(page);
  await expect(panel.getByRole('button', { name: 'Terminal network settings' })).toHaveCount(0);
  await expect(panel).not.toContainText('Closes after 12 hours without a connection');
  const fontFamily = await page
    .locator('.xterm-rows')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(fontFamily).toContain('Consolas');
  expect(fontFamily).toContain('DejaVu Sans Mono');
  expect(fontFamily.toLowerCase()).not.toContain('courier');
  const initial = await (
    await page.request.get(`${fixture.url}/api/sessions/${fixture.sessionId}/terminals`)
  ).json();
  expect(initial.terminals).toHaveLength(1);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('printf "AW_%s\\n" "BROWSER_OK"');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('AW_BROWSER_OK');
  const before = await panel.boundingBox();
  const separator = panel.getByRole('separator');
  await separator.focus();
  await page.keyboard.press('ArrowUp');
  expect((await panel.boundingBox())!.height).toBeGreaterThan(before!.height);
  await panel.getByRole('button', { name: 'Hide terminal panel' }).click();
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await expectTerminalReady(page);
  const after = await (
    await page.request.get(`${fixture.url}/api/sessions/${fixture.sessionId}/terminals`)
  ).json();
  expect(after.terminals[0].id).toBe(initial.terminals[0].id);
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('AW_BROWSER_OK');
  const viewer = await page.context().newPage();
  try {
    await viewer.goto(fixture.url);
    await viewer.getByRole('button', { name: 'Toggle Terminal', exact: true }).click();
    const viewerPanel = viewer.getByRole('region', { name: 'Session terminal' });
    await expect(viewerPanel.getByRole('status')).toContainText('Read-only');
    await expect(viewerPanel.locator('.terminal-cwd')).toHaveCount(0);
    await viewerPanel.getByRole('button', { name: 'Take control' }).click();
    await expectTerminalReady(viewer);
    await expect(panel.getByRole('status')).toContainText('Read-only');
    await panel.getByRole('button', { name: 'Take control' }).click();
    await expectTerminalReady(page);
  } finally {
    await viewer.close();
  }
  await panel.getByRole('button', { name: 'New terminal', exact: true }).click();
  await expect(panel.getByRole('tab')).toHaveCount(2);
  await expectTerminalReady(page);
  await panel.getByRole('button', { name: 'Close Terminal 2', exact: true }).click();
  await expect(panel.getByRole('tab')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Close Terminal 1', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const final = await (
    await page.request.get(`${fixture.url}/api/sessions/${fixture.sessionId}/terminals`)
  ).json();
  expect(final.terminals).toEqual([]);
  await toggle.click();
  await expectTerminalReady(page);
  const reopened = await (
    await page.request.get(`${fixture.url}/api/sessions/${fixture.sessionId}/terminals`)
  ).json();
  expect(reopened.terminals).toHaveLength(1);
  expect(reopened.terminals[0].id).not.toBe(initial.terminals[0].id);
  await panel.getByRole('button', { name: 'Close Terminal 1', exact: true }).click();
  await expect(panel).toHaveCount(0);
});

test('Origin rejection and logout preserve the PTY but revoke its connection', async ({
  page,
  browser,
}) => {
  await page.request.post(`${fixture.url}/api/auth/login/password`, {
    data: { email: fixture.email, password: fixture.password },
  });
  await page.goto(fixture.url);
  await page.getByRole('button', { name: 'Toggle Terminal', exact: true }).click();
  await expectTerminalReady(page);
  const url = `${fixture.url}/api/sessions/${fixture.sessionId}/terminals`;
  const denied = await page.request.post(`${url}/ensure`, {
    headers: { origin: 'http://untrusted.example' },
    data: {},
  });
  expect(denied.status()).toBe(403);
  const removedSettings = await page.request.get(`${fixture.url}/api/settings/terminal-network`);
  expect(removedSettings.status()).toBe(404);
  const observer = await browser.newContext();
  try {
    await observer.request.post(`${fixture.url}/api/auth/login/password`, {
      data: { email: fixture.email, password: fixture.password },
    });
    const first = await (await observer.request.get(url)).json();
    const id = first.terminals[0].id;
    expect(first.terminals[0].connectedClientCount).toBe(1);
    await page.request.post(`${fixture.url}/api/auth/logout`);
    await expect
      .poll(
        async () =>
          (await (await observer.request.get(url)).json()).terminals[0].connectedClientCount,
      )
      .toBe(0);
    const disconnected = await (await observer.request.get(url)).json();
    expect(disconnected.terminals[0]).toMatchObject({ id, state: 'running' });
    expect(disconnected.terminals[0].unattachedSince).not.toBeNull();
    const closed = await observer.request.delete(`${fixture.url}/api/terminals/${id}`, {
      headers: { origin: fixture.url },
    });
    expect(closed.status()).toBe(204);
  } finally {
    await observer.close();
  }
});
