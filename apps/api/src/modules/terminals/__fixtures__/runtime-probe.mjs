// Integration-test child: represents the API owning a real PTY, never deployed.
import { TerminalProcessFactory } from '../terminal-process.ts';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

const factory = new TerminalProcessFactory();
const pty = await factory.spawn(randomUUID(), '/bin/bash', ['--noprofile', '--norc', '-i'], {
  cwd: os.tmpdir(),
  cols: 80,
  rows: 24,
  name: 'xterm-256color',
  env: { ...process.env, NODE_OPTIONS: '', TERM: 'xterm-256color' },
});
let output = '';
let sent = false;
pty.onData((data) => {
  output += data;
  const root = /AW_PID=(\d+)/.exec(output);
  const child = /AW_CHILD=(\d+)/.exec(output);
  if (root && child && !sent) {
    sent = true;
    process.send?.({ type: 'ready', pid: Number(root[1]), childPid: Number(child[1]) });
  }
});
pty.write('printf "\\nAW_PID=%s\\n" "$$"; sleep 300 & printf "\\nAW_CHILD=%s\\n" "$!"\r');
process.on('message', (message) => {
  if (message === 'close')
    void pty
      .close()
      .then(() => factory.shutdown())
      .then(() => process.exit(0));
});
