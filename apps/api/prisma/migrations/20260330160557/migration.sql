/*
  Warnings:

  - You are about to drop the `ChannelMessageContext` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "Turn" ADD COLUMN     "triggerIdentifier" TEXT NOT NULL DEFAULT 'web',
ADD COLUMN     "triggerMessageId" TEXT;

-- DropTable
DROP TABLE "ChannelMessageContext";
