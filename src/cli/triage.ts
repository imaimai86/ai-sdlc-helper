// The triage command: a report in, backlog items (briefs and index lines) out, written by a Claude agent.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitTriage, triage, type RunClaude } from '../triage.js';
import { exists } from '../util.js';
import type { ParsedArgs } from './args.js';
import type { Io } from './main.js';

export const TRIAGE_COMMANDS = ['triage'];
export const TRIAGE_VALUED = ['--report', '--file', '--model'];
export const TRIAGE_FLAGS = ['--print', '--commit'];

export const TRIAGE_USAGE = `  triage [dir] [--report "<text>" | --file <path>] [--print] [--commit] [--model <model>]
                                   turn a report (a bug, a feature request, an error) into backlog items: a Claude agent
                                   reads the code, asks what it cannot settle, and writes <backlog>/<slug>/brief.md and
                                   the index line; then the new items are listed and, on a yes or --commit, committed on
                                   the current branch (never pushed). --print runs the agent headless (no questions:
                                   unknowns go under "Open questions"), also when there is no terminal`;

const gitRoot = (dir: string): string | null => {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const branchOf = (root: string) => spawnSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim() || 'HEAD';

/** Runs `triage`. <run> replaces the claude process (tests). Exit 0 items created, 1 none or incomplete, 2 usage. */
export async function triageCommand(a: ParsedArgs, io: Io & { runClaude?: RunClaude }): Promise<number> {
  const [, dirArg, extra] = a.positional;
  if (extra !== undefined) { io.err('ERROR: triage takes one folder; put the report in --report "<text>" or --file <path>'); return 2; }
  for (const o of TRIAGE_VALUED) if (a.value(o) === '') { io.err(`ERROR: ${o} needs a value`); return 2; }
  const env = io.env || process.env;
  const dir = path.resolve(io.cwd || process.cwd(), dirArg || '.');
  const root = exists(dir) ? gitRoot(dir) : null;
  if (!root) { io.err(`ERROR: ${dir} is not inside a git repository`); return 2; }

  let report = a.value('--report');
  const file = a.value('--file');
  if (report !== undefined && file !== undefined) { io.err('ERROR: give the report once: --report or --file'); return 2; }
  if (file !== undefined) {
    const f = path.resolve(io.cwd || process.cwd(), file);
    if (!exists(f)) { io.err(`ERROR: ${file} does not exist`); return 2; }
    report = fs.readFileSync(f, 'utf8');
  }
  if (report === undefined && io.ask) report = await io.ask('Report (the bug or feature to triage): ');
  if (!report || !report.trim()) { io.err('ERROR: no report: pass --report "<text>" or --file <path>'); return 2; }

  const headless = a.flag('--print') || !io.ask;
  if (!headless) io.out('Starting Claude with the triage prompt. Answer its questions; when it has written the items, end the session (/exit) to come back here.');
  const r = await triage({ root, report, headless, model: a.value('--model'), env, run: io.runClaude });
  if (headless && r.output.trim()) io.out(r.output.trim());
  const { added, orphans, outside } = r.result;

  if (r.code !== 0) io.err(`WARNING: claude exited ${r.code}`);
  for (const f of outside) io.err(`WARNING: ${f} changed outside ${r.backlogDir}; triage writes only backlog files. Check it before committing anything.`);
  for (const s of orphans) io.err(`WARNING: ${r.backlogDir}/${s}/brief.md has no line in ${r.backlogDir}/index.md`);
  if (!added.length) { io.err(`No backlog item was added to ${r.backlogDir}/index.md.`); return 1; }

  io.out(`\nNew backlog items in ${r.backlogDir}/index.md:`);
  for (const i of added) io.out(`  ${i.brief ? '✓' : '✗'} ${i.slug}  ${i.title}${i.brief ? '' : `  (no ${r.backlogDir}/${i.slug}/brief.md)`}`);
  const complete = added.filter(i => i.brief).map(i => i.slug);
  if (complete.length !== added.length) { io.err('Some items have no brief: fix them before committing or starting a run.'); return 1; }

  const branch = branchOf(root);
  let commit = a.flag('--commit');
  if (!commit && io.ask && !a.flag('--print')) {
    commit = /^y(es)?$/i.test(await io.ask(`\nCommit ${r.backlogDir}/index.md and the ${complete.length} new brief(s) on ${branch}? [y/N]: `));
  }
  if (commit) {
    try {
      const sha = commitTriage(root, r.backlogDir, complete);
      io.out(`Committed ${sha} on ${branch} (not pushed).`);
    } catch (e) { io.err(`ERROR: commit failed: ${(e as Error).message}`); return 1; }
  } else {
    io.out(`\nNot committed. A run starts from a committed base, so commit them first:\n  git add ${r.backlogDir}/index.md ${complete.map(s => `${r.backlogDir}/${s}/brief.md`).join(' ')} && git commit -m "docs(backlog): triage ${complete.join(', ')}"`);
  }
  io.out(`\nStart a run with: ai-sdlc-helper start ${complete[0]}`);
  return 0;
}
