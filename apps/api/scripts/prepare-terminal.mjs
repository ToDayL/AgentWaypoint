// node-pty 1.1.0's macOS tarball may omit the executable bit on spawn-helper.
// Fix only the installed package's known helper paths, at install time.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

if (process.platform === 'darwin') {
  const root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  for (const relative of [
    'build/Release/spawn-helper',
    'build/Debug/spawn-helper',
    `prebuilds/darwin-${process.arch}/spawn-helper`,
  ]) {
    const file = path.join(root, relative);
    if (fs.existsSync(file)) fs.chmodSync(file, fs.statSync(file).mode | 0o111);
  }
}
