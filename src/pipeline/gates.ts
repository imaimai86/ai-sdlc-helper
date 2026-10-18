// The checks between stages: the unit tests (through the runner adapters, a failure retried once), the integration
// suite, and test results at another commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSuites, summary } from '../runners/run.js';
import { testRunDefaults } from '../config/settings.js';
import { spawnShell } from '../shell.js';
import type { RunResult } from '../runners/types.js';
import { at, tick, type Ctx } from './context.js';

const firstLines = (s: string | null, n = 20) => String(s || '').trim().split('\n').slice(0, n).map(l => `      ${l}`).join('\n');

/** A run's result as the agents read it in tests.log: a summary per suite, then each failure with its message. */
export function resultText(results: RunResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(summary(r), `  command: ${r.command}`);
    for (const e of r.suiteErrors) lines.push(`  ERROR ${e.file || '(unknown file)'}: failed to run`, firstLines(e.message, 40));
    for (const t of r.tests.filter(x => x.status === 'failed')) lines.push(`  FAIL  ${t.file} :: ${t.name}`, firstLines(t.message));
    for (const f of r.retried?.flaky || []) lines.push(`  FLAKY ${f.file} :: ${f.name} (failed, then passed on retry)`);
  }
  return `${lines.join('\n')}\n`;
}

/** How the gates run the suites: tests.retry (default true) and tests.maxWorkers (default: the runner's own). */
const testRuns = (ctx: Ctx) => {
  const d = testRunDefaults(ctx.config.tests).pipeline;
  return { retry: d.retry, maxWorkers: d.maxWorkers ?? undefined };
};

/**
 * The unit tests of every suite, in the working tree, with tests.maxWorkers. Unless tests.retry is false, a failure is
 * run once more (the failed files) before it counts;
 * tests that failed and then passed are reported as flaky (WARNING, and a line in <log>/flaky-tests.md). Writes
 * <log>/tests.log (what the agents read) and <log>/tests.json (the RunResult).
 */
export function testsPass(ctx: Ctx): boolean {
  const logFile = at(ctx, `${ctx.log}/tests.log`);
  const r = runSuites(ctx.config, { root: ctx.root, ...testRuns(ctx), env: ctx.env });
  if ('error' in r) { fs.writeFileSync(logFile, `ERROR: ${r.error}\n`); return false; }
  fs.writeFileSync(logFile, resultText(r.results));
  fs.writeFileSync(at(ctx, `${ctx.log}/tests.json`), `${JSON.stringify(r.merged)}\n`);
  const flaky = r.merged.retried?.flaky || [];
  for (const f of flaky) ctx.out(`WARNING: flaky test failed, then passed on retry; not counted as a failure: ${f.file} :: ${f.name}`);
  if (flaky.length) {
    fs.appendFileSync(at(ctx, `${ctx.log}/flaky-tests.md`), flaky.map(f => `${f.file} :: ${f.name} :: first run: failed :: re-run: passed\n`).join(''));
  }
  return r.merged.ok;
}

/** Runs <cmd> with bash from the root (a POSIX shell or cmd.exe on Windows), its output in <logFile>; resolves its exit code. */
function shToFile(ctx: Ctx, cmd: string, logFile: string): Promise<number> {
  return new Promise(resolve => {
    const fd = fs.openSync(logFile, 'w');
    let done = false;
    const finish = (code: number) => { if (!done) { done = true; fs.closeSync(fd); resolve(code); } };
    const child = spawnShell(cmd, { bash: true, cwd: ctx.root, env: ctx.env, stdio: ['ignore', fd, fd], signal: ctx.signal });
    child.on('error', () => finish(127));
    child.on('close', code => finish(code === null ? 1 : code));
  });
}

/**
 * The integration suite: integration.cmd from the settings (none: nothing to run), output in <log>/integration.log. In CI
 * it is skipped with a warning unless SDLC_INTEGRATION_CI=run (or integration.ci "run" in the settings).
 */
export async function integrationPass(ctx: Ctx): Promise<boolean> {
  const integration = ctx.config.integration;
  if (!integration || !integration.cmd) return true;
  const logFile = at(ctx, `${ctx.log}/integration.log`);
  if (ctx.env.CI && (ctx.env.SDLC_INTEGRATION_CI || integration.ci || 'skip') !== 'run') {
    const warning = 'WARNING: integration tests skipped in CI; set SDLC_INTEGRATION_CI=run (or integration.ci "run") once CI can run them.';
    ctx.out(warning);
    fs.writeFileSync(logFile, `${warning}\n`);
    return true;
  }
  return (await shToFile(ctx, integration.cmd, logFile)) === 0;
}

/** The unit tests, then the integration suite; ctx.failLog names the log of the check that failed. */
export async function successCheck(ctx: Ctx): Promise<boolean> {
  await tick();
  const unit = testsPass(ctx);
  await tick();
  if (!unit) { ctx.failLog = `${ctx.log}/tests.log`; return false; }
  if (!(await integrationPass(ctx))) { ctx.failLog = `${ctx.log}/integration.log`; return false; }
  return true;
}

/** Writes the RunResult of the tests in <root> (every suite) to <out>; nothing when no suite runs. */
function writeResults(ctx: Ctx, root: string, out: string): void {
  try {
    const r = runSuites(ctx.config, { root, maxWorkers: testRuns(ctx).maxWorkers, env: ctx.env });
    if (!('error' in r)) fs.writeFileSync(out, `${JSON.stringify(r.merged)}\n`);
  } catch { /* the checks that read <out> report it */ }
}

/** The test results of the working tree, in <outRel>. */
export const resultsNow = (ctx: Ctx, outRel: string): void => writeResults(ctx, ctx.root, at(ctx, outRel));

/**
 * The test results on <sha>'s source, with <files> copied from the working tree, in <outRel>. The commit is checked out
 * in a temporary worktree that shares the settings' worktree links (node_modules and the like).
 */
export function resultsAt(ctx: Ctx, sha: string, outRel: string, files: string[] = []): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-at-'));
  const wt = path.join(tmp, 'wt');
  ctx.git.run('worktree', 'add', '-q', '--detach', wt, sha);
  try {
    for (const p of ctx.config.worktree.link) {
      if (fs.existsSync(at(ctx, p)) && !fs.existsSync(path.join(wt, p))) {
        fs.mkdirSync(path.dirname(path.join(wt, p)), { recursive: true });
        fs.symlinkSync(at(ctx, p), path.join(wt, p));
      }
    }
    for (const f of files.filter(x => fs.existsSync(at(ctx, x)))) {
      fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
      fs.copyFileSync(at(ctx, f), path.join(wt, f));
    }
    writeResults(ctx, wt, at(ctx, outRel));
  } finally {
    ctx.git.tryRun('worktree', 'remove', '--force', wt);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
