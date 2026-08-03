-- Event-backed outbound queue items reference their canonical Event row
-- instead of duplicating the complete event payload in BotMessage.payloadRaw.

ALTER TABLE "BotMessage" ADD COLUMN "eventId" TEXT
  REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "BotMessage_eventId_key" ON "BotMessage"("eventId");
