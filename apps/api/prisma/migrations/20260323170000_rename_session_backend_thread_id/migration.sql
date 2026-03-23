DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Session'
      AND column_name = 'codexThreadId'
  ) THEN
    ALTER TABLE "Session" RENAME COLUMN "codexThreadId" TO "backendThreadId";
  END IF;
END $$;
