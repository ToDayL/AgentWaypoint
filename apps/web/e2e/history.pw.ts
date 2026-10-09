import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";

let server: ChildProcess;
let fixture: {
  url: string;
  apiUrl: string;
  sessionId: string;
  turnId: string;
  longSessionId: string;
  longTurnId: string;
  timelineSessionId: string;
  timelineTurnId: string;
  legacySessionId: string;
  legacyTurnId: string;
  email: string;
  password: string;
};

test.beforeAll(async () => {
  server = fork(
    path.resolve("apps/api/src/test-utils/history-browser-server.ts"),
    [],
    {
      cwd: path.resolve("apps/api"),
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  server.stdout?.on("data", (data) => {
    output += data.toString();
  });
  server.stderr?.on("data", (data) => {
    output += data.toString();
  });
  fixture = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`History fixture timeout: ${output}`)),
      50_000,
    );
    server.once("message", (message: typeof fixture) => {
      clearTimeout(timeout);
      resolve(message);
    });
    server.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`History fixture exited: ${output}`));
    });
  });
});
test.afterAll(async () => {
  if (server?.connected) {
    const closed = new Promise<void>((resolve) =>
      server.once("exit", () => resolve()),
    );
    server.send("stop");
    await closed;
  }
});

async function emit(
  request: APIRequestContext,
  type: string,
  payload: Record<string, unknown>,
  turnId = fixture.turnId,
) {
  const response = await request.post(
    `${fixture.apiUrl}/internal/runner/turns/${turnId}/events`,
    { data: { type, payload } },
  );
  expect(response.ok()).toBe(true);
}

async function chatLayout(page: Page) {
  return page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>(".chat-thread")!;
    const composer = document.querySelector<HTMLElement>(".chat-composer")!;
    return {
      height: thread.clientHeight,
      scrollTop: thread.scrollTop,
      bottomGap: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
      composerTop: composer.getBoundingClientRect().top,
    };
  });
}

