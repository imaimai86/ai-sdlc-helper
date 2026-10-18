import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_FILE, exists, has, readJson, readSettings, rel, type Json } from '../util.js';
import { shellArgv } from '../shell.js';
import {
  PLACEHOLDER_TEST, RUNNERS, SCAN_DEPTH, SKIP_DIRS, detect, detectPackage, packageManager, typeScriptEvidence,
  type Language, type PackageManager,
} from './detect.js';
import { nodeRun, projectNode, wrapCommand } from './node.js';

// Files that show a project in a language not supported yet.
const OTHER_ECOSYSTEMS: [string, string][] = [
  ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['setup.py', 'Python'], ['go.mod', 'Go'],
  ['Cargo.toml', 'Rust'], ['pom.xml', 'Java'], ['build.gradle', 'Java/Kotlin'], ['build.gradle.kts', 'Kotlin'],
  ['Gemfile', 'Ruby'], ['composer.json', 'PHP'],
];
const FRONTEND = ['react', 'vue', 'svelte', '@angular/core', 'solid-js', 'preact', 'lit'];
const VITE_BASED = ['vite', '@sveltejs/kit', 'nuxt', 'astro', 'vitepress'];
const BACKEND = ['express', 'fastify', 'koa', '@hapi/hapi', 'hono'];
export const LANGUAGES: Language[] = ['javascript', 'typescript'];
const SAMPLE_NOTE = 'Example test added by ai-sdlc-helper init-tests: replace it with tests for your code.';

/** What the project is, as far as choosing a test framework goes. */
export interface Project {
  dir: string;
  language: Language;
  languageEvidence: string[];
  languageSource: 'detected' | 'confirmed';
  module: 'esm' | 'commonjs';
  packageManager: PackageManager;
  /** The lowest Node version the project allows, as "major.minor (source)". */
  node: string;
  nodeVersion: [number, number];
  vite: boolean;
  next: boolean;
  nest: boolean;
  frontend: string[];
  backend: string[];
  chai: boolean;
  srcDir: boolean;
  e2eDirs: string[];
}

