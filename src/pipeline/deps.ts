// New dependencies: Plan confirms a package's API from its published docs and lists exact versions under
// "## Dependencies" in plan-1.md; Implement starts by installing them. No stage before Implement installs anything.
import fs from 'node:fs';
import path from 'node:path';
import { wrapCommand } from '../config/node.js';
import type { PackageManager } from '../config/detect.js';
import { runShell } from '../shell.js';
import { exists, shellWord } from '../util.js';
import { at, stop, type Ctx } from './context.js';

export interface PlannedDeps { runtime: string[]; dev: string[]; bad: string[] }

const EXACT = /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/**
 * The packages a plan lists under "## Dependencies", one per line: `- runtime: name@1.2.3` or `- dev: name@1.2.3`
 * (backticks allowed). <bad> holds the entries that do not name an exact version.
 */
export function plannedDeps(planText: string): PlannedDeps {
  const out: PlannedDeps = { runtime: [], dev: [], bad: [] };
  let on = false;
  for (const line of planText.split('\n')) {
    if (line.startsWith('## ')) { on = line.trim() === '## Dependencies'; continue; }
    const m = on && /^[-*] +(runtime|dev): *`?([^` ]+)`?.*$/.exec(line);
    if (!m) continue;
    if (!EXACT.test(m[2])) out.bad.push(m[2]);
    else out[m[1] as 'runtime' | 'dev'].push(m[2]);
  }
  return out;
}

/** The install commands of a package manager: a clean install from the lockfile, and adding exact versions. */
export function installCommands(pm: PackageManager, specs: string[], { dev = false, scripts = false } = {}): { clean: string; add: string } {
  const list = specs.map(shellWord).join(' ');
  const noScripts = scripts ? '' : ' --ignore-scripts';
  switch (pm) {
    case 'pnpm': return { clean: 'pnpm install --frozen-lockfile', add: `pnpm add --save-exact${noScripts}${dev ? ' -D' : ''} ${list}` };
    case 'yarn': return { clean: 'yarn install --frozen-lockfile', add: `yarn add --exact${noScripts}${dev ? ' -D' : ''} ${list}` };
    case 'bun': return { clean: 'bun install --frozen-lockfile', add: `bun add --exact${noScripts}${dev ? ' -d' : ''} ${list}` };
    default: return { clean: 'npm ci --no-audit --no-fund', add: `npm install --save-exact --no-audit --no-fund${noScripts}${dev ? ' -D' : ''} ${list}` };
  }
}

/**
 * Installs the plan's dependencies into the first suite's package, with its package manager and the project's Node.
 * Install scripts are skipped unless SDLC_DEP_SCRIPTS=run. In a worktree, a node_modules that is a link to the main
 * checkout's is first replaced by the worktree's own clean install, so the main checkout's packages never change.
 */
export function installDeps(ctx: Ctx): void {
  const plan = at(ctx, `${ctx.docs}/plan-1.md`);
  if (!exists(plan)) return;
  const deps = plannedDeps(fs.readFileSync(plan, 'utf8'));
  for (const b of deps.bad) ctx.out(`ERROR: dependency '${b}' in ${ctx.docs}/plan-1.md must be name@<exact version>`);
  if (deps.bad.length) stop(ctx, null, 1);
  if (!deps.runtime.length && !deps.dev.length) return;
  const suite = ctx.config.suites[0];
  const dir = path.join(ctx.root, suite.dir);
  const node = ctx.config.node;
  const wrap = (cmd: string) => (node.switchTo && node.manager ? wrapCommand(cmd, node.switchTo, node.manager) : cmd);
  const log = at(ctx, `${ctx.log}/deps.log`);
  fs.writeFileSync(log, '');
  const sh = (cmd: string) => {
    const r = runShell(wrap(cmd), { cwd: dir, env: ctx.env, maxBuffer: 64 * 1024 * 1024 });
    fs.appendFileSync(log, `$ ${cmd}\n${r.stdout || ''}${r.stderr || ''}`);
    if (r.status !== 0) stop(ctx, `ERROR: ${cmd.split(' ').slice(0, 2).join(' ')} failed, see ${ctx.log}/deps.log`, 1);
  };
  const scripts = ctx.env.SDLC_DEP_SCRIPTS === 'run';
  const modules = path.join(dir, 'node_modules');
  if (fs.lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) {
    ctx.out(`   replacing the shared ${path.posix.join(suite.dir, 'node_modules')} link with this worktree's own install`);
    fs.unlinkSync(modules);
    sh(installCommands(suite.packageManager, []).clean);
  }
  if (deps.runtime.length) {
    ctx.out(`   installing dependencies: ${deps.runtime.join(' ')}`);
    sh(installCommands(suite.packageManager, deps.runtime, { scripts }).add);
  }
  if (deps.dev.length) {
    ctx.out(`   installing dev dependencies: ${deps.dev.join(' ')}`);
    sh(installCommands(suite.packageManager, deps.dev, { dev: true, scripts }).add);
  }
}
