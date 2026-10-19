// What stage agents are given (tools, web reads, dependencies) and how a usage limit is waited out.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AgentRequest } from '../src/pipeline/agent.js';
import { installCommands, installDeps, plannedDeps } from '../src/pipeline/deps.js';
import { Exit } from '../src/pipeline/context.js';
import { allowedTools } from '../src/config/settings.js';
import { pathWith, tmp, write } from './helpers.js';
import { DOCS, fixture, pipeline, read, statusOf } from './pipeline-fixture.js';

afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
vi.setConfig({ testTimeout: 300_000 });

const result = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', permission_denials: [], ...extra });
const LIMIT = result({ subtype: 'error', is_error: true, api_error: 'usage_limit_reached', result: "You've hit your session limit · resets 1:10am (Asia/Dubai)" });
const isSpec = (req: AgentRequest) => req.args[1].startsWith('You are a Requirements Agent');
const isPlan = (req: AgentRequest) => req.args[1].startsWith('You are an Architecture Planner');
const tools = (req: AgentRequest) => req.args.slice(req.args.indexOf('--allowedTools') + 1, req.args.indexOf('--output-format'));

describe('stage agents', () => {
  test('every stage may run read-only commands and the GET-only fetch; only Plan gets the web tools', async () => {
    const f = fixture();
    const seen: AgentRequest[] = [];
    const spawnAgent = async (req: AgentRequest) => {
      seen.push(req);
      fs.writeFileSync(req.stdout, result());
      fs.writeFileSync(req.stderr, '');
      if (isSpec(req)) fs.writeFileSync(path.join(f.dir, DOCS, 'specs-1.md'), 'spec\n');
      if (isPlan(req)) fs.writeFileSync(path.join(f.dir, DOCS, 'questions.md'), '### Q1: x\nwhy\n**Suggested:** y\n**Answer:**\n');
      return 0;
    };
    const r = await pipeline(f, {}, { spawnAgent });
    expect(r.status).toBe(2);
    const [spec, plan] = seen.map(tools);
    for (const t of [spec, plan]) {
      expect(t).toEqual(expect.arrayContaining(['Bash(cat:*)', 'Bash(git show:*)', 'Bash(pwd)', 'Bash(npm view:*)']));
      expect(t.some(x => /^Bash\(.* fetch:\*\)$/.test(x))).toBe(true);
      expect(t.some(x => /^Bash\((curl|wget|find|npm install)[: ]/.test(x))).toBe(false);
    }
    expect(spec).not.toContain('WebFetch');
    expect(plan).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'mcp__context7']));
    expect(seen[1].args[1]).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(seen[1].args[1]).toMatch(/run `.* fetch <https-url>`, a GET-only fetch/);
  });

  test('the read-only rules are part of the settings, with no command that writes, runs code or reaches the network', () => {
    const t = allowedTools({ suites: [], agent: { codeIndexer: null, allowCommands: [] }, lint: null } as any);
    expect(t).toEqual(expect.arrayContaining(['Bash(head:*)', 'Bash(rg:*)', 'Bash(git ls-files:*)', 'Bash(git branch --show-current)']));
    expect(t.filter(x => /\b(rm|mv|cp|curl|wget|find|python|node|bash|sh)\b/.test(x))).toEqual([]);
  });
});

describe('a usage limit', () => {
  test('is waited out: the same agent runs again after the reset, with a note in status.json meanwhile', async () => {
    const f = fixture();
    let calls = 0;
    let noteDuringWait = '';
    const spawnAgent = async (req: AgentRequest) => {
      calls++;
      if (calls === 2) noteDuringWait = statusOf(f.dir).note;
      fs.writeFileSync(req.stdout, calls === 1 ? LIMIT : result());
      fs.writeFileSync(req.stderr, '');
      if (calls > 1) fs.writeFileSync(path.join(f.dir, DOCS, 'questions.md'), '### Q1: x\nwhy\n**Suggested:** y\n**Answer:**\n');
      return calls === 1 ? 1 : 0;
    };
    const r = await pipeline(f, { SDLC_LIMIT_RETRY: '0.05' }, { spawnAgent });
    expect(r.status).toBe(2);
    expect(calls).toBe(2);
    expect(noteDuringWait).toBe('usage limit, resets 1:10am (Asia/Dubai)');
    expect(r.stdout).toContain("   .. usage limit reached (resets 1:10am (Asia/Dubai)): retrying 'spec-1' every 0.05s");
    expect(r.stdout).toContain("   .. usage limit over, 'spec-1' ran");
    expect(r.stdout).not.toContain('failed, see');
    expect(statusOf(f.dir)).toMatchObject({ state: 'paused', note: '' });
  });

  test('fails the stage when it does not reset in time; any other failure is not retried', async () => {
    let f = fixture();
    let calls = 0;
    const always = async (req: AgentRequest) => { calls++; fs.writeFileSync(req.stdout, LIMIT); fs.writeFileSync(req.stderr, ''); return 1; };
    let r = await pipeline(f, { SDLC_LIMIT_RETRY: '0.05', SDLC_LIMIT_MAX_WAIT: '0.1' }, { spawnAgent: always });
    expect(r.status).toBe(1);
    expect(calls).toBe(3);
    expect(r.stdout).toContain("   !! agent 'spec-1' hit the usage limit (resets 1:10am (Asia/Dubai)) and it did not reset within 0.1s");
    expect(statusOf(f.dir)).toMatchObject({ state: 'failed', note: '' });

    f = fixture();
    calls = 0;
    const broken = async (req: AgentRequest) => { calls++; fs.writeFileSync(req.stdout, result({ subtype: 'error', is_error: true })); fs.writeFileSync(req.stderr, ''); return 1; };
    r = await pipeline(f, { SDLC_LIMIT_RETRY: '0.05' }, { spawnAgent: broken });
    expect(r.status).toBe(1);
    expect(calls).toBe(1);
    expect(r.stdout).toContain("   !! agent 'spec-1' failed, see");
  });
});

