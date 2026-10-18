import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { worktreeChanges } from '../src/changes/index.js';
import { runContext, watchFrame } from '../src/runs/index.js';
import { tmp, write } from './helpers.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// A repo whose index is stale: the tracked file's timestamp changed after it was staged, so a plain `git status`
// refreshes the index and writes it (taking index.lock), which a commit running at the same time would collide with.
function staleRepo(): { dir: string; index: string } {
  const dir = tmp('ai-sdlc-locks-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'maintenance.auto', 'false');
  git(dir, 'config', 'gc.auto', '0');
  write(dir, 'package.json', { scripts: { test: 'node --test' } });
  write(dir, 'a.js', 'module.exports = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, 'a.js'), later, later);
  return { dir, index: path.join(dir, '.git', 'index') };
}
const stamp = (f: string) => fs.statSync(f).mtimeMs;

describe('status reads during a run take no index lock', () => {
  test('a plain git status rewrites a stale index (the problem the reads must avoid)', () => {
    const { dir, index } = staleRepo();
    const before = stamp(index);
    git(dir, 'status', '--short');
    expect(stamp(index)).not.toBe(before);
  });

  test('watch and the change counts leave a stale index as it is', () => {
    const { dir, index } = staleRepo();
    const before = stamp(index);
    const frame = watchFrame(runContext(dir, { ...process.env, ...GIT_ENV }), 'demo', dir);
    expect(frame.join('\n')).not.toMatch(/fatal/);
    expect(worktreeChanges(dir, 'main')).toMatchObject({ uncommitted: 0 });
    expect(stamp(index)).toBe(before);
  });
});
