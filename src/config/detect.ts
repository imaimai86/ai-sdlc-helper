import fs from 'node:fs';
import path from 'node:path';
import { exists, has, readJson, rel, type Json } from '../util.js';

export const RUNNERS = ['jest', 'vitest', 'mocha', 'node-test', 'generic-junit'] as const;
export type Runner = typeof RUNNERS[number];
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type Language = 'javascript' | 'typescript';

export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'target', 'out', 'tmp', 'graft', 'graphify-out']);
export const SCAN_DEPTH = 2;

/** What detection found in one folder with a package.json. */
export interface Detection {
  dir: string;
  name: string;
  runner: Runner | null;
  candidates: string[];
  evidence: string[];
  /** A test script whose runner is not recognised. */
  unknown?: boolean;
  language?: Language;
  packageManager?: PackageManager;
  testCmd?: string;
  testGlobs?: string[];
  /** The runner config runs other packages too (jest projects, a vitest workspace). */
  aggregates?: boolean;
  /** The folders whose suites this one runs. */
  covers?: string[];
}

// Evidence weights: a runner's own config file beats the test script naming it, which beats a dependency entry.
const WEIGHT = { config: 3, script: 2, dependency: 1 } as const;
type EvidenceKind = keyof typeof WEIGHT;

export const CONFIG_FILES: Record<'jest' | 'vitest' | 'mocha', RegExp> = {
  jest: /^jest\.config\.(js|cjs|mjs|ts|cts|mts|json)$/,
  vitest: /^vitest\.(config|workspace)\.(js|cjs|mjs|ts|cts|mts)$/,
  mocha: /^\.mocharc\.(js|cjs|json|jsonc|yml|yaml)$/,
};
// A runner named as a command or by path (node_modules/mocha/bin/_mocha, node_modules/.bin/jest).
const SCRIPT_PATTERNS: Record<string, RegExp> = {
  jest: /(^|[\s/;&|(=])jest([\s/;&|)]|$)|(^|[\s;&|(])(react-scripts|craco)\s+test\b/,
  vitest: /(^|[\s/;&|(=])vitest([\s/;&|)]|$)/,
  mocha: /(^|[\s/;&|(=])_?mocha([\s/;&|)]|$)/,
  'node-test': /(^|[\s;&|(])(node|tsx|ts-node)\s[^;&|]*--test(\s|$|=)/,
};
export const PLACEHOLDER_TEST = /no test specified/;
// A test script that runs other packages' tests (found there on their own): --prefix, cd, workspaces, lerna, nx, turbo.
const DELEGATES = /--prefix\b|--dir\b|--cwd\b|(^|[\s;&|(])cd\s|--workspaces?\b|(^|\s)-w\s|(^|\s)(lerna|nx|turbo)\s/;
// Other package scripts a script runs: npm run x, npm test, pnpm x, yarn x, bun run x.
const SCRIPT_REF = /(?:^|[\s;&|(])(?:npm|pnpm|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)|(?:^|[\s;&|(])yarn\s+(?:run\s+)?([\w:.-]+)/g;
const DEPENDENCIES: Record<string, string[]> = { jest: ['jest', 'ts-jest', '@jest/core'], vitest: ['vitest'], mocha: ['mocha'] };
export const DEFAULT_GLOBS: Record<Runner, string[]> = {
  jest: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
  vitest: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  mocha: ['test/**/*.{js,cjs,mjs,ts}'],
  'node-test': ['**/*.test.?(c|m)[jt]s', '**/*-test.?(c|m)[jt]s', '**/*_test.?(c|m)[jt]s', '**/test/**/*.?(c|m)[jt]s'],
  'generic-junit': [],
};
const JEST_MATCH = ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'];

/** The package manager that owns <dir>: its packageManager field or lock file, looked for from <dir> up to <root>. */
export function packageManager(dir: string, root: string): PackageManager {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      const field = readJson(path.join(d, 'package.json')).packageManager;
      if (typeof field === 'string' && /^(npm|pnpm|yarn|bun)@/.test(field)) return field.split('@')[0] as PackageManager;
    } catch { /* no package.json here */ }
    if (exists(path.join(d, 'pnpm-lock.yaml')) || exists(path.join(d, 'pnpm-workspace.yaml'))) return 'pnpm';
    if (exists(path.join(d, 'yarn.lock'))) return 'yarn';
    if (exists(path.join(d, 'bun.lockb')) || exists(path.join(d, 'bun.lock'))) return 'bun';
    if (exists(path.join(d, 'package-lock.json'))) return 'npm';
    if (d === root || path.dirname(d) === d) return 'npm';
  }
}

/** The package's own test script, run from the project root. */
export function scriptCommand(pm: PackageManager, dir: string): string {
  if (dir === '.') return pm === 'bun' ? 'bun run test' : `${pm} test`;
  return { npm: `npm --prefix ${dir} test`, pnpm: `pnpm --dir ${dir} test`, yarn: `yarn --cwd ${dir} test`, bun: `bun run --cwd ${dir} test` }[pm];
}

/** The runner itself, run from the project root, when the package has no test script for it. */
export function runnerCommand(runner: Runner, pm: PackageManager, dir: string): string {
  const exec = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[pm];
  const cd = dir === '.' ? '' : `cd ${dir} && `;
  const cmd: Record<string, string> = { jest: `${exec} jest`, vitest: `${exec} vitest run`, mocha: `${exec} mocha`, 'node-test': 'node --test' };
  return cd + (cmd[runner] ?? '');
}

/** <name> and every package script it runs, at most four levels deep. */
function expandScript(scripts: Json, name: string, depth = 0, seen = new Set<string>()): string[] {
  if (seen.has(name) || typeof scripts[name] !== 'string' || depth > 3) return [];
  seen.add(name);
  const names = [name];
  for (const m of (scripts[name] as string).matchAll(SCRIPT_REF)) names.push(...expandScript(scripts, m[1] || m[2], depth + 1, seen));
  return names;
}

/** Why the package counts as TypeScript: its nearest tsconfig.json and a typescript dependency; empty for JavaScript. */
export function typeScriptEvidence(dir: string, root: string, deps: Json): string[] {
  const found: string[] = [];
  for (let d = dir; ; d = path.dirname(d)) {
    if (exists(path.join(d, 'tsconfig.json'))) { found.push(rel(root, path.join(d, 'tsconfig.json'))); break; }
    if (d === root || path.dirname(d) === d) break;
  }
  if (has(deps, 'typescript')) found.push('dependency typescript');
  return found;
}
export const isTypeScript = (dir: string, root: string, deps: Json): boolean => typeScriptEvidence(dir, root, deps).length > 0;

/**
 * The strings of `key: [ ... ]` in <text> when the list holds only string literals, else null (a spread or a variable
 * cannot be known without running the config).
 */
export function literalList(text: string | null, key: string): string[] | null {
  if (!text) return null;
  const m = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(text);
  if (!m) return null;
  const items: string[] = [];
  let other = '';
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === ']') return other.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/[\s,]/g, '') === '' && items.length ? items : null;
    if (c === "'" || c === '"' || c === '`') {
      let v = '';
      for (i++; i < text.length && text[i] !== c; i++) v += text[i] === '\\' ? text[++i] : text[i];
      items.push(v);
    } else other += c;
  }
  return null;
}

