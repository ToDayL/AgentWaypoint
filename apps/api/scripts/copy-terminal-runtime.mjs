import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.cpSync(
  path.join(root, 'src/modules/terminals/runtime'),
  path.join(root, 'dist/modules/terminals/runtime'),
  { recursive: true },
);
