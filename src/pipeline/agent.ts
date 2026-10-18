// Stage agents: headless `claude -p` with the stage's prompt, model, tools and permission mode; the transcript is kept
// and whatever the agent was refused is recorded for the developer to allow or deny.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { extract, modeFor, rulesFor } from '../permissions/index.js';
import { testDir, testFramework } from '../config/settings.js';
import { at, stamp, stop, stopIfAborted, tick, type AgentStage, type Ctx } from './context.js';
import { modelFlags, providerEnv, stageModel } from './models.js';
import { manualInput, renderPrompt } from './prompts.js';
import { resumeHint } from './hints.js';

/** One agent process: claude's arguments, and the files its output goes to (one file when both are the same). */
export interface AgentRequest {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: string;
  stderr: string;
  signal?: AbortSignal;
}

/** Starts an agent and resolves with its exit code. Tests pass a stand-in. */
export type AgentSpawn = (req: AgentRequest) => Promise<number>;

/** Runs `claude` (from the request environment's PATH). */
export const spawnClaude: AgentSpawn = req => new Promise(resolve => {
  const out = fs.openSync(req.stdout, 'w');
  const err = req.stderr === req.stdout ? out : fs.openSync(req.stderr, 'w');
  let done = false;
  const finish = (code: number) => {
    if (done) return;
    done = true;
    fs.closeSync(out);
    if (err !== out) fs.closeSync(err);
    resolve(code);
  };
  const child = spawn('claude', req.args, { cwd: req.cwd, env: req.env, stdio: ['ignore', out, err], signal: req.signal });
  child.on('error', e => { try { fs.writeSync(err, `${e.message}\n`); } catch { /* closed */ } finish(127); });
  child.on('close', code => finish(code === null ? 1 : code));
});

/** What the Plan agent may use besides the stage tools: it reads a new library's published docs and types from the web. */
export const PLAN_TOOLS = ['WebFetch', 'WebSearch', 'mcp__context7'];

/** The reset text ("resets 1:10am (Asia/Dubai)") when the agent's call ended at the usage limit, else null. */
export function usageLimit(jsonFile: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    if (!data || data.api_error !== 'usage_limit_reached') return null;
    const m = /resets[^\n"\\]*/.exec(String(data.result || ''));
    return m ? m[0].trim() : 'resets later';
  } catch { return null; }
}

/** The {{PLACEHOLDER}} values of the run's prompts. */
export function promptValues(ctx: Ctx): Record<string, string> {
  const pkg = ctx.config.suites[0].dir;
  return {
    PACKAGE_DIR: pkg, NODE_MODULES: pkg === '.' ? 'node_modules' : `${pkg}/node_modules`, FETCH_CMD: ctx.fetchCmd,
    DOCS: ctx.docs, LOG: ctx.log, TEST_DIR: testDir(ctx.config.suites[0]), TEST_CMD: ctx.layout.testCmd, TEST_FILE_CMD: ctx.testFileCmd,
    RED_SHA: ctx.redSha, SLUG: ctx.slug, TEST_FRAMEWORK: testFramework(ctx.config), TEST_FILES: ctx.layout.testFiles || `${testDir(ctx.config.suites[0])}/`,
  };
}

/** The model flags and provider environment of <stage>; prints the model line and records it in the status. */
export function stageFlags(ctx: Ctx, stage: AgentStage): { args: string[]; env: Record<string, string> } {
  const sm = stageModel(stage, { env: ctx.env, fromFile: ctx.envModels, registryFile: ctx.registryFile });
  ctx.status.model = sm.model;
  ctx.status.effort = sm.effort;
  ctx.out(sm.provider.effortFlag ? `   model=${sm.model} effort=${sm.effort}` : `   model=${sm.model} (provider without effort)`);
  return { args: modelFlags(sm), env: providerEnv(sm.provider) };
}

/**
 * Runs the agent of <stage>, logged as <name> (<log>/<name>.json, .err and .log). Exits 2 when it was refused an action
 * (recorded in permissions.json), 1 when it failed.
 */