/** The text of the first file in <dir> whose name matches <re>. */
function configText(dir: string, re: RegExp): string | null {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => re.test(f)).sort(); } catch { return null; }
  for (const f of files) { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { /* next */ } }
  return null;
}

/**
 * Test file patterns the package states itself, else null: jest testMatch or roots (package.json or jest.config.*),
 * vitest include (in the test block of vitest.config.* or vite.config.*), mocha spec. Only literal lists are read.
 */
export function packageGlobs(runner: Runner, pkg: Json, dir: string): string[] | null {
  const strip = (g: string) => g.replace(/^<rootDir>\/?/, '').replace(/^\.\//, '');
  if (runner === 'jest') {
    const conf = configText(dir, CONFIG_FILES.jest);
    const own = pkg.jest && typeof pkg.jest === 'object' ? pkg.jest : {};
    const match = (Array.isArray(own.testMatch) && own.testMatch) || literalList(conf, 'testMatch');
    if (match) return match.map(strip);
    const roots: string[] | null = (Array.isArray(own.roots) && own.roots) || literalList(conf, 'roots');
    if (roots) return roots.map(strip).flatMap(r => JEST_MATCH.map(g => (r ? `${r.replace(/\/+$/, '')}/${g}` : g)));
    return null;
  }
  if (runner === 'vitest') {
    const conf = configText(dir, CONFIG_FILES.vitest) || configText(dir, /^vite\.config\.(js|cjs|mjs|ts|cts|mts)$/);
    const block = conf ? /\btest\s*:\s*\{/.exec(conf) : null;
    const include = conf && block ? literalList(conf.slice(block.index), 'include') : null;
    return include ? include.map(strip) : null;
  }
  if (runner === 'mocha') {
    let spec = pkg.mocha ? pkg.mocha.spec : undefined;
    if (spec === undefined) {
      try { spec = readJson(path.join(dir, '.mocharc.json')).spec; } catch { /* none */ }
    }
    if (spec !== undefined) return (Array.isArray(spec) ? spec : [spec]).map(String).map(strip);
  }
  return null;
}

/** Does this package's runner config run other packages too (jest "projects", a vitest workspace)? */
function aggregates(runner: Runner, pkg: Json, dir: string, files: string[]): boolean {
  const text = (re: RegExp) => files.filter(f => re.test(f)).some(f => {
    try { return /\bprojects\s*:|\bworkspace\s*:/.test(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return false; }
  });
  if (runner === 'jest') return Boolean(pkg.jest && pkg.jest.projects) || text(CONFIG_FILES.jest);
  if (runner === 'vitest') return files.some(f => /^vitest\.workspace\./.test(f)) || text(CONFIG_FILES.vitest);
  return false;
}

/** What one folder with a package.json says about its tests, or null when it says nothing. */
export function detectPackage(dir: string, root: string): Detection | null {
  let pkg: Json;
  try { pkg = readJson(path.join(dir, 'package.json')); } catch { return null; }
  const evidence: { runner: string; kind: EvidenceKind; weight: number; reason: string }[] = [];
  const add = (runner: string, kind: EvidenceKind, reason: string) => evidence.push({ runner, kind, weight: WEIGHT[kind], reason });
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { /* unreadable */ }
  for (const [runner, re] of Object.entries(CONFIG_FILES)) {
    for (const f of files) if (re.test(f)) add(runner, 'config', `config file ${f}`);
  }
  if (pkg.jest && typeof pkg.jest === 'object') add('jest', 'config', 'package.json "jest" key');
  if (pkg.mocha && typeof pkg.mocha === 'object') add('mocha', 'config', 'package.json "mocha" key');
  const scripts: Json = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const hasTestScript = typeof scripts.test === 'string' && scripts.test.trim() !== '' && !PLACEHOLDER_TEST.test(scripts.test);
  const testScripts = hasTestScript ? expandScript(scripts, 'test') : [];
  for (const [runner, re] of Object.entries(SCRIPT_PATTERNS)) {
    const via = testScripts.find(n => re.test(scripts[n]));
    if (via) add(runner, 'script', `scripts.${via} runs ${runner === 'node-test' ? 'node --test' : runner}`);
  }
  const deps: Json = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [runner, names] of Object.entries(DEPENDENCIES)) {
    const hit = names.find(n => has(deps, n));
    if (hit) add(runner, 'dependency', `dependency ${hit}`);
  }
  const dirRel = rel(root, dir);
  // A test script whose runner is not recognised: reported, so the user can set the runner.
  if (!evidence.length) {
    return hasTestScript && !testScripts.some(n => DELEGATES.test(scripts[n]))
      ? { dir: dirRel, name: dirRel, runner: null, candidates: [], unknown: true, evidence: [`scripts.test: ${scripts.test}`] }
      : null;
  }
  // A dependency alone, with no test script, is a tool installed for others (a monorepo root), not a suite.
  if (!hasTestScript && evidence.every(e => e.kind === 'dependency')) return null;

  const scores: Record<string, number> = {};
  for (const e of evidence) scores[e.runner] = (scores[e.runner] || 0) + e.weight;
  // A runner is a candidate only with more than a bare dependency (a dependency alone can belong to a tool).
  const strong = Object.keys(scores).filter(r => evidence.some(e => e.runner === r && e.kind !== 'dependency'));
  const ranked = (strong.length ? strong : Object.keys(scores)).sort((a, b) => scores[b] - scores[a]);
  const top = ranked.filter(r => scores[r] === scores[ranked[0]]);
  const pm = packageManager(dir, root);
  const result: Detection = {
    dir: dirRel, name: dirRel === '.' ? (pkg.name || path.basename(root)) : dirRel,
    runner: top.length === 1 ? (top[0] as Runner) : null, candidates: ranked,
    language: isTypeScript(dir, root, deps) ? 'typescript' : 'javascript', packageManager: pm,
    evidence: evidence.map(e => `${e.runner}: ${e.reason}`),
  };
  if (result.runner) {
    result.aggregates = aggregates(result.runner, pkg, dir, files);
    result.testCmd = hasTestScript ? scriptCommand(pm, dirRel) : runnerCommand(result.runner, pm, dirRel);
    result.testGlobs = packageGlobs(result.runner, pkg, dir) || DEFAULT_GLOBS[result.runner];
  }
  return result;
}

/** The sub-folders of <dir> worth scanning (no dot folders, node_modules, build output or indexes). */
export function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)).map(e => path.join(dir, e.name));
  } catch { return []; }
}

