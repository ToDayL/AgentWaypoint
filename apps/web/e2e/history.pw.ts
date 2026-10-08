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
) {
  const response = await request.post(
    `${fixture.apiUrl}/internal/runner/turns/${fixture.turnId}/events`,
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
  await page.goto(fixture.url);
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
