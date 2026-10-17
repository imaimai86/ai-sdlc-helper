import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli/main.js';

export const tmp = (prefix = 'ai-sdlc-'): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const write = (dir: string, rel: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof value === 'string' ? value : JSON.stringify(value));
};

/** A throwaway project: { 'path/file': text or object (written as JSON) }. */
export const project = (files: Record<string, unknown>): string => {
  const dir = tmp();
  for (const [f, v] of Object.entries(files)) write(dir, f, v);
  return dir;
};

/** A PATH holding stand-ins for the given programs only. */
export const pathWith = (...programs: string[]): NodeJS.ProcessEnv => {
  const bin = tmp('ai-sdlc-bin-');
  for (const p of programs) fs.writeFileSync(path.join(bin, p), '#!/bin/sh\n', { mode: 0o755 });
  return { PATH: `${bin}:/usr/bin:/bin` };
};

export interface CliResult { status: number; stdout: string; stderr: string }

/** Runs the command line in-process, without a terminal to ask at (from <cwd> when given). */
export async function run(args: string[], env?: NodeJS.ProcessEnv, cwd?: string): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const status = await main(args, { out: t => { stdout += `${t}\n`; }, err: t => { stderr += `${t}\n`; }, env, cwd });
  return { status, stdout, stderr };
}