/** The folders the root's workspaces name (package.json "workspaces", pnpm-workspace.yaml), at any depth. */
export function workspaceDirs(root: string): string[] {
  let patterns: unknown[] = [];
  try {
    const ws = readJson(path.join(root, 'package.json')).workspaces;
    patterns = Array.isArray(ws) ? ws : (ws && Array.isArray(ws.packages) ? ws.packages : []);
  } catch { /* none */ }
  try {
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    for (const m of yaml.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)) patterns.push(m[1]);
  } catch { /* none */ }
  const out = new Set<string>();
  const expand = (dir: string, parts: string[], depth: number): void => {
    if (!parts.length) { out.add(dir); return; }
    const [p, ...rest] = parts;
    if (p === '**') {
      expand(dir, rest, depth);
      if (depth < 6) for (const d of subdirs(dir)) expand(d, parts, depth + 1);
    } else if (/[*?]/.test(p)) {
      const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      for (const d of subdirs(dir)) if (re.test(path.basename(d))) expand(d, rest, depth + 1);
    } else if (exists(path.join(dir, p))) expand(path.join(dir, p), rest, depth + 1);
  };
  for (const p of patterns) {
    if (typeof p === 'string' && !p.startsWith('!')) expand(root, p.replace(/^\.\//, '').split('/').filter(Boolean), 0);
  }
  return [...out];
}

/** Every folder whose package.json shows its tests: the root, up to SCAN_DEPTH levels down, and every workspace. */
export function detect(root: string): Detection[] {
  root = path.resolve(root);
  const dirs = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    dirs.add(dir);
    if (depth < SCAN_DEPTH) for (const d of subdirs(dir)) walk(d, depth + 1);
  };
  walk(root, 0);
  for (const d of workspaceDirs(root)) dirs.add(d);
  const found = [...dirs].map(d => detectPackage(d, root)).filter((d): d is Detection => d !== null)
    .sort((a, b) => (a.dir === '.' ? -1 : b.dir === '.' ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  // A suite whose runner config runs its sub-packages (jest projects, vitest workspace) covers their suites of that runner.
  const inside = (outer: string, inner: string) => outer === '.' || inner.startsWith(`${outer}/`);
  for (const a of found.filter(f => f.aggregates)) {
    a.covers = found.filter(b => b !== a && b.runner === a.runner && inside(a.dir, b.dir)).map(b => b.dir);
  }
  const covered = new Set(found.flatMap(f => f.covers || []));
  return found.filter(f => !covered.has(f.dir));
}
