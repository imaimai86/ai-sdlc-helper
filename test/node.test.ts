import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { nodeRun, projectNode, satisfiesMajor, wrapCommand } from '../src/config/node.js';
import { allowedTools, layout, resolve } from '../src/config/settings.js';
import { setupPlan, suggest as suggestOf } from '../src/config/suggest.js';
import { pathWith, project, run, tmp } from './helpers.js';

const suggest = (...a: Parameters<typeof suggestOf>): any => suggestOf(...a);

// A stand-in version manager: drops its own arguments up to "--" and runs the rest, as fnm exec and volta run do.
const fakeManager = (name: string): NodeJS.ProcessEnv => {
  const env = pathWith();
  const bin = env.PATH!.split(':')[0];
  fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  return env;
};

describe('the Node a project asks for', () => {
  test('a pin from .nvmrc, .node-version, .tool-versions or volta.node, else a range from engines.node', () => {
    expect(projectNode(project({ '.nvmrc': 'v16.20.2\n', 'package.json': { engines: { node: '>=20' } } })))
      .toEqual({ kind: 'pin', spec: '16.20.2', source: '.nvmrc', lowest: [16, 20] });
    expect(projectNode(project({ '.node-version': '20' }))).toMatchObject({ kind: 'pin', spec: '20', source: '.node-version' });
    expect(projectNode(project({ '.tool-versions': 'python 3.12.1\nnodejs 18.19.0\n' }))).toMatchObject({ kind: 'pin', spec: '18.19.0', lowest: [18, 19] });
    expect(projectNode(project({ 'package.json': { volta: { node: '14.21.3' } } }))).toMatchObject({ kind: 'pin', source: 'package.json volta.node' });
    expect(projectNode(project({ 'package.json': { engines: { node: '^16 || ^18' } } })))
      .toEqual({ kind: 'range', spec: '^16 || ^18', source: 'engines.node', lowest: [16, 0] });
  });

  test('says nothing for an lts/ alias or no hint at all', () => {
    expect(projectNode(project({ '.nvmrc': 'lts/hydrogen\n', 'package.json': {} }))).toBeNull();
    expect(projectNode(project({ 'package.json': {} }))).toBeNull();
  });

  test('a range is met by a major version: comparisons, carets, tildes, "and" by spaces and "or" by ||', () => {
    expect(satisfiesMajor('>=16', 22)).toBe(true);
    expect(satisfiesMajor('>=16 <20', 22)).toBe(false);
    expect(satisfiesMajor('^16 || ^18', 18)).toBe(true);
    expect(satisfiesMajor('^16 || ^18', 20)).toBe(false);
    expect(satisfiesMajor('~20.1', 20)).toBe(true);
    expect(satisfiesMajor('16.x', 16)).toBe(true);
    expect(satisfiesMajor('>14', 14)).toBe(false);
    expect(satisfiesMajor('<=18', 18)).toBe(true);
    expect(satisfiesMajor('*', 12)).toBe(true);
  });
});

