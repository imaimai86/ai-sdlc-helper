import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ui } from '../src/cli/ui.js';
import { run, tmp } from './helpers.js';

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), env: process.env, cwd: tmp() } };
};

test('ui says the web app is not built when its server is missing', async () => {
  const o = io();
  expect(await ui(['ui', '--no-open'], ['--port'], o.io, { file: path.join(tmp(), 'missing.js') })).toBe(1);
  expect(o.err.join('\n')).toMatch(/not built.*npm run build/);
});

test('ui refuses a port that is not a number and extra arguments', async () => {
  const o = io();
  expect(await ui(['ui', '--port', 'x'], ['--port'], o.io)).toBe(2);
  expect(await ui(['ui', 'extra'], ['--port'], o.io)).toBe(2);
});

test('ui starts the server with the port and folder, prints its URLs, and closes it when stopped', async () => {
  const dir = tmp();
  const file = path.join(dir, 'server.mjs');
  fs.writeFileSync(file, `export let seen = null; export let closed = false;
export async function startServer(o) { seen = o; return { url: 'http://127.0.0.1:' + o.port, openUrl: 'http://127.0.0.1:' + o.port + '/?t=abc', close: async () => { closed = true; } }; }`);
  const o = io();
  let stop!: () => void;
  const stopped = new Promise<void>(r => { stop = r; });
  const done = ui(['ui', '--no-open', '--port', '5123'], ['--port'], o.io, { file, stopSignal: stopped });
  await new Promise(r => setTimeout(r, 50));
  stop();
  expect(await done).toBe(0);
  const mod = await import(`file://${file}`);
  expect(mod.seen).toEqual(expect.objectContaining({ port: 5123, cwd: o.io.cwd }));
  expect(mod.closed).toBe(true);
  expect(o.out).toEqual(['ai-sdlc-helper ui: http://127.0.0.1:5123', 'Open (signs this browser in): http://127.0.0.1:5123/?t=abc', 'Stop with Ctrl-C; runs go on without it.']);
});

test('help lists the ui command', async () => {
  expect((await run(['help'])).stdout).toContain('ui [--port <n>] [--no-open]');
});
