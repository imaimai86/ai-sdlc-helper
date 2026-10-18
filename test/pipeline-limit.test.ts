import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DOCS, LOG, STAGES, filesIn, fixture, pipeline, read, statusOf } from './pipeline-fixture.js';

// The runs are long chains of synchronous git and test runs: yield between tests so the runner's messages get through.
afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
vi.setConfig({ testTimeout: 300_000 });

const RESET = 'resets 1:10am (Asia/Dubai)';
const toolsOf = (dir: string, stage: string): string[] => {
  const args = read(dir, `args-${stage}.txt`).split('\n');
  return args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--output-format'));
};

describe('a usage limit', () => {
  test('is waited out: the same agent runs again, and the status names the reset time meanwhile', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.fake, 'implement.limit'), '2');
    const waits: number[] = [];
    const notes: string[] = [];
    const r = await pipeline(f, { SDLC_LIMIT_RETRY: '7' }, {
      sleep: async ms => { waits.push(ms); notes.push(statusOf(f.dir).note); },
    });
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'implement', 'implement', 'implement', 'review']);
    expect(waits).toEqual([7000, 7000]);
    expect(notes).toEqual([`usage limit, ${RESET}`, `usage limit, ${RESET}`]);
    expect(r.stdout).toContain(`   .. usage limit reached (${RESET}): retrying 'impl-1' every 7s\n`);
    expect(r.stdout).toContain("   .. usage limit over, 'impl-1' ran\n");
    expect(r.stdout.match(/usage limit reached/g)).toHaveLength(1);
    // a limit is not an attempt: the stage still passed on its first
    expect(r.stdout).toContain(' attempt 1\n');
    expect(r.stdout).not.toContain(' attempt 2\n');
    expect(statusOf(f.dir)).toMatchObject({ state: 'done', note: '' });
  });

  test('that does not reset within SDLC_LIMIT_MAX_WAIT fails the stage and says why', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.fake, 'implement.limit'), '99');
    const waits: number[] = [];
    const r = await pipeline(f, { SDLC_LIMIT_RETRY: '10', SDLC_LIMIT_MAX_WAIT: '20' }, { sleep: async ms => { waits.push(ms); } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`   !! agent 'impl-1' hit the usage limit (${RESET}) and it did not reset within 20s\n`);
    expect(waits).toEqual([10_000, 10_000]);
    expect(r.calls.filter(c => c === 'implement')).toHaveLength(3);
    expect(r.calls).not.toContain('review');
    expect(statusOf(f.dir)).toMatchObject({ state: 'failed', note: '' });
  });

  test('is not waited out once the run is stopped', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.fake, 'implement.limit'), '99');
    const ac = new AbortController();
    const r = await pipeline(f, {}, { signal: ac.signal, sleep: async () => { ac.abort(); } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('STOPPED: the run was stopped');
    expect(r.calls.filter(c => c === 'implement')).toHaveLength(1);
  });

  test('a run that never hits it calls each agent once and leaves no note', async () => {
    const f = fixture();
    let slept = 0;
    const r = await pipeline(f, {}, { sleep: async () => { slept++; } });
    expect(r.status).toBe(0);
    expect(slept).toBe(0);
    expect(r.stdout).not.toContain('usage limit');
    expect(statusOf(f.dir).note).toBe('');
  });
});

describe('new dependencies', () => {
  const PLAN_WITH_DEPS = 'printf "# Plan\\n\\n## Dependencies\\n- runtime: left-pad@1.3.0\\n- dev: tiny-dev@2.0.1\\n" > "$FAKE_DOCS/plan-1.md"';

  test('Plan may read the web, nothing is installed before Implement, and Implement installs the plan\'s exact versions first', async () => {
    const f = fixture({
      plan: PLAN_WITH_DEPS,
      // what the packages Implement can see, taken the moment its agent starts
      implement: `cp "$FAKE_DIR/npm.calls" "$FAKE_DIR/npm-at-implement.txt"\n${STAGES.implement}`,
      'red-tests': `[ ! -f "$FAKE_DIR/npm.calls" ] || cp "$FAKE_DIR/npm.calls" "$FAKE_DIR/npm-at-red-tests.txt"\n${STAGES['red-tests']}`,
    });
    fs.writeFileSync(path.join(f.bin, 'npm'), '#!/bin/sh\necho "$@" >> "$FAKE_DIR/npm.calls"\n', { mode: 0o755 });
    const r = await pipeline(f, {}, { fetchCmd: 'ai-sdlc-helper fetch' });
    expect([r.status, r.stderr]).toEqual([0, '']);

    expect(read(f.fake, 'npm-at-red-tests.txt')).toBe('');
    expect(read(f.fake, 'npm-at-implement.txt').trim().split('\n')).toEqual([
      'install --save-exact --no-audit --no-fund --ignore-scripts left-pad@1.3.0',
      'install --save-exact --no-audit --no-fund --ignore-scripts -D tiny-dev@2.0.1',
    ]);
    expect(read(f.fake, 'npm.calls').trim().split('\n')).toHaveLength(2);
    expect(r.stdout).toContain('   installing dependencies: left-pad@1.3.0\n   installing dev dependencies: tiny-dev@2.0.1\n');
    expect(read(f.dir, `${LOG}/deps.log`)).toContain('$ npm install --save-exact');

    // only Plan gets the web tools
    const webTools = ['WebFetch', 'WebSearch', 'mcp__context7'];
    expect(toolsOf(f.fake, 'plan')).toEqual(expect.arrayContaining(webTools));
    for (const stage of ['spec', 'red-tests', 'implement', 'review']) {
      expect(toolsOf(f.fake, stage), stage).not.toEqual(expect.arrayContaining(['WebFetch']));
      expect(toolsOf(f.fake, stage), stage).not.toContain('mcp__context7');
    }
    // every stage may read a web page through the GET-only command, and none may run curl, wget or any node script
    for (const stage of ['spec', 'plan', 'red-tests', 'implement', 'review']) {
      expect(toolsOf(f.fake, stage), stage).toContain('Bash(ai-sdlc-helper fetch:*)');
      expect(toolsOf(f.fake, stage).filter(t => /^Bash\((curl|wget)\b|^Bash\(node:\*\)/.test(t)), stage).toEqual([]);
    }
    // the install log stays out of the commits
    expect(filesIn(f.dir, 'HEAD~1')).not.toContain(`${LOG}/deps.log`);
    expect(filesIn(f.dir, 'HEAD~2')).not.toContain(`${LOG}/deps.log`);
  });

  test('a plan that pins a range stops the run before any agent of Implement', async () => {
    const f = fixture({ plan: 'printf "## Dependencies\\n- runtime: left-pad@^1.3.0\\n" > "$FAKE_DOCS/plan-1.md"' });
    fs.writeFileSync(path.join(f.bin, 'npm'), '#!/bin/sh\necho "$@" >> "$FAKE_DIR/npm.calls"\n', { mode: 0o755 });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`ERROR: dependency 'left-pad@^1.3.0' in ${DOCS}/plan-1.md must be name@<exact version>`);
    expect(r.calls).not.toContain('implement');
    expect(read(f.fake, 'npm.calls')).toBe('');
  });
});
