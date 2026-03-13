-- Alter User model for first-party auth/session support.
ALTER TABLE "User"
ADD COLUMN "displayName" TEXT,
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "authPolicy" TEXT NOT NULL DEFAULT 'password_or_webauthn',
ADD COLUMN "passwordHash" TEXT,
ADD COLUMN "lastLoginAt" TIMESTAMP(3),
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Session table for secure server-side cookie auth.
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthSession_sessionTokenHash_key" ON "AuthSession"("sessionTokenHash");
CREATE INDEX "AuthSession_userId_expiresAt_revokedAt_idx" ON "AuthSession"("userId", "expiresAt", "revokedAt");

ALTER TABLE "AuthSession"
ADD CONSTRAINT "AuthSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma @updatedAt columns should not keep a DB default after backfill.
ALTER TABLE "User" ALTER COLUMN "updatedAt" DROP DEFAULT;
