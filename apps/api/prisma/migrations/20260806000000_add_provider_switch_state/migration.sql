CREATE TABLE "RuntimeControl" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerSwitchInProgress" BOOLEAN NOT NULL DEFAULT false,
    "providerSwitchOwner" TEXT,
    "providerSwitchLeaseExpires" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