export async function runAgent(ctx: Ctx, name: string, stage: AgentStage): Promise<void> {
  stopIfAborted(ctx);
  let prompt = renderPrompt(stage, promptValues(ctx), ctx.guide, ctx.promptsDir);
  if (stage !== 'test-repair' && stage !== 'test-audit') prompt += manualInput(at(ctx, ctx.docs), stage, testDir(ctx.config.suites[0]));
  ctx.out(`   -> agent: ${name}`);
  const flags = stageFlags(ctx, stage);
  ctx.status.agent = name;
  ctx.status.agentStarted = stamp();
  ctx.status.write();
  // Rules the developer granted (this run's and the repository's) are added; a protected-path grant runs this stage without permission checks.
  const allowed = [...ctx.allowed, ...(stage === 'plan' ? PLAN_TOOLS : []), ...rulesFor(at(ctx, ctx.docs), ctx.permRepo)];
  const mode = modeFor(at(ctx, ctx.docs), stage);
  if (mode !== 'acceptEdits') ctx.out('   (permission checks are off for this stage: you allowed a protected path)');
  const base = at(ctx, `${ctx.log}/${name}`);
  // A usage limit is not the agent's failure: wait for the reset and run the same agent again.
  const { limitRetry, limitMaxWait } = ctx.limits;
  let waited = 0;
  let rc: number;
  for (;;) {
    rc = await ctx.spawnAgent({
      args: ['-p', prompt, ...flags.args, '--permission-mode', mode, '--allowedTools', ...allowed, '--output-format', 'json', '--max-turns', String(ctx.limits.maxTurns)],
      cwd: ctx.root, env: { ...ctx.env, ...flags.env }, stdout: `${base}.json`, stderr: `${base}.err`, signal: ctx.signal,
    });
    await tick();
    const limit = usageLimit(`${base}.json`);
    if (!limit) break;
    if (waited >= limitMaxWait) {
      ctx.status.note = '';
      stop(ctx, `   !! agent '${name}' hit the usage limit (${limit}) and it did not reset within ${limitMaxWait}s`, 1);
    }
    if (waited === 0) ctx.out(`   .. usage limit reached (${limit}): retrying '${name}' every ${limitRetry}s`);
    ctx.status.note = `usage limit, ${limit}`;
    ctx.status.write();
    await ctx.sleep(limitRetry * 1000, ctx.signal);
    stopIfAborted(ctx);
    waited += limitRetry;
  }
  if (ctx.status.note) {
    ctx.out(`   .. usage limit over, '${name}' ran`);
    ctx.status.note = '';
    ctx.status.write();
  }
  let pending = 0;
  try {
    pending = extract({ jsonFile: `${base}.json`, logFile: `${base}.log`, stateFile: at(ctx, `${ctx.log}/permissions.json`), stage, cwd: ctx.root, errFile: `${base}.err`, allowed });
  } catch { pending = 0; }
  if (pending > 0) {
    stop(ctx, `   !! agent '${name}' was refused ${pending} action(s): allow or deny them in the pane (or: ai-sdlc-helper permit ${ctx.slug} allow|always|deny all), then resume at ${stage}`, 2);
  }
  if (rc !== 0) {
    ctx.out(`   !! agent '${name}' failed, see ${ctx.log}/${name}.log`);
    if (stage === 'test-repair') resumeHint(ctx);
    stop(ctx, null, 1);
  }
}

/** The independent test auditor: read-only tools, its stdout and stderr in <log>/test-audit.log. Resolves its exit code. */
export async function runAudit(ctx: Ctx, prompt: string, flags: { args: string[]; env: Record<string, string> }): Promise<number> {
  const logFile = at(ctx, `${ctx.log}/test-audit.log`);
  return ctx.spawnAgent({
    args: ['-p', prompt, ...flags.args, '--allowedTools', 'Read', 'Glob', 'Grep', '--max-turns', '15'],
    cwd: ctx.root, env: { ...ctx.env, ...flags.env }, stdout: logFile, stderr: logFile, signal: ctx.signal,
  });
}