test("keeps live actions in an independent active bubble, floats steer inputs, and scopes timelines", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  await page.request.post(`${fixture.url}/api/auth/login/password`, {
    data: { email: fixture.email, password: fixture.password },
  });
  const historyResponse = page.waitForResponse((response) =>
    response.url().includes(`/sessions/${fixture.sessionId}/history`),
  );
  await page.goto(fixture.url);
  const initialHistory = await (await historyResponse).json();
  expect(initialHistory.hasMore).toBe(false);
  expect(initialHistory).not.toHaveProperty("turns");
  expect(initialHistory.activeTurn).toMatchObject({
    id: fixture.turnId,
    historyVersion: 2,
    eventCursor: 1,
  });
  expect(initialHistory.latestTurn.id).toBe(fixture.turnId);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await expect(page.locator(".chat-markdown")).toHaveText(["Initial request"]);
  await expect(
    page
      .locator(".chat-message-assistant")
      .last()
      .getByRole("button", { name: "Live stream", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".chat-message-assistant")
      .last()
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await emit(page.request, "assistant.message.started", { itemId: "a" });
  await emit(page.request, "assistant.delta", {
    itemId: "a",
    text: "First draft",
  });
  await expect(page.locator(".chat-markdown")).toHaveText([
    "Initial request",
    "First draft",
  ]);
  const firstMessage = `First complete message\n\n${"Reviewing the current implementation. ".repeat(180)}`;
  await emit(page.request, "assistant.message.completed", {
    itemId: "a",
    text: firstMessage,
    phase: "commentary",
  });
  await expect(page.locator(".chat-markdown")).toHaveText([
    "Initial request",
    firstMessage,
  ]);
  await expect(page.getByText("Working...", { exact: true })).toBeVisible();
  await expect(page.locator(".chat-message-assistant")).toHaveCount(2);
  await expect(
    page
      .locator(".chat-message-assistant")
      .first()
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".chat-message-assistant")
      .first()
      .getByRole("button", { name: "Inspect timeline", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".chat-message-assistant").last()).toContainText(
    "Thinking...",
  );
  await expect(
    page
      .locator(".chat-message-assistant")
      .last()
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".chat-message-assistant")
      .last()
      .getByRole("button", { name: "Live stream", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator(".chat-turn-activity")).toHaveCount(0);
  await expect
    .poll(async () => (await chatLayout(page)).bottomGap)
    .toBeLessThanOrEqual(1);
  const beforeQueue = await chatLayout(page);
  expect(beforeQueue.scrollTop).toBeGreaterThan(0);
  await emit(page.request, 'tool.started', { itemId: 'compact', kind: 'contextCompaction', title: 'contextCompaction' });
  await emit(page.request, 'tool.completed', { itemId: 'compact', kind: 'contextCompaction', title: 'contextCompaction' });
  await expect(page.locator('.chat-message-assistant').last()).toContainText('Thinking...');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await test.info().attach("Independent working Assistant bubble", {
    body: await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("working-bubble-desktop.png"),
    }),
    contentType: "image/png",
  });

  const editor = page.getByPlaceholder("Send a message...");
  await editor.fill("Do not change the interface");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/turns/${fixture.turnId}/steer`) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Steer Current Turn", exact: true })
    .click();
  const result = await (await responsePromise).json();
  const clientId = result.input.clientRequestId;
  expect(clientId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await expect(
    page.getByRole("region", { name: "Pending inputs", exact: true }),
  ).toContainText("Do not change the interface");
  await expect(
    page
      .getByRole("region", { name: "Pending inputs", exact: true })
      .getByText("queued", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".chat-markdown")).toHaveCount(2);
  expect(await chatLayout(page)).toEqual(beforeQueue);
  await page
    .getByRole("button", { name: "Collapse pending inputs", exact: true })
    .click();
  await expect(page.locator("#pending-input-list")).toBeHidden();
  expect(await chatLayout(page)).toEqual(beforeQueue);
  await page
    .getByRole("button", { name: "Expand pending inputs", exact: true })
    .click();
  await expect(page.locator("#pending-input-list")).toBeVisible();
  expect(await chatLayout(page)).toEqual(beforeQueue);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".chat-thread").evaluate((thread) => {
    thread.scrollTop = thread.scrollHeight;
  });
  const mobileQueue = await chatLayout(page);
  await test.info().attach("Pending inputs expanded on mobile", {
    body: await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("pending-expanded-mobile.png"),
    }),
    contentType: "image/png",
  });
  await page
    .getByRole("button", { name: "Collapse pending inputs", exact: true })
    .click();
  expect(await chatLayout(page)).toEqual(mobileQueue);
  await test.info().attach("Pending inputs collapsed on mobile", {
    body: await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("pending-collapsed-mobile.png"),
    }),
    contentType: "image/png",
  });
  await page
    .getByRole("button", { name: "Expand pending inputs", exact: true })
    .click();
  expect(await chatLayout(page)).toEqual(mobileQueue);
  const drawer = await page
    .getByRole("region", { name: "Pending inputs", exact: true })
    .boundingBox();
  const composer = await page.locator(".chat-composer").boundingBox();
  expect(drawer!.y + drawer!.height).toBeLessThanOrEqual(composer!.y + 1);
  expect(drawer!.x).toBeGreaterThanOrEqual(composer!.x);
  expect(drawer!.x + drawer!.width).toBeLessThanOrEqual(
    composer!.x + composer!.width,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Pending inputs", exact: true }),
  ).toContainText("Do not change the interface");
  await expect(page.locator(".chat-markdown")).toHaveCount(2);
  await expect(page.locator(".chat-message-assistant")).toHaveCount(2);
  await expect(
    page
      .locator(".chat-message-assistant")
      .first()
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "Collapse pending inputs", exact: true })
    .click();
  await page
    .locator(".chat-message-assistant")
    .last()
    .getByRole("button", { name: "Live stream", exact: true })
    .click();
  await page.getByRole("button", { name: "Pin insights", exact: true }).click();

  await emit(page.request, "tool.started", {
    itemId: "cmd",
    kind: "commandExecution",
    command: "echo test",
    title: "Inspect implementation",
  });
  await emit(page.request, "tool.completed", {
    itemId: "cmd",
    kind: "commandExecution",
    command: "echo test",
    title: "Inspect implementation",
  });
  await expect(page.locator(".timeline-list")).toContainText(
    "Inspect implementation",
  );
  await emit(page.request, "user.message.accepted", {
    itemId: "user-steer",
    clientId,
    content: "Do not change the interface",
  });
  await expect(
    page.getByRole("region", { name: "Pending inputs", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".chat-markdown")).toHaveText([
    "Initial request",
    firstMessage,
    "Do not change the interface",
  ]);
  await expect(
    page
      .locator(".chat-message-assistant")
      .last()
      .getByRole("button", { name: "Live stream", exact: true }),
  ).toBeVisible();
  await emit(page.request, "assistant.message.started", { itemId: "b" });
  await emit(page.request, "assistant.delta", {
    itemId: "b",
    text: "Second draft",
  });
  await expect(page.locator(".chat-markdown").last()).toHaveText(
    "Second draft",
  );
  await page.reload();
  await expect(page.locator(".chat-markdown")).toHaveText([
    "Initial request",
    firstMessage,
    "Do not change the interface",
    "Second draft",
  ]);
  await expect(
    page
      .locator(".chat-message-assistant")
      .first()
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".chat-message-assistant")
      .last()
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await page.locator(".chat-thread").evaluate((thread) => {
    thread.scrollTop = thread.scrollHeight;
  });
  await test.info().attach("Live actions in the latest Assistant bubble", {
    body: await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("live-bubble-desktop.png"),
    }),
    contentType: "image/png",
  });
  await emit(page.request, "assistant.message.completed", {
    itemId: "b",
    text: "Second complete message",
    phase: "final_answer",
  });
  await expect(page.locator(".chat-message-assistant")).toHaveCount(3);
  await expect(
    page
      .locator(".chat-message-assistant")
      .nth(1)
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".chat-message-assistant")
      .last()
      .getByRole("button", { name: "Live stream", exact: true }),
  ).toBeVisible();
  await emit(page.request, "diff.updated", {
    unifiedDiff:
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
  });
  await emit(page.request, "turn.completed", {});
  await expect(page.locator(".chat-markdown")).toHaveText([
    "Initial request",
    firstMessage,
    "Do not change the interface",
    "Second complete message",
  ]);
  await expect(page.getByText("Working...", { exact: true })).toHaveCount(0);
  await expect(page.locator(".chat-message-assistant")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);

  await page
    .locator(".chat-message-assistant")
    .first()
    .getByRole("button", { name: "Inspect timeline", exact: true })
    .click();
  await expect(page.getByText("Message timeline", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator(".timeline-list")).not.toContainText(
    "Steer received",
  );
  const entireTurn = page.getByRole("button", {
    name: "Entire turn",
    exact: true,
  });
  await expect(entireTurn).toHaveText("");
  await entireTurn.click();
  await expect(page.locator(".timeline-list")).toContainText("Steer received");
  await page
    .locator(".chat-message-assistant")
    .last()
    .getByRole("button", { name: "Inspect timeline", exact: true })
    .click();
  await expect(page.locator(".timeline-list")).toContainText("Steer received");
  await expect(page.locator(".timeline-list")).toContainText(
    "Do not change the interface",
  );
  await page.getByRole("button", { name: "Diff", exact: true }).click();
  await expect(
    page.getByText("Changes for the entire turn", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".insights-content")).toContainText("a.txt");

  await editor.fill("Cancel this follow-up");
  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/sessions/${fixture.sessionId}/turns`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const followUp = await (await started).json();
  const cancelled = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/turns/${followUp.turnId}/cancel`) &&
      response.request().method() === "POST",
  );
  await page
    .locator(".chat-message-assistant")
    .last()
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect((await (await cancelled).json()).status).toBe("cancelled");
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Live stream", exact: true }),
  ).toHaveCount(0);
});

test('virtualizes a long timeline and preserves anchors through output growth, tabs, and resizing', async ({
  page,
}) => {
  await page.request.post(`${fixture.url}/api/auth/login/password`, {
    data: { email: fixture.email, password: fixture.password },
  });
  await page.goto(fixture.url);
  await page.getByText('Long event timeline', { exact: true }).click();
  await page.getByRole('button', { name: 'Live stream', exact: true }).click();
  await page.getByRole('button', { name: 'Pin insights', exact: true }).click();
  const timeline = page.locator('.timeline-list');
  const layout = () =>
    timeline.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>('.timeline-virtual-row')];
      const visible = rows.find((row) => row.getBoundingClientRect().bottom > rect.top + 1);
      return {
        id: visible?.dataset.timelineEventId,
        top: visible ? visible.getBoundingClientRect().top - rect.top : 0,
        bottomGap: element.scrollHeight - element.clientHeight - element.scrollTop,
        bufferAbove: rows[0] ? rect.top - rows[0].getBoundingClientRect().top : 0,
        bufferBelow: rows.at(-1) ? rows.at(-1)!.getBoundingClientRect().bottom - rect.bottom : 0,
        count: rows.length,
      };
    });
  await expect(timeline).toContainText('Timeline tool 799');
  await expect.poll(async () => (await layout()).bottomGap).toBeLessThanOrEqual(1);
  expect((await layout()).count).toBeLessThan(120);
  await timeline.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(timeline.locator('.timeline-event-title').first()).toHaveText('Timeline tool 0');
  await timeline.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await expect.poll(async () => (await layout()).bufferAbove).toBeGreaterThanOrEqual(1200);
  await expect.poll(async () => (await layout()).bufferBelow).toBeGreaterThanOrEqual(1200);
  const anchor = await layout();
  const assertAnchor = async () => {
    await expect.poll(async () => (await layout()).id).toBe(anchor.id);
    await expect
      .poll(async () => Math.abs((await layout()).top - anchor.top))
      .toBeLessThanOrEqual(2);
  };

  // Expand a measured row above the fold without scrolling it into view.
  const expandedId = await timeline.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('.timeline-virtual-row')].find(
      (candidate) =>
        candidate.getBoundingClientRect().bottom < top - 100 &&
        candidate.querySelector('button[aria-label="Expand details"]'),
    )!;
    row.querySelector<HTMLButtonElement>('button[aria-label="Expand details"]')!.click();
    return row.dataset.timelineEventId!;
  });
  await expect(
    timeline.locator(`[data-timeline-event-id="${expandedId}"]`).getByRole('button', {
      name: 'Collapse details',
      exact: true,
    }),
  ).toHaveCount(1);
  await assertAnchor();
  await emit(
    page.request,
    'tool.started',
    {
      itemId: 'timeline-live',
      kind: 'customTool',
      title: 'Appended live tool',
    },
    fixture.timelineTurnId,
  );
  await emit(
    page.request,
    'tool.output',
    {
      itemId: 'timeline-live',
      kind: 'customTool',
      text: 'Live output while reading older events.',
    },
    fixture.timelineTurnId,
  );
  await assertAnchor();

  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await expect(timeline).toHaveCount(0);
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await assertAnchor();
  await expect(
    timeline.locator(`[data-timeline-event-id="${expandedId}"]`).getByRole('button', {
      name: 'Collapse details',
      exact: true,
    }),
  ).toHaveCount(1);

  await timeline.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const liveTool = timeline.locator('.timeline-event').filter({ hasText: 'Appended live tool' });
  await expect(liveTool).toBeVisible();
  await expect.poll(async () => (await layout()).bottomGap).toBeLessThanOrEqual(1);
  for (let chunk = 0; chunk < 3; chunk++) {
    await emit(
      page.request,
      'tool.output',
      {
        itemId: 'timeline-live',
        kind: 'customTool',
        text: Array.from(
          { length: 12 },
          (_, line) => `\nLive chunk ${chunk}, line ${line}: growing tool output.`,
        ).join(''),
      },
      fixture.timelineTurnId,
    );
    await expect(liveTool.locator('pre')).toContainText(`Live chunk ${chunk}, line 11`);
    await expect.poll(async () => (await layout()).bottomGap).toBeLessThanOrEqual(1);
  }
  await liveTool.getByRole('button', { name: 'Expand details', exact: true }).click();
  await expect(liveTool.locator('pre')).toContainText('Live chunk 0, line 0');
  await expect.poll(async () => (await layout()).bottomGap).toBeLessThanOrEqual(1);
  await emit(
    page.request,
    'tool.completed',
    {
      itemId: 'timeline-live',
      kind: 'customTool',
      summary: 'Finished live output.',
    },
    fixture.timelineTurnId,
  );
  await expect(liveTool.locator('.status-pill')).toHaveText('completed');
  await expect.poll(async () => (await layout()).bottomGap).toBeLessThanOrEqual(1);

  const resize = page.getByRole('separator', { name: 'Resize insights panel', exact: true });
  const handle = (await resize.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 220, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await layout()).bottomGap).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Live stream', exact: true }).click();
  await expect(timeline).toBeVisible();
  await expect.poll(async () => (await layout()).bottomGap).toBeLessThanOrEqual(1);
  expect((await layout()).count).toBeLessThan(120);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => (await layout()).bottomGap).toBeLessThanOrEqual(1);

  // A different scope starts at its latest event rather than restoring this offset.
  await page.getByText('Legacy protocol history', { exact: true }).click();
  await page.getByRole('button', { name: 'Live stream', exact: true }).click();
  await expect(timeline).not.toContainText('Appended live tool');
  await expect(timeline).toContainText('No events yet.');
  await expect.poll(async () => (await layout()).bottomGap).toBeLessThanOrEqual(1);
});

test('loads complete history once, buffers virtual rows, preserves reading position, and calibrates one turn', async ({
  page,
}) => {
  const requests: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith(`/sessions/${fixture.longSessionId}/history`)) requests.push(url);
  });
  await page.request.post(`${fixture.url}/api/auth/login/password`, {
    data: { email: fixture.email, password: fixture.password },
  });
  await page.goto(fixture.url);
  await expect(page.getByText('Long message history', { exact: true })).toBeVisible();
  const initialResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/sessions/${fixture.longSessionId}/history`),
  );
  await page.getByText('Long message history', { exact: true }).click();
  const initial = await (await initialResponse).json();
  expect(initial.messages).toHaveLength(601);
  expect(initial.messages[0].content).toContain('History message 0');
  expect(initial.hasMore).toBe(false);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.search).toBe('');
  await expect(page.getByRole('button', { name: 'Show More', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect.poll(async () => (await chatLayout(page)).bottomGap).toBeLessThanOrEqual(1);
  expect(await page.locator('.chat-virtual-row').count()).toBeLessThan(100);

  await page.locator('.chat-thread').evaluate((thread) => {
    thread.scrollTop = 0;
  });
  await expect(page.locator('.chat-markdown').first()).toContainText('History message 0');
  await page.locator('.chat-thread').evaluate((thread) => {
    thread.scrollTop = thread.scrollHeight / 2;
  });
  const readingAnchor = async () =>
    page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>('.chat-thread')!;
      const rect = thread.getBoundingClientRect();
      const rows = [...thread.querySelectorAll<HTMLElement>('.chat-virtual-row')];
      const visible = rows.find((row) => row.getBoundingClientRect().bottom > rect.top + 1)!;
      return {
        id: visible?.dataset.messageId,
        top: visible ? visible.getBoundingClientRect().top - rect.top : 0,
        bufferAbove: rows[0] ? rect.top - rows[0].getBoundingClientRect().top : 0,
        bufferBelow: rows.at(-1) ? rows.at(-1)!.getBoundingClientRect().bottom - rect.bottom : 0,
        height: thread.clientHeight,
      };
    });
  await expect.poll(async () => (await readingAnchor()).bufferAbove).toBeGreaterThanOrEqual(1200);
  await expect.poll(async () => (await readingAnchor()).bufferBelow).toBeGreaterThanOrEqual(1200);
  const anchor = await readingAnchor();
  await page.getByRole('button', { name: 'Config', exact: true }).click();
  await expect(page.locator('.chat-thread')).toHaveCount(0);
  await page.getByRole('button', { name: 'Explorer', exact: true }).click();
  await expect.poll(async () => (await readingAnchor()).id).toBe(anchor.id);
  expect(Math.abs((await readingAnchor()).top - anchor.top)).toBeLessThanOrEqual(2);
  await emit(page.request, 'assistant.message.started', { itemId: 'long-a' }, fixture.longTurnId);
  await emit(
    page.request,
    'assistant.delta',
    { itemId: 'long-a', text: 'Streamed response' },
    fixture.longTurnId,
  );
  await emit(
    page.request,
    'assistant.message.completed',
    { itemId: 'long-a', text: 'Completed while reading history' },
    fixture.longTurnId,
  );
  const scopedResponse = page.waitForResponse((response) =>
    response
      .url()
      .includes(`/sessions/${fixture.longSessionId}/history?turnId=${fixture.longTurnId}`),
  );
  await emit(page.request, 'turn.completed', {}, fixture.longTurnId);
  const scoped = await (await scopedResponse).json();
  expect(scoped.messages.map((message: { content: string }) => message.content)).toEqual([
    'Continue long history',
    'Completed while reading history',
  ]);
  expect(scoped.messageTurn.status).toBe('completed');
  await expect.poll(async () => (await readingAnchor()).id).toBe(anchor.id);
  expect(Math.abs((await readingAnchor()).top - anchor.top)).toBeLessThanOrEqual(2);
  expect(requests.filter((url) => !url.searchParams.has('turnId'))).toHaveLength(1);

  await page.locator('.chat-thread').evaluate((thread) => {
    thread.scrollTop = thread.scrollHeight;
  });
  await expect(page.locator('.chat-markdown').last()).toHaveText('Completed while reading history');
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/sessions/${fixture.longSessionId}/turns`) &&
      response.request().method() === 'POST',
  );
  await page.getByPlaceholder('Send a message...').fill('New turn without reloading old history');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const created = await (await createdResponse).json();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await emit(page.request, 'assistant.message.started', { itemId: 'long-b' }, created.turnId);
  await emit(
    page.request,
    'assistant.delta',
    { itemId: 'long-b', text: 'Streaming growth\n\n' + 'A growing paragraph.\n\n'.repeat(80) },
    created.turnId,
  );
  await expect(page.locator('.chat-markdown').last()).toContainText('Streaming growth');
  await expect.poll(async () => (await chatLayout(page)).bottomGap).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await chatLayout(page)).bottomGap).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const cancelledResponse = page.waitForResponse((response) =>
    response.url().includes(`/sessions/${fixture.longSessionId}/history?turnId=${created.turnId}`),
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await (await cancelledResponse).json()).messageTurn.status).toBe('cancelled');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  expect(requests.filter((url) => !url.searchParams.has('turnId'))).toHaveLength(1);
  await page.locator('.chat-thread').evaluate((thread) => {
    thread.scrollTop = 0;
  });
  await expect(page.locator('.chat-markdown').first()).toContainText('History message 0');
});

test('calibrates legacy streamed output into one persisted message', async ({ page }) => {
  await page.request.post(`${fixture.url}/api/auth/login/password`, {
    data: { email: fixture.email, password: fixture.password },
  });
  await page.goto(fixture.url);
  await page.getByText('Legacy protocol history', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await emit(page.request, 'assistant.delta', { text: 'Legacy streamed output' }, fixture.legacyTurnId);
  await expect(page.locator('.chat-markdown').last()).toHaveText('Legacy streamed output');
  const calibratedResponse = page.waitForResponse((response) =>
    response.url().includes(`/sessions/${fixture.legacySessionId}/history?turnId=${fixture.legacyTurnId}`),
  );
  await emit(page.request, 'turn.completed', { content: 'Legacy streamed output' }, fixture.legacyTurnId);
  const calibrated = await (await calibratedResponse).json();
  expect(calibrated.messageTurn).toMatchObject({ historyVersion: 1, status: 'completed' });
  expect(calibrated.messages).toHaveLength(2);
  await expect(page.locator('.chat-markdown')).toHaveText(['Legacy input', 'Legacy streamed output']);
  await expect(page.locator('.chat-message-assistant')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
});
