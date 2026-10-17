// Lists the items in <backlogDir>/index.md with a derived status. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSettings } from '../util.js';

export const BACKLOG_USAGE = 'Usage: ai-sdlc-helper backlog [status[,status...]] [--status <list>] [--json]';
export const STATUSES = ['pending', 'in-progress', 'blocked', 'parked', 'completed'] as const;
export type Status = typeof STATUSES[number];
const ALIASES: Record<string, Status> = { open: 'pending', done: 'completed' };

export interface IndexEntry { marker: string; slug: string; rest: string }
export interface BacklogItem {
  status: Status;
  slug: string;
  type: string | null;
  priority: string | null;
  title: string;
  note: string;
  hasBrief: boolean;
}
/** Where the backlog lives: the project root, the backlog folder in it, and the branch prefix of pipeline runs. */
export interface BacklogPlace { root: string; backlogDir: string; branchPrefix: string }

class UsageError extends Error { code = 2; }

/** The backlog folder and branch prefix from the project's settings (`backlogDir`, `git.branchPrefix`). */
export function backlogPlace(root: string): BacklogPlace {
  const s = readSettings(root);
  return {
    root,
    backlogDir: String(s.backlogDir || 'Docs/backlog').replace(/\/+$/, ''),
    branchPrefix: (s.git && typeof s.git.branchPrefix === 'string' && s.git.branchPrefix) || 'sdlc/',
  };
}

