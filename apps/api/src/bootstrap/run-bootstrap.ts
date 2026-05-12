/**
 * Standalone bootstrap entrypoint invoked by the agent-waypoint CLI before
 * starting the API. Runs interactive prompts, writes config.json, materializes
 * the SQLite schema with `prisma db push`, and inserts the admin user.
 */
import { ensureBootstrap } from './local-bootstrap';

async function main(): Promise<void> {
  await ensureBootstrap();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Bootstrap failed';
  process.stderr.write(`[agent-waypoint] ${message}\n`);
  process.exitCode = 1;
});
