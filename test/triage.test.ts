import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { main } from '../src/cli/main.js';
import { indexItems, type RunClaude } from '../src/triage.js';
import { tmp, write } from './helpers.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).stdout.trim();

// A project with a test suite and a backlog with one item.
function project(): string {
  const dir = tmp('ai-sdlc-triage-');
  write(dir, 'package.json', { scripts: { test: 'node --test' } });
  write(dir, 'src/app.js', 'module.exports = {};\n');
  write(dir, 'Docs/backlog/index.md', '# Backlog\n\n- [x] `old-item` - Feature: done before\n');
  write(dir, 'Docs/backlog/old-item/brief.md', '# old-item\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'maintenance.auto', 'false');
  // its own identity: the tool's commits must work on a machine with no global git identity (CI)
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// A stand-in claude that records its arguments and writes what a triage agent would.
function agent(dir: string, { slug = 'add-health-check', brief = true, line = true, extra = '' } = {}) {
  const calls: { args: string[]; interactive: boolean }[] = [];
  const run: RunClaude = async (args, opts) => {
    calls.push({ args, interactive: opts.interactive });
    if (brief) write(dir, `Docs/backlog/${slug}/brief.md`, `# ${slug}\n\nType: feature\n`);
    if (line) fs.appendFileSync(path.join(dir, 'Docs/backlog/index.md'), `- [ ] \`${slug}\` - Feature: GET /health\n`);
    if (extra) write(dir, extra, 'x\n');
    return { code: 0, stdout: '| slug | type |\n' };
  };
  return { run, calls };
}

async function triage(dir: string, args: string[], run: RunClaude, answers?: string[]) {
  let stdout = '';
  let stderr = '';
  const queue = [...(answers || [])];
  const io = {
    out: (t: string) => { stdout += `${t}\n`; }, err: (t: string) => { stderr += `${t}\n`; }, cwd: dir, runClaude: run,
    ask: answers ? async () => queue.shift() ?? '' : undefined,
  };
  const status = await main(['triage', ...args], io);
  return { status, stdout, stderr };
}

describe('triage', () => {
  test('headless: the agent gets the rendered triage prompt and the report; the new item is listed, not committed', async () => {
    const dir = project();
    const a = agent(dir);
    const r = await triage(dir, ['--report', 'Add GET /health that checks the database'], a.run);
    expect(r.status).toBe(0);
    const [call] = a.calls;
    expect(call.interactive).toBe(false);
    expect(call.args[0]).toBe('-p');
    const prompt = call.args[1];
    expect(prompt).toContain('Turn this report into backlog items');
    expect(prompt).toContain('`Docs/backlog/index.md`');
    expect(prompt).toContain('## The report\nAdd GET /health that checks the database');
    expect(prompt).toContain('This run is headless');
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}|scripts\/sdlc|Engineering\/bugs\.md/);
    const tools = call.args.slice(call.args.indexOf('--allowedTools') + 1);
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(cat:*)']));
    expect(call.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(r.stdout).toContain('  ✓ add-health-check  Feature: GET /health');
    expect(r.stdout).toContain('Not committed.');
    expect(r.stdout).toContain('Start a run with: ai-sdlc-helper start add-health-check');
    expect(git(dir, 'log', '--oneline').split('\n')).toHaveLength(1);
  });

  test('--commit commits exactly the index and the new brief on the current branch, leaving other changes alone', async () => {
    const dir = project();
    write(dir, 'src/app.js', 'module.exports = { mine: 1 };\n');
    const r = await triage(dir, ['--report', 'health check', '--commit'], agent(dir).run);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Committed [0-9a-f]+ on main \(not pushed\)\./);
    expect(git(dir, 'show', '--name-only', '--format=%s', 'HEAD').split('\n').filter(Boolean))
      .toEqual(['docs(backlog): triage add-health-check', 'Docs/backlog/add-health-check/brief.md', 'Docs/backlog/index.md']);
    expect(git(dir, 'status', '--porcelain')).toBe('M src/app.js');
  });

  test('interactive: claude gets the terminal and the prompt as its first message; a yes commits', async () => {
    const dir = project();
    const a = agent(dir);
    const r = await triage(dir, ['--report', 'health check'], a.run, ['y']);
    expect(r.status).toBe(0);
    expect(a.calls[0].interactive).toBe(true);
    expect(a.calls[0].args).not.toContain('-p');
    expect(a.calls[0].args.at(-1)).toContain('## The report\nhealth check');
    expect(a.calls[0].args.at(-1)).not.toContain('This run is headless');
    expect(r.stdout).toContain('Committed');
  });

  test('asks for the report at a terminal; reads it from --file', async () => {
    const dir = project();
    let a = agent(dir);
    expect((await triage(dir, [], a.run, ['typed report', 'n'])).status).toBe(0);
    expect(a.calls[0].args.at(-1)).toContain('## The report\ntyped report');
    const d2 = project();
    write(d2, 'report.txt', 'from a file\n');
    a = agent(d2);
    expect((await triage(d2, ['--file', 'report.txt', '--print'], a.run)).status).toBe(0);
    expect(a.calls[0].args[1]).toContain('## The report\nfrom a file');
  });

  test('nothing added, a missing brief or files outside the backlog are reported', async () => {
    let dir = project();
    let r = await triage(dir, ['--report', 'x'], agent(dir, { brief: false, line: false }).run);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No backlog item was added to Docs/backlog/index.md.');

    dir = project();
    r = await triage(dir, ['--report', 'x', '--commit'], agent(dir, { brief: false }).run);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('  ✗ add-health-check  Feature: GET /health  (no Docs/backlog/add-health-check/brief.md)');
    expect(git(dir, 'log', '--oneline').split('\n')).toHaveLength(1);

    dir = project();
    r = await triage(dir, ['--report', 'x'], agent(dir, { extra: 'src/app.js' }).run);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARNING: src/app.js changed outside Docs/backlog');

    dir = project();
    r = await triage(dir, ['--report', 'x'], agent(dir, { line: false }).run);
    expect(r.stderr).toContain('WARNING: Docs/backlog/add-health-check/brief.md has no line in Docs/backlog/index.md');
  });

  test('usage errors: no report without a terminal, two report sources, not a git repository', async () => {
    const dir = project();
    const a = agent(dir);
    expect(await triage(dir, [], a.run)).toMatchObject({ status: 2, stderr: 'ERROR: no report: pass --report "<text>" or --file <path>\n' });
    expect((await triage(dir, ['--report', 'a', '--file', 'b'], a.run)).status).toBe(2);
    expect((await triage(tmp('ai-sdlc-nogit-'), ['--report', 'a'], a.run)).stderr).toContain('is not inside a git repository');
    expect(a.calls).toEqual([]);
  });

  test('index lines are read with their marker, slug and title', () => {
    expect(indexItems('# Backlog\n- [ ] `a-b` - Bug: x\n- [x] `c`\n  - [~] `d` - parked\nnot a line\n')).toEqual([
      { marker: ' ', slug: 'a-b', title: 'Bug: x' }, { marker: 'x', slug: 'c', title: '' }, { marker: '~', slug: 'd', title: 'parked' },
    ]);
  });
});