/** Folders of browser end-to-end tests (Playwright, Cypress): unit test runners must leave them alone. */
function e2eDirs(dir: string, files: string[], dep: (n: string) => boolean): string[] {
  const out: string[] = [];
  const pw = files.find(f => /^playwright\.config\.[cm]?[jt]s$/.test(f));
  if (pw || dep('@playwright/test')) {
    let testDir: string | undefined;
    try { testDir = (fs.readFileSync(path.join(dir, pw || ''), 'utf8').match(/testDir\s*:\s*['"`]([^'"`]+)['"`]/) || [])[1]; } catch { /* none */ }
    out.push(testDir ? testDir.replace(/^\.\//, '').replace(/\/+$/, '') : 'e2e');
  }
  if (files.some(f => /^cypress\.config\.[cm]?[jt]s$/.test(f)) || dep('cypress')) out.push('cypress');
  return [...new Set(out)];
}

/** What the project at <dir> is, for suggestions. Its Node version is the lowest it allows, else the Node running this. */
export function describeProject(dir: string, root: string, pkg: Json): Project {
  const deps: Json = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const dep = (n: string) => has(deps, n);
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { /* unreadable */ }
  const wanted = projectNode(dir, pkg);
  const current = process.versions.node.split('.').map(Number);
  const nodeVersion: [number, number] = wanted ? wanted.lowest : [current[0], current[1]];
  const tsEvidence = typeScriptEvidence(dir, root, deps);
  return {
    dir: rel(root, dir),
    language: tsEvidence.length ? 'typescript' : 'javascript',
    languageEvidence: tsEvidence.length ? tsEvidence : ['no tsconfig.json and no typescript dependency'],
    languageSource: 'detected',
    module: pkg.type === 'module' ? 'esm' : 'commonjs',
    packageManager: packageManager(dir, root),
    node: `${nodeVersion[0]}.${nodeVersion[1]} (${wanted ? wanted.source : 'the Node running this'})`,
    nodeVersion,
    vite: VITE_BASED.some(dep) || files.some(f => /^vite\.config\./.test(f)),
    next: dep('next'),
    nest: dep('@nestjs/core'),
    frontend: FRONTEND.filter(dep),
    backend: BACKEND.filter(dep),
    chai: dep('chai') || dep('sinon'),
    srcDir: exists(path.join(dir, 'src')),
    e2eDirs: e2eDirs(dir, files, dep),
  };
}

const installCmd = (pm: PackageManager, deps: string[]): string | null => (!deps.length ? null
  : `${{ npm: 'npm install -D', pnpm: 'pnpm add -D', yarn: 'yarn add -D', bun: 'bun add -d' }[pm]} ${deps.join(' ')}`);

export type SuggestedRunner = 'vitest' | 'jest' | 'node-test' | 'mocha';

export interface Suggestion {
  runner: SuggestedRunner;
  score: number;
  why: string[];
  caveats: string[];
  devDependencies: string[];
  install: string | null;
  recommended?: boolean;
  adds?: { script: string; files: string[] };
}

export interface NotSuggested { runner: SuggestedRunner; reason: string }

/** Each runner scored for this project, and those the project's Node cannot run. */
export function rankRunners(p: Project): { ranked: Suggestion[]; notSuggested: NotSuggested[] } {
  const ts = p.language === 'typescript';
  const esm = p.module === 'esm';
  const [major, minor] = p.nodeVersion;
  const stripTypes = major > 22 || (major === 22 && minor >= 18);
  const old = major < 18; // Jest 30, Mocha 11, Vitest, tsx and a stable node:test need Node 18
  const dom = p.frontend.length > 0;
  const v = (name: string, pin: string) => (old ? `${name}@${pin}` : name);
  const r: Record<SuggestedRunner, Omit<Suggestion, 'runner' | 'install'>> = {
    vitest: { score: 3, why: [], caveats: [], devDependencies: ['vitest'] },
    jest: { score: 3, why: [], caveats: [], devDependencies: [v('jest', '29')] },
    'node-test': { score: 2, why: ['built into Node: nothing to install'], caveats: [], devDependencies: [] },
    mocha: { score: 1, why: [], caveats: [], devDependencies: [v('mocha', '10')] },
  };
  const notSuggested: NotSuggested[] = [];
  if (old) {
    const why = `the project allows Node ${major}.${minor} (${p.node.replace(/^[^(]*\(|\)$/g, '')})`;
    notSuggested.push({ runner: 'vitest', reason: `Vitest needs Node 18 or newer; ${why}` });
    notSuggested.push({ runner: 'node-test', reason: `node:test needs Node 18 or newer; ${why}` });
    r.jest.caveats.push('Jest 29, the last version for Node 16 and older');
    r.mocha.caveats.push('Mocha 10, the last version for Node 16 and older');
    if (major < 14) {
      notSuggested.push({ runner: 'jest', reason: `Jest 29 needs Node 14 or newer; ${why}` });
      notSuggested.push({ runner: 'mocha', reason: `Mocha 10 needs Node 14 or newer; ${why}` });
    }
  }
  if (p.vite) { r.vitest.score += 4; r.vitest.why.push('the project uses Vite: Vitest reuses vite.config'); }
  if (p.next) { r.jest.score += 3; r.jest.why.push('Next.js ships a Jest setup (next/jest)'); r.vitest.score += 1; r.vitest.why.push('works with Next.js through @vitejs/plugin-react'); }
  if (p.nest) { r.jest.score += 4; r.jest.why.push('NestJS projects use Jest by default'); }
  if (ts) {
    r.vitest.score += 2; r.vitest.why.push('runs TypeScript with no extra setup');
    r.jest.devDependencies.push(v('ts-jest', '29'), v('@types/jest', '29')); r.jest.caveats.push('TypeScript needs ts-jest (added) and a jest.config.js preset');
    if (old) { r.mocha.devDependencies.push('ts-node@10'); r.mocha.caveats.push('TypeScript needs ts-node (added), registered in .mocharc.json'); }
    else { r.mocha.devDependencies.push('tsx'); r.mocha.caveats.push('TypeScript needs tsx (added) loaded from .mocharc.json'); }
    if (stripTypes) { r['node-test'].score += 1; r['node-test'].why.push(`Node ${major}.${minor} runs TypeScript files directly`); }
    else { r['node-test'].score -= 1; r['node-test'].devDependencies.push('tsx'); r['node-test'].caveats.push(`Node ${major}.${minor} cannot run TypeScript directly: needs tsx (added)`); }
    if (major < 21) { r['node-test'].score -= 1; r['node-test'].caveats.push(`Node ${major} cannot find .ts test files by pattern: only test/*.test.ts runs, not sub-folders`); }
  }
  if (esm) {
    r.vitest.score += 2; r.vitest.why.push('native ES modules');
    r['node-test'].score += 1; r['node-test'].why.push('native ES modules');
    r.jest.score -= 1; r.jest.caveats.push('ES modules need NODE_OPTIONS=--experimental-vm-modules');
  }
  if (dom) {
    r['node-test'].score -= 3; r['node-test'].caveats.push(`no browser DOM for ${p.frontend.join(', ')} components`);
    r.mocha.score -= 1; r.mocha.caveats.push('a DOM needs jsdom set up by hand');
    for (const k of ['vitest', 'jest'] as const) r[k].why.push(`component tests with jsdom and Testing Library (${p.frontend.join(', ')})`);
    r.vitest.devDependencies.push('jsdom'); r.jest.devDependencies.push(v('jest-environment-jsdom', '29'));
  }
  if (p.backend.length && !dom) {
    r.jest.score += 1; r.jest.why.push(`common for ${p.backend.join(', ')} APIs, with supertest`);
    r['node-test'].score += 1; r['node-test'].why.push('enough for a server API, with no dependencies');
  }
  if (p.chai) { r.mocha.score += 2; r.mocha.why.push('the project already has chai/sinon'); }
  if (!r.mocha.why.length) r.mocha.why.push('flexible and long-established; you pick the assertion library');
  if (!r.jest.why.length) r.jest.why.push('the most widely used; mocks, snapshots and coverage built in');
  if (!r.vitest.why.length) r.vitest.why.push('fast, with the same test API as Jest');
  const excluded = new Set(notSuggested.map(n => n.runner));
  const ranked = (Object.entries(r) as [SuggestedRunner, Omit<Suggestion, 'runner' | 'install'>][])
    .filter(([runner]) => !excluded.has(runner))
    .map(([runner, s]) => ({ runner, ...s, install: installCmd(p.packageManager, s.devDependencies) }))
    .sort((a, b) => b.score - a.score || RUNNERS.indexOf(a.runner) - RUNNERS.indexOf(b.runner));
  return { ranked, notSuggested };
}

export type Suggest =
  | { status: 'unsupported'; dir: string; reason: string }
  | { status: 'has-tests'; dir: string; existing: { dir: string; runner: string }[] }
  | { status: 'suggestions'; dir: string; project: Project; suggestions: Suggestion[]; notSuggested: NotSuggested[] };

/**
 * Test framework suggestions for the project at <dir> (the root or one package). Writes nothing. <language>: the
 * language the user confirmed, used instead of the detected one. <testDir>: where the tests will go, from the package.
 */
export function suggest(dir: string, root = dir, { language, testDir }: { language?: Language; testDir?: string } = {}): Suggest {
  dir = path.resolve(dir); root = path.resolve(root);
  let pkg: Json | null = null;
  try { pkg = readJson(path.join(dir, 'package.json')); } catch { /* none */ }
  if (!pkg) {
    const other = OTHER_ECOSYSTEMS.filter(([f]) => exists(path.join(dir, f)));
    const below = packagesBelow(dir);
    return {
      status: 'unsupported', dir: rel(root, dir), reason: other.length
        ? `only Node/TypeScript projects are supported for now (found ${other.map(([f, l]) => `${f}: ${l}`).join(', ')})`
        : `no package.json here; only Node/TypeScript projects are supported for now${below.length
          ? `. Packages below: ${below.join(', ')} (run it there, or pass --test-dir <folder inside one of them>)` : ''}`,
    };
  }
  const existing = (dir === root ? detect(root) : [detectPackage(dir, root)].filter(d => d !== null)).filter(f => f && f.runner);
  if (existing.length) return { status: 'has-tests', dir: rel(root, dir), existing: existing.map(f => ({ dir: f!.dir, runner: f!.runner! })) };
  const project = describeProject(dir, root, pkg);
  if (language) Object.assign(project, { language, languageSource: 'confirmed' });
  const { ranked, notSuggested } = rankRunners(project);
  if (!ranked.length) {
    return { status: 'unsupported', dir: project.dir, reason: `no supported test framework runs on Node ${project.node}: ${notSuggested.map(n => n.reason).join('; ')}` };
  }
  ranked[0].recommended = true;
  for (const x of ranked) {
    const plan = setupPlan(project, x.runner, { testDir });
    x.adds = { script: plan.script, files: plan.files.map(f => f.path) };
  }
  return { status: 'suggestions', dir: project.dir, project, suggestions: ranked, notSuggested };
}

export interface SetupPlan {
  runner: SuggestedRunner;
  script: string;
  devDependencies: string[];
  install: string | null;
  files: { path: string; content: string }[];
  notes: string[];
}

/**
 * The files, script and packages that set up <runner> in this project. Nothing is written here. <testDir>: the folder for
 * tests, relative to the package (default: src/ for vitest and jest when it exists, else test/).
 */
export function setupPlan(p: Project, runner: SuggestedRunner, { testDir }: { testDir?: string } = {}): SetupPlan {
  const ts = p.language === 'typescript';
  const esm = p.module === 'esm';
  const dom = p.frontend.length > 0;
  const ext = ts ? 'ts' : 'js';
  const [major, minor] = p.nodeVersion;
  const stripTypes = major > 22 || (major === 22 && minor >= 18);
  const { ranked } = rankRunners(p);
  const chosen = ranked.find(r => r.runner === runner) || { devDependencies: [], install: null };
  const files: { path: string; content: string }[] = [];
  const notes: string[] = [];
  let script = '';
  const folder = (d: string) => testDir || d;
  const glob = (d: string) => `${folder(d)}/**/*.test.${ext}`;
  const imports = (names: string, from: string) => (esm || ts ? `import { ${names} } from '${from}';` : `const { ${names} } = require('${from}');`);
  const assertImport = esm || ts ? "import assert from 'node:assert/strict';" : "const assert = require('node:assert/strict');";

  if (runner === 'vitest') {
    const sample = `${folder(p.srcDir ? 'src' : 'test')}/example.test.${ext}`;
    script = 'vitest run';
    const e2e = p.e2eDirs.map(d => `'${d}/**'`);
    const include = testDir ? `'${testDir}/**/*.{test,spec}.?(c|m)[jt]s?(x)'` : null;
    if (p.vite && (dom || e2e.length || include)) {
      if (dom) notes.push("add test: { environment: 'jsdom' } to your vite.config to test components");
      if (include) notes.push(`add test: { include: [${include}] } to your vite.config so Vitest looks in ${testDir}`);
      if (e2e.length) notes.push(`add test: { exclude: [...configDefaults.exclude, ${e2e.join(', ')}] } to your vite.config so Vitest leaves the end-to-end tests alone`);
    } else if (dom || e2e.length || include) {
      const opts = [dom ? "environment: 'jsdom'" : null, include ? `include: [${include}]` : null,
        e2e.length ? `exclude: [...configDefaults.exclude, ${e2e.join(', ')}]` : null].filter(Boolean);
      files.push({
        path: `vitest.config.${ts ? 'ts' : 'mjs'}`,
        content: `import { ${e2e.length ? 'configDefaults, ' : ''}defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n${opts.map(o => `    ${o},`).join('\n')}\n  },\n});\n`,
      });
    }
    files.push({ path: sample, content: `// ${SAMPLE_NOTE}\nimport { describe, it, expect } from 'vitest';\n\ndescribe('example', () => {\n  it('adds numbers', () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n` });
  } else if (runner === 'jest') {
    const sample = `${folder(p.srcDir ? 'src' : 'test')}/example.test.${ext}`;
    script = esm ? 'node --experimental-vm-modules node_modules/jest/bin/jest.js' : 'jest';
    const conf = [
      ts ? `  preset: '${esm ? 'ts-jest/presets/default-esm' : 'ts-jest'}',` : null,
      testDir ? `  roots: ['<rootDir>/${testDir}'],` : null,
      `  testEnvironment: '${dom ? 'jsdom' : 'node'}',`,
      `  testPathIgnorePatterns: [${['/node_modules/', '/dist/', ...p.e2eDirs.map(d => `/${d}/`)].map(x => `'${x}'`).join(', ')}],`,
    ].filter(Boolean).join('\n');
    files.push({ path: 'jest.config.js', content: `/** @type {import('jest').Config} */\n${esm ? 'export default' : 'module.exports ='} {\n${conf}\n};\n` });
    files.push({ path: sample, content: `// ${SAMPLE_NOTE}\ndescribe('example', () => {\n  test('adds numbers', () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n` });
  } else if (runner === 'node-test') {
    const sample = `${folder('test')}/example.test.${ext}`;
    // Node 21+ expands the pattern itself; Node 18/20 take a folder (searched for .js test files) or the shell's list.
    const globs = major >= 21;
    if (ts && !stripTypes) script = globs ? `tsx --test "${glob('test')}"` : `tsx --test ${folder('test')}/*.test.ts`;
    else script = globs ? `node --test "${glob('test')}"` : `node --test ${folder('test')}/`;
    files.push({ path: sample, content: `// ${SAMPLE_NOTE}\n${imports('describe, it', 'node:test')}\n${assertImport}\n\ndescribe('example', () => {\n  it('adds numbers', () => {\n    assert.equal(1 + 1, 2);\n  });\n});\n` });
  } else if (runner === 'mocha') {
    const sample = `${folder('test')}/example.test.${ext}`;
    script = 'mocha';
    const rc = !ts ? { spec: glob('test') }
      : major < 18 ? { spec: glob('test'), require: ['ts-node/register'] } : { spec: glob('test'), 'node-option': ['import=tsx'] };
    files.push({ path: '.mocharc.json', content: JSON.stringify(rc, null, 2) + '\n' });
    files.push({ path: sample, content: `// ${SAMPLE_NOTE}\n${assertImport}\n\ndescribe('example', () => {\n  it('adds numbers', () => {\n    assert.equal(1 + 1, 2);\n  });\n});\n` });
  }
  return { runner, script, devDependencies: chosen.devDependencies, install: chosen.install, files, notes };
}

/** Folders with a package.json below <root> (up to SCAN_DEPTH levels; node_modules and dot folders skipped). */
export function packagesBelow(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 0 && exists(path.join(dir, 'package.json'))) out.push(rel(root, dir));
    if (depth >= SCAN_DEPTH) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  walk(path.resolve(root), 0);
  return out.sort();
}

/**
 * Where a test folder given from <root> (e.g. "__tests__", "server/__tests__", "client/_test") belongs: the nearest folder
 * at or above it, inside <root>, with a package.json. Returns { pkgDir, testDir } (testDir relative to the package) or { error }.
 */
export function locateTestDir(root: string, testDir: string): { pkgDir: string; testDir: string } | { error: string } {
  root = path.resolve(root);
  const target = path.resolve(root, testDir);
  const fromRoot = path.relative(root, target);
  if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return { error: `the test folder must be a folder inside ${root} (got "${testDir}")` };
  if (!/^[\w.@/-]+$/.test(fromRoot.split(path.sep).join('/'))) return { error: `the test folder "${testDir}" may only use letters, digits and . _ - @ /` };
  if (exists(target) && !fs.statSync(target).isDirectory()) return { error: `${testDir} is a file, not a folder` };
  for (let d = path.dirname(target); ; d = path.dirname(d)) {
    if (exists(path.join(d, 'package.json'))) return { pkgDir: d, testDir: path.relative(d, target).split(path.sep).join('/') };
    if (d === root || path.dirname(d) === d) break;
  }
  const below = packagesBelow(root);
  return { error: `no package.json in ${path.dirname(fromRoot) === '.' ? 'the project root' : `${path.dirname(fromRoot)} or above it`}; the test folder must be inside a Node package${below.length ? ` (packages here: ${below.join(', ')})` : ''}` };
}

export type Spawn = (cmd: string, args: string[], opts: Json) => { status: number | null; stdout?: string; stderr?: string };

export interface ProvisionResult {
  ok: boolean;
  plan?: SetupPlan;
  written?: string[];
  skipped?: string[];
  steps?: { cmd: string; status: number | null; output: string }[];
  dryRun?: boolean;
  error?: string;
}

/**
 * Set up <runner> in the Node project at <dir>: installs the packages first (so a failed install changes nothing), then
 * writes the files and scripts.test and runs the tests once. Files that already exist are kept; a real test script is
 * never replaced.
 */
export function provision(dir: string, runner: string, {
  root = dir, language, testDir, install = true, dryRun = false, run = spawnSync as unknown as Spawn,
}: { root?: string; language?: Language; testDir?: string; install?: boolean; dryRun?: boolean; run?: Spawn } = {}): ProvisionResult {
  dir = path.resolve(dir); root = path.resolve(root);
  const s = suggest(dir, root, { language });
  if (s.status === 'unsupported') return { ok: false, error: s.reason };
  if (s.status === 'has-tests') return { ok: false, error: `tests are already set up (${s.existing.map(e => `${e.dir}: ${e.runner}`).join(', ')})` };
  const blocked = s.notSuggested.find(n => n.runner === runner);
  if (blocked) return { ok: false, error: blocked.reason };
  if (!s.suggestions.some(x => x.runner === runner)) return { ok: false, error: `unknown framework "${runner}" (use ${s.suggestions.map(x => x.runner).join(', ')})` };
  const pkgFile = path.join(dir, 'package.json');
  const current = (JSON.parse(fs.readFileSync(pkgFile, 'utf8')).scripts || {}).test;
  if (typeof current === 'string' && current.trim() && !PLACEHOLDER_TEST.test(current)) {
    return { ok: false, error: `package.json already has a test script ("${current}"); remove it first, or add the suite to ${CONFIG_FILE} by hand` };
  }
  const plan = setupPlan(s.project, runner as SuggestedRunner, { testDir });
  const written: string[] = [];
  const skipped: string[] = [];
  const steps: { cmd: string; status: number | null; output: string }[] = [];
  if (dryRun) return { ok: true, plan, written, skipped, steps, dryRun: true };
  const sh = (cmd: string) => {
    const a = shellArgv(cmd);
    const r = run(a.file, a.args, { cwd: dir, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, windowsVerbatimArguments: a.windowsVerbatimArguments });
    steps.push({ cmd, status: r.status, output: `${r.stdout || ''}${r.stderr || ''}`.slice(-4000) });
    return r.status === 0;
  };
  if (install && plan.install && !sh(plan.install)) return { ok: false, plan, written, skipped, steps, error: `installing failed: ${plan.install}` };
  for (const f of plan.files) {
    const target = path.join(dir, f.path);
    if (exists(target)) { skipped.push(f.path); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
    written.push(f.path);
  }
  const raw = fs.readFileSync(pkgFile, 'utf8');
  const pkg = JSON.parse(raw);
  const indent = (raw.match(/^[ \t]+(?=")/m) || ['  '])[0];
  pkg.scripts = { ...(pkg.scripts || {}), test: plan.script };
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
  written.push('package.json (scripts.test)');
  if (!install) return { ok: true, plan, written, skipped, steps };
  // The example test runs on the project's Node, as the pipeline will run it.
  const node = nodeRun(dir, readSettings(root).node || {});
  const plain = s.project.packageManager === 'bun' ? 'bun run test' : `${s.project.packageManager} test`;
  const testCmd = node.switchTo && node.manager ? wrapCommand(plain, node.switchTo, node.manager) : plain;
  if (!sh(testCmd)) return { ok: false, plan, written, skipped, steps, error: `the example test did not pass: ${testCmd}` };
  return { ok: true, plan, written, skipped, steps };
}
