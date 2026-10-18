import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { PackageManager } from '../src/config/detect.js';
import { Exit, type Ctx } from '../src/pipeline/context.js';
import { installDeps, parseDependencies } from '../src/pipeline/deps.js';
import { tmp } from './helpers.js';

const PLAN = '# Plan\n\n## Dependencies\n- runtime: `pino@10.3.1`\n- runtime: @google-cloud/pino-logging-gcp-config@1.3.6 (structured logging)\n- dev: pino-pretty@13.1.1\n\n## Steps\n- runtime: not-a-dep@1.0.0\n';

describe('parseDependencies', () => {
  test('reads runtime and dev packages from the Dependencies section only, with backticks and trailing notes', () => {
    expect(parseDependencies(PLAN)).toEqual({
      runtime: ['pino@10.3.1', '@google-cloud/pino-logging-gcp-config@1.3.6'], dev: ['pino-pretty@13.1.1'], bad: [],
    });
  });

  test('collects anything that is not an exact version as bad, and ignores "- none", other lines and CRLF endings', () => {
    const plan = '## Dependencies\r\n- none\r\n- runtime: pino@^10.3.1\r\n- dev: pino-pretty\r\n- runtime: a@1.0\r\n- runtime: b@latest\r\n- dev: ok@2.0.0-beta.1\r\nsome prose\r\n* runtime: star@3.0.0\r\n';
    expect(parseDependencies(plan)).toEqual({
      runtime: ['star@3.0.0'], dev: ['ok@2.0.0-beta.1'], bad: ['pino@^10.3.1', 'pino-pretty', 'a@1.0', 'b@latest'],
    });
  });

  test('a plan without the section, or with a lookalike heading, lists nothing', () => {
    for (const plan of ['', '# Plan\n- runtime: x@1.0.0\n', '## Dependencies and more\n- runtime: x@1.0.0\n', '# Dependencies\n- runtime: x@1.0.0\n']) {
      expect(parseDependencies(plan)).toEqual({ runtime: [], dev: [], bad: [] });
    }
  });
});

interface Setup { dir: string; ctx: Ctx; lines: string[]; calls: () => string[]; log: () => string }