export function parseIndex(text: string): IndexEntry[] {
  const items: IndexEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^- \[( |x|X|!|~)\] `([^`]+)`(?: - (.*))?$/);
    if (m) items.push({ marker: m[1], slug: m[2], rest: m[3] || '' });
  }
  return items;
}

export function parseTitle(rest: string): { type: string | null; title: string; blockedReason: string; parkedReason: string } {
  let title = rest;
  let type: string | null = null;
  const prefix = title.match(/^(bug|feature):\s*/i);
  if (prefix) {
    type = prefix[1].toLowerCase();
    title = title.slice(prefix[0].length);
  }
  let blockedReason = '';
  let parkedReason = '';
  const note = title.match(/\s*\((blocked|parked):\s*(.*)\)\s*$/);
  if (note) {
    if (note[1] === 'blocked') blockedReason = note[2].trim();
    else parkedReason = note[2].trim();
    title = title.slice(0, note.index);
  }
  return { type, title: title.trim(), blockedReason, parkedReason };
}

// A slug is used as a folder name and in a git ref pattern: reject separators, "..", and glob characters.
const safeSlug = (slug: string): boolean => !/[\\/*?[\]]/.test(slug) && slug !== '..' && slug !== '.';

export function parseBrief(place: Pick<BacklogPlace, 'root' | 'backlogDir'>, slug: string): { hasBrief: boolean; type: string | null; priority: string | null } {
  if (!safeSlug(slug)) return { hasBrief: false, type: null, priority: null };
  const file = path.join(place.root, place.backlogDir, slug, 'brief.md');
  if (!fs.existsSync(file)) return { hasBrief: false, type: null, priority: null };
  const text = fs.readFileSync(file, 'utf8');
  const typeLine = text.match(/^\s*Type:[ \t]*(\S+)/im);
  const priLine = text.match(/^\s*Priority:[ \t]*(.*)$/im);
  const pri = priLine && priLine[1].match(/\bP[0-3]\b/);
  return { hasBrief: true, type: typeLine ? typeLine[1].toLowerCase() : null, priority: pri ? pri[0] : null };
}

/** Whether a local or origin branch <branchPrefix><slug> exists. <refs> holds the repository's refs, read once on first use. */
function branchExists(place: BacklogPlace, slug: string, refs: { names?: Set<string> }): boolean {
  if (!safeSlug(slug)) return false;
  if (!refs.names) {
    try {
      const out = execFileSync('git', ['-C', place.root, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      refs.names = new Set(out.split('\n').filter(Boolean));
    } catch {
      refs.names = new Set();
    }
  }
  const branch = `${place.branchPrefix}${slug}`;
  return refs.names.has(`refs/heads/${branch}`) || refs.names.has(`refs/remotes/origin/${branch}`);
}

function deriveItem(entry: IndexEntry, place: BacklogPlace, refs: { names?: Set<string> }): BacklogItem {
  const { type, title, blockedReason, parkedReason } = parseTitle(entry.rest);
  const brief = parseBrief(place, entry.slug);
  let status: Status;
  if (entry.marker === 'x' || entry.marker === 'X') status = 'completed';
  else if (entry.marker === '!') status = 'blocked';
  else if (entry.marker === '~') status = 'parked';
  else status = branchExists(place, entry.slug, refs) ? 'in-progress' : 'pending';
  return {
    status,
    slug: entry.slug,
    type: type || brief.type,
    priority: brief.priority,
    title,
    note: [blockedReason || parkedReason, brief.hasBrief ? null : 'no brief'].filter(Boolean).join('; '),
    hasBrief: brief.hasBrief,
  };
}

function notInIndex(place: BacklogPlace, entries: IndexEntry[]): string[] {
  const indexed = new Set(entries.map(e => e.slug));
  const dir = path.join(place.root, place.backlogDir);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !indexed.has(d.name) && fs.existsSync(path.join(dir, d.name, 'brief.md')))
    .map(d => d.name)
    .sort();
}

/** The statuses a filter such as "pending,in-progress", "open" or "all" selects (any case). */
export function normalizeStatuses(raw: string): Set<Status> {
  const out = new Set<Status>();
  for (const part of raw.split(',')) {
    const v = part.toLowerCase();
    if (v === 'all') STATUSES.forEach(s => out.add(s));
    else if ((STATUSES as readonly string[]).includes(v)) out.add(v as Status);
    else if (ALIASES[v]) out.add(ALIASES[v]);
    else throw new UsageError(`Unknown status "${part}". Valid: ${STATUSES.join(', ')}, all`);
  }
  return out;
}

export function parseArgs(argv: string[]): { statuses: Set<Status>; raw: string | null; json: boolean } {
  let positional: string | null = null;
  let status: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--status') {
      const v = argv[i + 1];
      if (status !== null || v === undefined || v.startsWith('-')) throw new UsageError(BACKLOG_USAGE);
      status = v;
      i++;
    } else if (a.startsWith('-')) throw new UsageError(BACKLOG_USAGE);
    else if (positional !== null) throw new UsageError(BACKLOG_USAGE);
    else positional = a;
  }
  if (positional !== null && status !== null) throw new UsageError(BACKLOG_USAGE);
  const raw = positional !== null ? positional : status;
  return { statuses: normalizeStatuses(raw === null ? 'all' : raw), raw, json };
}

export function formatTable(items: BacklogItem[], all: BacklogItem[], extras: string[], rawFilter: string): string {
  const count = (s: Status) => all.filter(i => i.status === s).length;
  const footer = `pending ${count('pending')} · in-progress ${count('in-progress')} · blocked ${count('blocked')} · parked ${count('parked')} · completed ${count('completed')} · total ${all.length}`;
  const lines: string[] = [];
  if (!items.length) {
    lines.push(`No items with status: ${rawFilter}`);
  } else {
    const rows = [['STATUS', 'SLUG', 'TYPE', 'PRI', 'TITLE', 'NOTE']].concat(
      items.map(i => [i.status, i.slug, i.type || '-', i.priority || '-', i.title, i.note]),
    );
    const widths = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)));
    for (const r of rows) lines.push(r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd());
  }
  lines.push('', footer);
  if (extras.length) lines.push(`Not in index: ${extras.join(', ')}`);
  return lines.join('\n') + '\n';
}

export const formatJson = (items: BacklogItem[]): string => JSON.stringify(items.map(i => ({
  status: i.status,
  slug: i.slug,
  type: i.type || null,
  priority: i.priority || null,
  title: i.title,
  note: i.note || '',
  hasBrief: i.hasBrief,
}))) + '\n';

/** Every item of the backlog at <place>, with its derived status; null when the index is missing. */
export function backlogItems(place: BacklogPlace): { items: BacklogItem[]; entries: IndexEntry[] } | null {
  const indexFile = path.join(place.root, place.backlogDir, 'index.md');
  if (!fs.existsSync(indexFile)) return null;
  const entries = parseIndex(fs.readFileSync(indexFile, 'utf8'));
  const refs = {};
  return { items: entries.map(e => deriveItem(e, place, refs)), entries };
}

/**
 * `ai-sdlc-helper backlog [status[,status...]] [--status <list>] [--json]` for the project at <place>. <out> and <err>
 * get text with its own line ends. Returns 0 ok, 1 when the index is missing, 2 on bad arguments.
 */
export function backlogMain(argv: string[], place: BacklogPlace, io: { out(text: string): void; err(text: string): void }): number {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return (e as UsageError).code || 2;
  }
  const found = backlogItems(place);
  if (!found) {
    io.err(`${place.backlogDir}/index.md not found\n`);
    return 1;
  }
  const shown = found.items.filter(i => args.statuses.has(i.status));
  io.out(args.json ? formatJson(shown) : formatTable(shown, found.items, notInIndex(place, found.entries), args.raw === null ? 'all' : args.raw));
  return 0;
}
