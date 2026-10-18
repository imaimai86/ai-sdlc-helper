// Command lines and program lookups that work without `sh`. On macOS and Linux a command line runs with `sh -c` (or
// `bash -c`) exactly as before. On Windows it runs with a POSIX shell when one is found (Git for Windows ships sh.exe and
// bash.exe), else with cmd.exe; programs are looked up in PATH with PATHEXT instead of `command -v`.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';

/** Where a lookup or a shell runs: the platform, the environment and a file check, all injectable for tests. */
export interface Host {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Whether <file> is a program that can be started (POSIX: an executable file; Windows: a file). */
  isProgram?: (file: string, platform: NodeJS.Platform) => boolean;
}

const defaultIsProgram = (file: string, platform: NodeJS.Platform): boolean => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
};

/** The value of an environment variable; Windows names (Path, PathExt) are case-insensitive. */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find(k => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The full path of program <name> as the shell would start it, or null: each PATH folder in turn, on Windows with each
 * PATHEXT extension (.COM;.EXE;.BAT;.CMD when unset) and the name as given. A name with a folder in it is checked as is.
 */
export function which(name: string, host: Host = {}): string | null {
  const platform = host.platform || process.platform;
  const env = host.env || process.env;
  const isProgram = host.isProgram || defaultIsProgram;
  if (!name) return null;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exts = win ? ['', ...(envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const tryAll = (base: string) => {
    for (const ext of exts) { const f = base + ext; if (isProgram(f, platform)) return f; }
    return null;
  };
  if (name.includes('/') || (win && name.includes('\\'))) return tryAll(name);
  for (const dir of (envValue(env, 'PATH', platform) || '').split(win ? ';' : ':')) {
    if (!dir) continue;
    const found = tryAll(p.join(dir.replace(/^"(.*)"$/, '$1'), name));
    if (found) return found;
  }
  return null;
}

/** Whether program <name> is on PATH (what `command -v <name>` answered before). */
export const onPath = (name: string, host: Host = {}): boolean => which(name, host) !== null;

/**
 * A POSIX shell on Windows: <kind>.exe of the Git for Windows that holds git (its bin/ or usr/bin/ folder), else
 * <kind> on PATH; null when there is none. Git's own shell comes first because PATH may hold WSL's bash.exe, which runs
 * in another file system.
 */
export function windowsShell(kind: 'sh' | 'bash', host: Host = {}): string | null {
  const h = { ...host, platform: 'win32' as const };
  const isProgram = host.isProgram || defaultIsProgram;
  const git = which('git', h);
  if (git) {
    let dir = path.win32.dirname(git);
    for (let up = 0; up < 3; up++, dir = path.win32.dirname(dir)) {
      for (const sub of ['bin', 'usr\\bin']) {
        const f = path.win32.join(dir, sub, `${kind}.exe`);
        if (isProgram(f, 'win32')) return f;
      }
    }
  }
  return which(kind, h);
}

/** How to start a command line: the program, its arguments, and whether Node must pass them verbatim (cmd.exe). */
export interface ShellArgv {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * The program and arguments that run command line <cmd>: `sh -c <cmd>` (or bash) on macOS and Linux; on Windows the
 * same with the shell windowsShell finds, else cmd.exe the way Node's `shell: true` starts it.
 */
export function shellArgv(cmd: string, { bash = false, ...host }: Host & { bash?: boolean } = {}): ShellArgv {
  const kind = bash ? 'bash' : 'sh';
  const platform = host.platform || process.platform;
  if (platform !== 'win32') return { file: kind, args: ['-c', cmd] };
  const posix = windowsShell(kind, host) || (bash ? windowsShell('sh', host) : null);
  if (posix) return { file: posix, args: ['-c', cmd] };
  const env = host.env || process.env;
  return { file: envValue(env, 'COMSPEC', platform) || 'cmd.exe', args: ['/d', '/s', '/c', `"${cmd}"`], windowsVerbatimArguments: true };
}

type ShellOpts = { bash?: boolean; platform?: NodeJS.Platform };

/** Runs command line <cmd> and waits for it (spawnSync with the shell of shellArgv); utf8 output unless set. */
export function runShell(cmd: string, opts: SpawnSyncOptions & ShellOpts = {}): SpawnSyncReturns<string> {
  const { bash, platform, ...rest } = opts;
  const a = shellArgv(cmd, { bash, platform, env: rest.env });
  return spawnSync(a.file, a.args, { encoding: 'utf8', ...rest, windowsVerbatimArguments: a.windowsVerbatimArguments }) as SpawnSyncReturns<string>;
}

/** Starts command line <cmd> (spawn with the shell of shellArgv). */
export function spawnShell(cmd: string, opts: SpawnOptions & ShellOpts = {}): ChildProcess {
  const { bash, platform, ...rest } = opts;
  const a = shellArgv(cmd, { bash, platform, env: rest.env });
  return spawn(a.file, a.args, { ...rest, windowsVerbatimArguments: a.windowsVerbatimArguments });
}