/** A project folder with a stand-in package manager that records its arguments (and fails when FAIL_PM is set). */
function setup(plan: string | null, opts: { manager?: PackageManager; link?: boolean; lock?: string; packageJson?: boolean; env?: NodeJS.ProcessEnv } = {}): Setup {
  const manager = opts.manager || 'npm';
  const dir = tmp('sdlc-deps-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'docs'));
  if (opts.packageJson !== false) fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo"}\n');
  fs.writeFileSync(path.join(bin, manager), `#!/bin/sh\necho "$@" >> "${dir}/calls.txt"\n[ -z "$FAIL_PM" ] || { echo "boom" >&2; exit 1; }\n`, { mode: 0o755 });
  if (plan !== null) fs.writeFileSync(path.join(dir, 'docs/plan-1.md'), plan);
  if (opts.lock) fs.writeFileSync(path.join(dir, opts.lock), '');
  if (opts.link) {
    fs.mkdirSync(path.join(dir, 'shared'));
    fs.symlinkSync(path.join(dir, 'shared'), path.join(dir, 'node_modules'));
  }
  const lines: string[] = [];
  const ctx = {
    root: dir, docs: 'docs', log: 'docs', out: (l: string) => { lines.push(l); },
    env: { ...process.env, ...opts.env, PATH: `${bin}:${process.env.PATH}` },
    config: { suites: [{ dir: '.', packageManager: manager }], node: {} },
  } as unknown as Ctx;
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  return { dir, ctx, lines, calls: () => read('calls.txt').split('\n').filter(Boolean), log: () => read('docs/deps.log') };
}

const exitCode = (fn: () => void): number | null => {
  try { fn(); } catch (e) { if (e instanceof Exit) return e.code; throw e; }
  return null;
};

describe('installDeps', () => {
  test('installs the exact runtime and dev versions in the suite folder, without install scripts', () => {
    const s = setup(PLAN);
    installDeps(s.ctx);
    expect(s.calls()).toEqual([
      'install --save-exact --no-audit --no-fund --ignore-scripts pino@10.3.1 @google-cloud/pino-logging-gcp-config@1.3.6',
      'install --save-exact --no-audit --no-fund --ignore-scripts -D pino-pretty@13.1.1',
    ]);
    expect(s.lines).toEqual([
      '   installing dependencies: pino@10.3.1 @google-cloud/pino-logging-gcp-config@1.3.6',
      '   installing dev dependencies: pino-pretty@13.1.1',
    ]);
    expect(s.log()).toContain('$ npm install --save-exact');
  });

  test('SDLC_DEP_SCRIPTS=run lets install scripts run', () => {
    const s = setup('## Dependencies\n- dev: jest-junit@16.0.0\n', { env: { SDLC_DEP_SCRIPTS: 'run' } });
    s.ctx.env.SDLC_DEP_SCRIPTS = 'run';
    installDeps(s.ctx);
    expect(s.calls()).toEqual(['install --save-exact --no-audit --no-fund -D jest-junit@16.0.0']);
  });

  test('uses the project\'s own package manager, with its own flags', () => {
    const s = setup('## Dependencies\n- runtime: a@1.0.0\n- dev: b@2.0.0\n', { manager: 'pnpm' });
    installDeps(s.ctx);
    expect(s.calls()).toEqual(['add --save-exact --ignore-scripts a@1.0.0', 'add --save-exact --ignore-scripts -D b@2.0.0']);
    const y = setup('## Dependencies\n- runtime: a@1.0.0\n', { manager: 'yarn' });
    installDeps(y.ctx);
    expect(y.calls()).toEqual(['add --exact a@1.0.0']);
  });

  test('does nothing without a plan, without the section, or with "- none"', () => {
    for (const plan of [null, '# Plan\n## Steps\n- x\n', '## Dependencies\n- none\n']) {
      const s = setup(plan, { link: true });
      installDeps(s.ctx);
      expect(s.calls()).toEqual([]);
      expect(s.lines).toEqual([]);
      expect(fs.lstatSync(path.join(s.dir, 'node_modules')).isSymbolicLink()).toBe(true);
    }
  });

  test('a range or a missing version stops the run (failed) and installs nothing', () => {
    const s = setup('## Dependencies\n- runtime: pino@^10.3.1\n- dev: pino-pretty\n- runtime: ok@1.0.0\n');
    expect(exitCode(() => installDeps(s.ctx))).toBe(1);
    expect(s.lines).toEqual([
      "ERROR: dependency 'pino@^10.3.1' in docs/plan-1.md must be name@<exact version>",
      "ERROR: dependency 'pino-pretty' in docs/plan-1.md must be name@<exact version>",
    ]);
    expect(s.calls()).toEqual([]);
  });

  test('a node_modules link shared with the main working tree is replaced by a clean install of the worktree\'s own first', () => {
    const s = setup('## Dependencies\n- runtime: pino@10.3.1\n', { link: true, lock: 'package-lock.json' });
    installDeps(s.ctx);
    expect(fs.existsSync(path.join(s.dir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(s.dir, 'shared'))).toBe(true); // the shared folder itself is left alone
    expect(s.calls()).toEqual(['ci --no-audit --no-fund', 'install --save-exact --no-audit --no-fund --ignore-scripts pino@10.3.1']);
    expect(s.lines[0]).toContain("replacing the shared node_modules link with this worktree's own install");

    const noLock = setup('## Dependencies\n- runtime: pino@10.3.1\n', { link: true });
    installDeps(noLock.ctx);
    expect(noLock.calls()[0]).toBe('install --no-audit --no-fund');
  });

  test('a real node_modules folder is kept as it is', () => {
    const s = setup('## Dependencies\n- runtime: pino@10.3.1\n');
    fs.mkdirSync(path.join(s.dir, 'node_modules'));
    fs.writeFileSync(path.join(s.dir, 'node_modules/keep.txt'), 'x');
    installDeps(s.ctx);
    expect(fs.existsSync(path.join(s.dir, 'node_modules/keep.txt'))).toBe(true);
    expect(s.calls()).toHaveLength(1);
  });

  test('a failed install stops the run (failed) and says where the output is', () => {
    const s = setup('## Dependencies\n- runtime: pino@10.3.1\n', { env: { FAIL_PM: '1' } });
    s.ctx.env.FAIL_PM = '1';
    expect(exitCode(() => installDeps(s.ctx))).toBe(1);
    expect(s.lines.at(-1)).toBe('ERROR: npm add failed, see docs/deps.log');
    expect(s.log()).toContain('boom');
  });

  test('a suite folder without package.json stops the run (failed) before installing', () => {
    const s = setup('## Dependencies\n- runtime: pino@10.3.1\n', { packageJson: false });
    expect(exitCode(() => installDeps(s.ctx))).toBe(1);
    expect(s.lines).toEqual(['ERROR: cannot install dependencies: no package.json in .']);
    expect(s.calls()).toEqual([]);
  });
});