describe('running the project\'s commands on its Node', () => {
  test('each manager wraps the command, and the command survives the quoting', () => {
    const cmd = `echo "it's" && echo $((1 + 1))`;
    expect(wrapCommand(cmd, '16', 'fnm')).toBe(`fnm exec --using=16 -- sh -c 'echo "it'\\''s" && echo $((1 + 1))'`);
    expect(wrapCommand(cmd, '16', 'volta')).toMatch(/^volta run --node 16 -- sh -c /);
    expect(wrapCommand(cmd, '16', 'npx')).toMatch(/^npx -y -p node@16 -- sh -c /);
    expect(wrapCommand(cmd, '16', 'nvm')).toMatch(/^bash -c '\. "\$\{NVM_DIR:-\$HOME\/\.nvm\}\/nvm\.sh" && nvm exec --silent 16 sh -c /);
    for (const m of ['fnm', 'volta'] as const) {
      const r = spawnSync('sh', ['-c', wrapCommand(cmd, '16', m)], { encoding: 'utf8', env: fakeManager(m) });
      expect(r.stdout).toBe("it's\n2\n");
    }
  });

  test('switches when a pin names another major or a range leaves out the current one; same major or a met range does not', () => {
    const env = fakeManager('fnm');
    expect(nodeRun(project({ '.nvmrc': '16' }), {}, env, '22.1.0')).toMatchObject({ switchTo: '16', manager: 'fnm', warning: null });
    expect(nodeRun(project({ '.nvmrc': '22.5.0' }), {}, env, '22.1.0')).toMatchObject({ switchTo: null });
    expect(nodeRun(project({ 'package.json': { engines: { node: '>=16 <20' } } }), {}, env, '22.1.0')).toMatchObject({ switchTo: '16' });
    expect(nodeRun(project({ 'package.json': { engines: { node: '>=16' } } }), {}, env, '22.1.0')).toMatchObject({ switchTo: null });
    expect(nodeRun(project({ 'package.json': {} }), {}, env, '22.1.0')).toMatchObject({ wanted: null, switchTo: null });
  });

  test('the node setting overrides what the project asks for, and picks or forbids the manager', () => {
    const env = { PATH: `${fakeManager('fnm').PATH}:${fakeManager('volta').PATH}` };
    const dir = project({ '.nvmrc': '16' });
    expect(nodeRun(dir, { version: 'current' }, env, '22.1.0')).toMatchObject({ switchTo: null, warning: null });
    expect(nodeRun(dir, { version: '20' }, env, '22.1.0')).toMatchObject({ switchTo: '20', manager: 'fnm' });
    expect(nodeRun(dir, { manager: 'volta' }, env, '22.1.0')).toMatchObject({ switchTo: '16', manager: 'volta' });
    const none = nodeRun(dir, { manager: 'none' }, env, '22.1.0');
    expect(none).toMatchObject({ switchTo: null, manager: null });
    expect(none.warning).toContain('node.manager is "none"');
  });

  test('without a manager the current Node runs the tests, with a warning that says what to do', () => {
    const r = nodeRun(project({ '.nvmrc': '16' }), {}, { PATH: '/nonexistent', HOME: tmp() }, '22.1.0');
    expect(r).toMatchObject({ switchTo: null, manager: null });
    expect(r.warning).toBe('.nvmrc asks for 16 but the tool runs on Node 22.1.0, and no Node version manager was found (fnm, volta, nvm, npx); '
      + 'tests run with Node 22.1.0. Install fnm, Volta or nvm, or set "node": { "version": "current" }.');
  });

  test('the settings wrap the test command and the lint command, and the agents may run the wrapped command', () => {
    const dir = project({ '.nvmrc': '12', 'package.json': { scripts: { test: 'jest' } }, 'sdlc.config.json': { lint: 'npm run lint', node: { manager: 'fnm' } } });
    const { config, errors } = resolve(dir, { env: fakeManager('fnm') });
    expect(errors).toEqual([]);
    expect(config!.suites[0].testCmd).toBe('npm test');
    expect(config!.suites[0].runCmd).toBe("fnm exec --using=12 -- sh -c 'npm test'");
    expect(config!.lint).toBe("fnm exec --using=12 -- sh -c 'npm run lint'");
    expect(layout(config!).testCmd).toBe("fnm exec --using=12 -- sh -c 'npm test'");
    expect(allowedTools(config!)).toContain("Bash(fnm exec --using=12 -- sh -c 'npm test':*)");
    expect(resolve(project({ 'package.json': { scripts: { test: 'jest' } }, 'sdlc.config.json': { node: { manager: 'brew' } } })).errors.join())
      .toContain('node.manager: must be one of');
  });

  test('the node command reports the Node in use', async () => {
    const r = await run(['node', project({ 'package.json': { engines: { node: '>=10' } } })]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`The tool runs on Node ${process.versions.node}.`);
    expect(r.stdout).toContain('The project asks for Node >=10 (engines.node, a range).');
  });
});

describe('suggestions for projects on old Node', () => {
  test('Node 16: no Vitest or node:test, Jest 29 and Mocha 10 pinned, ts-node for Mocha with TypeScript', () => {
    const s = suggest(project({ 'package.json': { engines: { node: '>=16' } }, 'tsconfig.json': '{}' }));
    expect(s.status).toBe('suggestions');
    expect(s.suggestions.map(x => x.runner)).toEqual(['jest', 'mocha']);
    expect(s.notSuggested.map(n => n.runner)).toEqual(['vitest', 'node-test']);
    expect(s.notSuggested[0].reason).toBe('Vitest needs Node 18 or newer; the project allows Node 16.0 (engines.node)');
    expect(s.suggestions[0].install).toBe('npm install -D jest@29 ts-jest@29 @types/jest@29');
    expect(s.suggestions[1].install).toBe('npm install -D mocha@10 ts-node@10');
    expect(JSON.parse(setupPlan(s.project, 'mocha').files[0].content)).toMatchObject({ require: ['ts-node/register'] });
  });

  test('Node 12: nothing is supported, and init-tests says why', async () => {
    const dir = project({ '.nvmrc': '12', 'package.json': {} });
    const s = suggest(dir);
    expect(s.status).toBe('unsupported');
    expect(s.reason).toMatch(/^no supported test framework runs on Node 12\.0 \(\.nvmrc\): /);
    const r = await run(['init-tests', dir, '--language', 'javascript', '--runner', 'jest', '--yes']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Jest 29 needs Node 14 or newer');
  });

  test('a framework the project\'s Node cannot run is refused by init-tests', async () => {
    const r = await run(['init-tests', project({ '.nvmrc': '16', 'package.json': {} }), '--language', 'javascript', '--runner', 'vitest', '--yes', '--no-install']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Vitest needs Node 18 or newer');
  });
});
