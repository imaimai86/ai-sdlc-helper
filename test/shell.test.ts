import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { onPath, runShell, shellArgv, which, windowsShell } from '../src/shell.js';
import { managerAvailable } from '../src/config/node.js';
import { killTree } from '../src/runs/records.js';
import { pipelineArgv } from '../src/runs/index.js';
import { tmp } from './helpers.js';

/** A Windows file system: the files that exist, compared without case like NTFS. */
const winFiles = (...files: string[]) => {
  const set = new Set(files.map(f => f.toLowerCase()));
  return (file: string) => set.has(file.toLowerCase());
};

describe('finding programs (instead of command -v)', () => {
  test('macOS and Linux: the first executable file in PATH; files that are not executable and folders are skipped', () => {
    const a = tmp('shell-a-');
    const b = tmp('shell-b-');
    fs.writeFileSync(path.join(a, 'tool'), '#!/bin/sh\n', { mode: 0o644 });
    fs.mkdirSync(path.join(a, 'dir-tool'));
    fs.writeFileSync(path.join(b, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(b, 'dir-tool'), '#!/bin/sh\n', { mode: 0o755 });
    const env = { PATH: `${a}::${b}` };
    expect(which('tool', { env, platform: 'linux' })).toBe(path.join(b, 'tool'));
    expect(which('dir-tool', { env, platform: 'darwin' })).toBe(path.join(b, 'dir-tool'));
    expect(which('missing', { env, platform: 'linux' })).toBeNull();
    expect(which('', { env })).toBeNull();
    expect(which(path.join(b, 'tool'), { env: {} })).toBe(path.join(b, 'tool'));
    expect(onPath('tool', { env })).toBe(true);
    expect(onPath('tool', { env: {} })).toBe(false);
  });

  test('Windows: PATH (any case, quoted folders) with each PATHEXT extension, or the name as given', () => {
    const isProgram = winFiles('C:\\Tools\\claude.CMD', 'C:\\Program Files\\nodejs\\npx.cmd', 'D:\\bin\\fnm.exe', 'D:\\bin\\README');
    const env = { Path: 'C:\\Tools;"C:\\Program Files\\nodejs";;D:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const host = { env, platform: 'win32' as const, isProgram };
    expect(which('claude', host)).toBe('C:\\Tools\\claude.CMD');
    expect(which('npx', host)).toBe('C:\\Program Files\\nodejs\\npx.CMD');
    expect(which('fnm.exe', host)).toBe('D:\\bin\\fnm.exe');
    expect(which('README', host)).toBe('D:\\bin\\README');
    expect(which('volta', host)).toBeNull();
    expect(which('D:\\bin\\fnm', host)).toBe('D:\\bin\\fnm.EXE');
    // Without PATHEXT the usual four extensions apply.
    expect(which('fnm', { ...host, env: { PATH: 'D:\\bin' } })).toBe('D:\\bin\\fnm.EXE');
  });

  test('the Node version managers and code indexers are looked up the same way', () => {
    const bin = tmp('shell-bin-');
    fs.writeFileSync(path.join(bin, 'fnm'), '#!/bin/sh\n', { mode: 0o755 });
    expect(managerAvailable('fnm', { PATH: bin })).toBe(true);
    expect(managerAvailable('volta', { PATH: bin })).toBe(false);
  });
});

describe('running command lines (instead of sh -c)', () => {
  test('macOS and Linux: sh -c, or bash -c, exactly as before', () => {
    expect(shellArgv('npm test', { platform: 'linux' })).toEqual({ file: 'sh', args: ['-c', 'npm test'] });
    expect(shellArgv('npm test', { platform: 'darwin', bash: true })).toEqual({ file: 'bash', args: ['-c', 'npm test'] });
    const cwd = fs.realpathSync(tmp('shell-cwd-'));
    const r = runShell('printf "%s " "$((1 + 2))" && pwd -P', { cwd });
    expect(r).toMatchObject({ status: 0, stdout: `3 ${cwd}\n` });
    expect(runShell('[[ a == a ]]', { bash: true }).status).toBe(0);
    expect(runShell('exit 7').status).toBe(7);
  });

  test("Windows: Git's sh.exe or bash.exe (before WSL's bash on PATH), else sh on PATH, else cmd.exe", () => {
    const git = 'C:\\Program Files\\Git';
    const env = { Path: `C:\\Windows\\System32;${git}\\cmd`, ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const withGit = { env, platform: 'win32' as const, isProgram: winFiles(`${git}\\cmd\\git.exe`, `${git}\\bin\\sh.exe`, `${git}\\bin\\bash.exe`, 'C:\\Windows\\System32\\bash.exe') };
    expect(windowsShell('sh', withGit)).toBe(`${git}\\bin\\sh.exe`);
    expect(windowsShell('bash', withGit)).toBe(`${git}\\bin\\bash.exe`);
    expect(shellArgv('npm test', withGit)).toEqual({ file: `${git}\\bin\\sh.exe`, args: ['-c', 'npm test'] });
    expect(shellArgv('npm test', { ...withGit, bash: true })).toEqual({ file: `${git}\\bin\\bash.exe`, args: ['-c', 'npm test'] });

    // git from mingw64\bin: the shell is two folders up, in usr\bin.
    const mingw = { env: { PATH: `${git}\\mingw64\\bin` }, platform: 'win32' as const, isProgram: winFiles(`${git}\\mingw64\\bin\\git.exe`, `${git}\\usr\\bin\\sh.exe`) };
    expect(windowsShell('sh', mingw)).toBe(`${git}\\usr\\bin\\sh.exe`);
    // bash asked for and only sh found: sh.
    expect(shellArgv('x', { ...mingw, bash: true }).file).toBe(`${git}\\usr\\bin\\sh.exe`);

    const msys = { env: { PATH: 'C:\\msys64\\usr\\bin' }, platform: 'win32' as const, isProgram: winFiles('C:\\msys64\\usr\\bin\\sh.exe') };
    expect(windowsShell('sh', msys)).toBe('C:\\msys64\\usr\\bin\\sh.EXE');

    const bare = { env, platform: 'win32' as const, isProgram: winFiles() };
    expect(windowsShell('sh', bare)).toBeNull();
    expect(shellArgv('npm test && echo ok', bare)).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', '"npm test && echo ok"'], windowsVerbatimArguments: true,
    });
    expect(shellArgv('npm test', { ...bare, env: {} }).file).toBe('cmd.exe');
  });
});

describe('stopping and the pipeline command on Windows', () => {
  test('killTree runs taskkill /PID <pid> /T /F on Windows, whatever the signal; never for pid 0 or 1', () => {
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); };
    killTree(4242, 'SIGTERM', { platform: 'win32', run });
    killTree(4243, 'SIGKILL', { platform: 'win32', run });
    killTree(1, 'SIGKILL', { platform: 'win32', run });
    killTree(0, 'SIGKILL', { platform: 'win32', run });
    expect(calls).toEqual([['taskkill', '/PID', '4242', '/T', '/F'], ['taskkill', '/PID', '4243', '/T', '/F']]);
  });

  test('AI_SDLC_HELPER_PIPELINE_CMD on Windows: the command line with the arguments appended, through the Windows shell', () => {
    const argv = pipelineArgv('alpha', 'review', { AI_SDLC_HELPER_PIPELINE_CMD: 'my-pipeline --x', PATH: '' }, 'win32');
    expect(argv).toEqual(['cmd.exe', '/d', '/s', '/c', '"my-pipeline --x alpha --from review"']);
    expect(pipelineArgv('alpha', undefined, { AI_SDLC_HELPER_PIPELINE_CMD: 'p' }, 'linux')).toEqual(['sh', '-c', 'p "$@"', 'sh', 'alpha']);
  });
});
