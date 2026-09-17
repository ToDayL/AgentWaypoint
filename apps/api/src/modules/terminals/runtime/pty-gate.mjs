// No user shell runs until the independent cleanup guardian has registered us.
import net from 'node:net';
import { spawn } from 'node:child_process';

const [socketPath, id, token, shell, ...args] = process.argv.slice(2);
const connection = net.connect(socketPath);
const timeout = setTimeout(() => process.exit(1), 10_000);
connection.on('error', () => process.exit(1));
connection.on('connect', () =>
  connection.write(JSON.stringify({ id, token, pid: process.pid }) + '\n'),
);
let response = '';
connection.on('data', (data) => {
  response += data.toString();
  if (!response.includes('\n')) return;
  if (response.trim() !== 'ok') process.exit(1);
  clearTimeout(timeout);
  connection.destroy();
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  if (process.platform !== 'win32') {
    if (typeof process.execve !== 'function') {
      process.stderr.write('Terminal requires Node >= 22.15 on Unix.\r\n');
      process.exit(1);
    }
    process.execve(shell, [shell, ...args], env);
  } else {
    // ConPTY supplies the console to both processes. Keep this PID as the
    // cleanup root until the shell exits; never detach its child.
    const child = spawn(shell, args, { env, stdio: 'inherit', windowsHide: false });
    process.on('SIGINT', () => {});
    child.on('error', () => process.exit(1));
    child.on('exit', (code) => process.exit(code ?? 1));
  }
});