describe('dependencies from the plan', () => {
  test('the plan lists exact versions under "## Dependencies"; anything else there is refused', () => {
    const plan = '# Plan\n- runtime: not-here@1.0.0\n## Dependencies\n- runtime: `pino@9.5.0`\n- dev: @types/node@18.19.1 (types)\n* runtime: left-pad@^1.3.0\n- none\n## Steps\n- dev: later@1.0.0\n';
    expect(plannedDeps(plan)).toEqual({ runtime: ['pino@9.5.0'], dev: ['@types/node@18.19.1'], bad: ['left-pad@^1.3.0'] });
    expect(installCommands('npm', ['pino@9.5.0'])).toEqual({ clean: 'npm ci --no-audit --no-fund', add: 'npm install --save-exact --no-audit --no-fund --ignore-scripts pino@9.5.0' });
    expect(installCommands('pnpm', ['a@1.0.0'], { dev: true, scripts: true }).add).toBe('pnpm add --save-exact -D a@1.0.0');
    expect(installCommands('yarn', ['a@1.0.0'], { dev: true }).add).toBe('yarn add --exact --ignore-scripts -D a@1.0.0');
  });

  // installDeps in a package with a stand-in npm that logs its arguments.
  function setup(plan: string, { linked = false } = {}) {
    const root = tmp('ai-sdlc-deps-');
    write(root, 'web/package.json', { name: 'web' });
    write(root, 'items/s/plan-1.md', plan);
    fs.mkdirSync(path.join(root, 'items/s/logs'), { recursive: true });
    if (linked) {
      const shared = tmp('ai-sdlc-shared-');
      fs.symlinkSync(shared, path.join(root, 'web/node_modules'));
    }
    const env = pathWith();
    const bin = env.PATH!.split(':')[0];
    const calls = path.join(root, 'npm-calls.txt');
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$PWD|$*" >> '${calls}'\n[ "$1" != fail ]\n`, { mode: 0o755 });
    const out: string[] = [];
    const ctx: any = {
      root, docs: 'items/s', log: 'items/s/logs', env: { ...env, HOME: root },
      config: { suites: [{ dir: 'web', packageManager: 'npm' }], node: { switchTo: null, manager: null } },
      out: (l: string) => out.push(l),
    };
    return { root, ctx, out, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []) };
  }

  test('Implement installs them in the suite package, runtime then dev, without install scripts', () => {
    const s = setup('## Dependencies\n- runtime: pino@9.5.0\n- dev: @types/pino@7.0.5\n');
    installDeps(s.ctx);
    const web = fs.realpathSync(path.join(s.root, 'web'));
    expect(s.calls()).toEqual([
      `${web}|install --save-exact --no-audit --no-fund --ignore-scripts pino@9.5.0`,
      `${web}|install --save-exact --no-audit --no-fund --ignore-scripts -D @types/pino@7.0.5`,
    ]);
    expect(s.out).toEqual(['   installing dependencies: pino@9.5.0', '   installing dev dependencies: @types/pino@7.0.5']);
    expect(read(s.root, 'items/s/logs/deps.log')).toContain('$ npm install');
  });

  test('a node_modules linked to the main checkout is replaced by the worktree\'s own install first', () => {
    const s = setup('## Dependencies\n- runtime: pino@9.5.0\n', { linked: true });
    installDeps(s.ctx);
    expect(fs.lstatSync(path.join(s.root, 'web/node_modules'), { throwIfNoEntry: false })).toBeUndefined();
    expect(s.calls().map(c => c.split('|')[1])).toEqual(['ci --no-audit --no-fund', 'install --save-exact --no-audit --no-fund --ignore-scripts pino@9.5.0']);
    expect(s.out[0]).toBe("   replacing the shared web/node_modules link with this worktree's own install");
  });

  test('no plan or no dependencies installs nothing; a version that is not exact fails before any install', () => {
    let s = setup('## Dependencies\n- none\n');
    installDeps(s.ctx);
    expect(s.calls()).toEqual([]);
    s = setup('## Dependencies\n- runtime: pino@latest\n- runtime: ok@1.0.0\n');
    expect(() => installDeps(s.ctx)).toThrow(Exit);
    expect(s.calls()).toEqual([]);
    expect(s.out).toEqual(["ERROR: dependency 'pino@latest' in items/s/plan-1.md must be name@<exact version>"]);
  });
});
