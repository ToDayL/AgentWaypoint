import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("message history migration", () => {
  it("preserves legacy bodies and outbox rows, backfills stable order, and accepts new items", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const root = resolve("prisma/migrations");
      const migration = "20260917000000_message_history";
      for (const directory of readdirSync(root)
        .sort()
        .filter((name) => /^\d/.test(name) && name < migration)) {
        db.exec(
          readFileSync(resolve(root, directory, "migration.sql"), "utf8"),
        );
      }
      db.exec(`
        INSERT INTO User (id, email, updatedAt) VALUES ('u', 'migration@example.test', CURRENT_TIMESTAMP);
        INSERT INTO Project (id, ownerUserId, name) VALUES ('p', 'u', 'legacy');
        INSERT INTO Session (id, projectId, title, status, updatedAt) VALUES ('s', 'p', 'legacy', 'active', CURRENT_TIMESTAMP);
        INSERT INTO Message (id, sessionId, role, content, createdAt) VALUES
          ('a', 's', 'user', 'Original prompt', 1000),
          ('b', 's', 'user', 'Old steer', 2000),
          ('c', 's', 'assistant', 'Entire old turn stays together', 3000);
        INSERT INTO Turn (id, sessionId, userMessageId, assistantMessageId, status) VALUES ('t', 's', 'a', 'c', 'completed');
        INSERT INTO BotMessage (id, projectId, sessionId, kind, payloadRaw, status) VALUES ('out', 'p', 's', 'turn_message', '{"content":"Entire old turn stays together"}', 'sent');
      `);
      db.exec(readFileSync(resolve(root, migration, "migration.sql"), "utf8"));
      const messages = db
        .prepare(
          "SELECT id, content, historySeq, turnId, state FROM Message ORDER BY historySeq",
        )
        .all();
      expect(messages).toEqual([
        {
          id: "a",
          content: "Original prompt",
          historySeq: 1,
          turnId: "t",
          state: "completed",
        },
        {
          id: "b",
          content: "Old steer",
          historySeq: 2,
          turnId: null,
          state: "completed",
        },
        {
          id: "c",
          content: "Entire old turn stays together",
          historySeq: 3,
          turnId: "t",
          state: "completed",
        },
      ]);
      expect(
        db.prepare("SELECT historyVersion, runnerCursor FROM Turn").get(),
      ).toEqual({ historyVersion: 1, runnerCursor: 0 });
      expect(
        db.prepare("SELECT status, messageId FROM BotMessage").get(),
      ).toEqual({ status: "sent", messageId: null });
      db.exec(
        `INSERT INTO TurnInput (id, turnId, clientRequestId, content) VALUES ('i', 't', 'request', 'Queued input')`,
      );
      expect(() =>
        db.exec(
          `INSERT INTO TurnInput (id, turnId, clientRequestId, content) VALUES ('j', 't', 'request', 'duplicate')`,
        ),
      ).toThrow();
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("DELETE FROM Session WHERE id = 's'");
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM TurnInput").get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
