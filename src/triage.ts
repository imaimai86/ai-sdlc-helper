// Triage: turns a free-text report into backlog items (a brief per item and a line in the backlog index) with a Claude
// agent following the shipped triage prompt. The agent writes the files; this module checks what it created and
// commits exactly those files when asked. It never pushes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { allowedTools, resolve } from './config/settings.js';
import { renderSkill } from './config/skills.js';
import { backlogDirOf } from './registry/doctor.js';
import { exists } from './util.js';

/** One backlog line: `- [ ] \`slug\` - title`, with its marker. */
export interface IndexItem { slug: string; marker: string; title: string }

/** The items of a backlog index, in order. */
export function indexItems(text: string): IndexItem[] {
  const out: IndexItem[] = [];
  for (const line of text.split('\n')) {
    const m = /^- \[(.)\] `([^`]+)`\s*(?:-\s*(.*))?$/.exec(line.trim());
    if (m) out.push({ marker: m[1], slug: m[2], title: (m[3] || '').trim() });
  }
  return out;
}

/** What a triage run added: new index lines, and whether each has its brief; briefs with no index line. */
export interface TriageResult {
  added: (IndexItem & { brief: boolean })[];
  /** Briefs written for a slug that has no line in the index. */
  orphans: string[];
  /** Changed or new files outside the backlog folder (triage should write none). */
  outside: string[];
}

const read = (f: string) => (exists(f) ? fs.readFileSync(f, 'utf8') : '');
const git = (root: string, args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const dirty = (root: string): string[] => git(root, ['status', '--porcelain', '--untracked-files=all']).stdout
  .split('\n').filter(Boolean).map(l => l.slice(3).replace(/^.* -> /, ''));

/** The state triage starts from, to compare with afterwards. */
export interface Before { slugs: Set<string>; briefs: Set<string>; dirty: Set<string> }

export function snapshotBacklog(root: string, backlogDir: string): Before {
  const dir = path.join(root, backlogDir);
  const briefs = exists(dir) ? fs.readdirSync(dir).filter(d => exists(path.join(dir, d, 'brief.md'))) : [];
  return { slugs: new Set(indexItems(read(path.join(dir, 'index.md'))).map(i => i.slug)), briefs: new Set(briefs), dirty: new Set(dirty(root)) };
}

export function compareBacklog(root: string, backlogDir: string, before: Before): TriageResult {
  const dir = path.join(root, backlogDir);
  const items = indexItems(read(path.join(dir, 'index.md')));
  const added = items.filter(i => !before.slugs.has(i.slug)).map(i => ({ ...i, brief: exists(path.join(dir, i.slug, 'brief.md')) }));
  const listed = new Set(items.map(i => i.slug));
  const now = snapshotBacklog(root, backlogDir);
  const orphans = [...now.briefs].filter(s => !before.briefs.has(s) && !listed.has(s)).sort();
  const prefix = `${backlogDir.replace(/\/+$/, '')}/`;
  const outside = [...now.dirty].filter(f => !before.dirty.has(f) && !f.startsWith(prefix)).sort();
  return { added, orphans, outside };
}

/** The prompt: the triage skill rendered for the project, then the report. */
export function triagePrompt(root: string, report: string, { headless = false, env = process.env } = {}): string {
  const skill = renderSkill('triage', root, { env });
  if (skill === null) throw new Error('the triage prompt is missing from this installation');
  const noQuestions = headless
    ? '\nThis run is headless: you cannot ask the person anything (no AskUserQuestion). Decide what the code and conventions settle, and put everything else under "Open questions" in the brief.\n'
    : '';
  return `${skill.trim()}\n${noQuestions}\n## The report\n${report.trim()}\n`;
}

/** The tools a headless triage agent gets: read the code, run read-only commands, write the backlog files. */
export function triageTools(root: string, env: NodeJS.ProcessEnv): string[] {
  const { config } = resolve(root, { env });
  const base = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
  return config ? allowedTools(config) : base;
}

/** Starts claude and resolves its exit code: interactive (the terminal is the agent's) or headless (`-p`, output captured). */
export type RunClaude = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; interactive: boolean }) => Promise<{ code: number; stdout: string }>;

export const runClaude: RunClaude = (args, { cwd, env, interactive }) => new Promise(resolvePromise => {
  const child = spawn('claude', args, { cwd, env, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout?.on('data', c => { stdout += c; });
  child.on('error', e => resolvePromise({ code: 127, stdout: `${e.message}\n` }));
  child.on('close', code => resolvePromise({ code: code ?? 1, stdout }));
});

export interface TriageOptions {
  root: string;
  report: string;
  headless: boolean;
  model?: string;
  env?: NodeJS.ProcessEnv;
  run?: RunClaude;
}

/** Runs the triage agent and reports what it added to the backlog. */
export async function triage(opts: TriageOptions): Promise<{ code: number; output: string; result: TriageResult; backlogDir: string }> {
  const env = opts.env || process.env;
  const { config } = resolve(opts.root, { env });
  const backlogDir = backlogDirOf(config, opts.root);
  const before = snapshotBacklog(opts.root, backlogDir);
  const prompt = triagePrompt(opts.root, opts.report, { headless: opts.headless, env });
  const model = opts.model ? ['--model', opts.model] : [];
  const args = opts.headless
    ? ['-p', prompt, ...model, '--permission-mode', 'acceptEdits', '--allowedTools', ...triageTools(opts.root, env)]
    : [...model, prompt];
  const r = await (opts.run || runClaude)(args, { cwd: opts.root, env, interactive: !opts.headless });
  return { code: r.code, output: r.stdout, result: compareBacklog(opts.root, backlogDir, before), backlogDir };
}

/** Commits exactly the new briefs and the index on the current branch. Returns the commit hash, or throws with git's error. */
export function commitTriage(root: string, backlogDir: string, slugs: string[]): string {
  const files = [`${backlogDir}/index.md`, ...slugs.map(s => `${backlogDir}/${s}/brief.md`)];
  const add = git(root, ['add', '--', ...files]);
  if (add.status !== 0) throw new Error(add.stderr.trim());
  const c = git(root, ['commit', '-q', '-m', `docs(backlog): triage ${slugs.join(', ')}`, '--', ...files]);
  if (c.status !== 0) throw new Error((c.stderr || c.stdout).trim());
  return git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
}
