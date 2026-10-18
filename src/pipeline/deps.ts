// New dependencies. Nothing is installed before Implement: the Plan agent confirms a package's API from its published
// README and type definitions and lists the exact versions under "## Dependencies" in plan-1.md; the pipeline installs
// them at the start of Implement, in the first suite's package folder.
import fs from 'node:fs';
import path from 'node:path';
import { runShell } from '../shell.js';
import { wrapCommand } from '../config/node.js';
import type { PackageManager } from '../config/detect.js';
import { exists } from '../util.js';
import { at, stop, type Ctx } from './context.js';

/** A package pinned to one version: name@1.2.3 or @scope/name@1.2.3-beta.1 (no range, no tag). */
const EXACT = /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

export interface Dependencies {
  runtime: string[];
  dev: string[];
  /** The entries that are not name@<exact version>. */
  bad: string[];
}

/**
 * The packages under "## Dependencies" in a plan: one per line, `- runtime: name@1.2.3` or `- dev: name@1.2.3` (backticks
 * and a trailing note are fine; `- none` and any other line are ignored). Other sections are never read.
 */
export function parseDependencies(plan: string): Dependencies {
  const found: Dependencies = { runtime: [], dev: [], bad: [] };
  let on = false;
  for (const line of plan.split('\n').map(l => l.replace(/\r$/, ''))) {
    if (line.startsWith('## ')) { on = line.trimEnd() === '## Dependencies'; continue; }
    if (!on) continue;
    const m = /^[-*] +(runtime|dev): *`?([^` ]+)`?.*$/.exec(line);
    if (!m) continue;
    if (!EXACT.test(m[2])) found.bad.push(m[2]);
    else found[m[1] as 'runtime' | 'dev'].push(m[2]);
  }
  return found;
}

const hasLock = (dir: string, root: string, names: string[]): boolean => {
  for (let d = dir; ; d = path.dirname(d)) {
    if (names.some(n => exists(path.join(d, n)))) return true;
    if (d === root || d === path.dirname(d)) return false;
  }
};

interface Manager {
  /** The command that adds exact versions; `dev` and `scripts` are added by the caller. */
  add: string;
  dev: string;
  /** The flag that keeps install scripts from running, or null when the environment does it. */
  noScripts: string | null;
  env?: Record<string, string>;
  /** A clean install of what the lock file says. */
  clean(locked: boolean): string;
}

const MANAGERS: Record<PackageManager, Manager> = {
  npm: { add: 'npm install --save-exact --no-audit --no-fund', dev: '-D', noScripts: '--ignore-scripts', clean: l => (l ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund') },
  pnpm: { add: 'pnpm add --save-exact', dev: '-D', noScripts: '--ignore-scripts', clean: l => (l ? 'pnpm install --frozen-lockfile' : 'pnpm install') },
  // yarn 1 reads npm_config_ignore_scripts, yarn 2+ reads YARN_ENABLE_SCRIPTS
  yarn: { add: 'yarn add --exact', dev: '-D', noScripts: null, env: { npm_config_ignore_scripts: 'true', YARN_ENABLE_SCRIPTS: 'false' }, clean: () => 'yarn install' },
  bun: { add: 'bun add --exact', dev: '--dev', noScripts: '--ignore-scripts', clean: () => 'bun install' },
};

const LOCKS: Record<PackageManager, string[]> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'], bun: ['bun.lock', 'bun.lockb'],
};

/**
 * Installs the plan's dependencies (Implement only). Exact versions, no install scripts unless SDLC_DEP_SCRIPTS=run. In a
 * worktree, the node_modules link shared with the main working tree is first replaced by the worktree's own install, so
 * the main tree's packages never change. Prints what it did into the run's output and <log>/deps.log; stops the run
 * (failed) on a bad entry or a failed install. Does nothing without a plan, a Dependencies section or any package.
 */
export function installDeps(ctx: Ctx): void {
  const planFile = `${ctx.docs}/plan-1.md`;
  if (!exists(at(ctx, planFile))) return;
  const deps = parseDependencies(fs.readFileSync(at(ctx, planFile), 'utf8'));
  if (deps.bad.length) {
    for (const spec of deps.bad) ctx.out(`ERROR: dependency '${spec}' in ${planFile} must be name@<exact version>`);
    stop(ctx, null, 1);
  }
  if (!deps.runtime.length && !deps.dev.length) return;

  const suite = ctx.config.suites[0];
  const dir = at(ctx, suite.dir);
  const m = MANAGERS[suite.packageManager];
  const logFile = at(ctx, `${ctx.log}/deps.log`);
  fs.writeFileSync(logFile, '');
  if (!exists(path.join(dir, 'package.json'))) stop(ctx, `ERROR: cannot install dependencies: no package.json in ${suite.dir}`, 1);
  const node = ctx.config.node;
  const run = (cmd: string): boolean => {
    const wrapped = node.switchTo && node.manager ? wrapCommand(cmd, node.switchTo, node.manager) : cmd;
    const r = runShell(wrapped, { cwd: dir, env: { ...ctx.env, ...m.env } });
    fs.appendFileSync(logFile, `$ ${cmd}\n${r.stdout || ''}${r.stderr || ''}`);
    return r.status === 0;
  };
  const fail = (what: string): never => stop(ctx, `ERROR: ${what} failed, see ${ctx.log}/deps.log`, 1);

  const modules = path.join(dir, 'node_modules');
  let linked = false;
  try { linked = fs.lstatSync(modules).isSymbolicLink(); } catch { /* none */ }
  if (linked) {
    ctx.out("   replacing the shared node_modules link with this worktree's own install");
    fs.rmSync(modules, { recursive: true, force: true });
    if (!run(m.clean(hasLock(dir, ctx.root, LOCKS[suite.packageManager])))) fail(`${suite.packageManager} install`);
  }
  const scripts = ctx.env.SDLC_DEP_SCRIPTS === 'run' ? '' : m.noScripts ? ` ${m.noScripts}` : '';
  if (deps.runtime.length) {
    ctx.out(`   installing dependencies: ${deps.runtime.join(' ')}`);
    if (!run(`${m.add}${scripts} ${deps.runtime.join(' ')}`)) fail(`${suite.packageManager} add`);
  }
  if (deps.dev.length) {
    ctx.out(`   installing dev dependencies: ${deps.dev.join(' ')}`);
    if (!run(`${m.add}${scripts} ${m.dev} ${deps.dev.join(' ')}`)) fail(`${suite.packageManager} add`);
  }
}
