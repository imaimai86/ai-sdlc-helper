import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPackage, shellQuote, type Json } from '../util.js';

/**
 * The Node version a project asks for. A pin (.nvmrc, .node-version, .tool-versions, package.json volta.node) names the
 * version to run; a range (engines.node) only has to be met. `lowest` is the lowest version the project allows, used to
 * suggest only test frameworks that run on every version it supports.
 */
export interface ProjectNode {
  kind: 'pin' | 'range';
  /** As written: "16", "16.20.2", ">=16 <21". */
  spec: string;
  source: string;
  lowest: [number, number];
}

const firstVersion = (s: unknown): [number, number] | null => {
  const m = String(s ?? '').match(/(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0)] : null;
};

/** The Node version the project at <dir> asks for, or null when it says nothing. */
export function projectNode(dir: string, pkg: Json | null = readPackage(dir)): ProjectNode | null {
  const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { return null; } };
  for (const f of ['.nvmrc', '.node-version']) {
    const text = read(f);
    const v = text && !/^lts\//i.test(text) ? firstVersion(text) : null;
    if (text && v) return { kind: 'pin', spec: text.replace(/^v/, ''), source: f, lowest: v };
  }
  const tools = read('.tool-versions');
  const asdf = tools && tools.match(/^nodejs\s+(\S+)/m);
  if (asdf && firstVersion(asdf[1])) return { kind: 'pin', spec: asdf[1], source: '.tool-versions', lowest: firstVersion(asdf[1])! };
  const volta = pkg && pkg.volta && pkg.volta.node;
  if (volta && firstVersion(volta)) return { kind: 'pin', spec: String(volta), source: 'package.json volta.node', lowest: firstVersion(volta)! };
  const engines = pkg && pkg.engines && pkg.engines.node;
  if (engines && firstVersion(engines)) return { kind: 'range', spec: String(engines), source: 'engines.node', lowest: firstVersion(engines)! };
  return null;
}

/**
 * Whether Node <major> meets a simple range: `X`, `X.x`, `^X`, `~X`, `>=X`, `>X`, `<X`, `<=X`, space-joined (and) and
 * `||`-joined (or). Unknown forms count as met.
 */
export function satisfiesMajor(range: string, major: number): boolean {
  return range.split('||').some(alt => alt.trim().split(/\s+/).filter(Boolean).every(part => {
    const m = part.match(/^(>=|<=|>|<|\^|~|=)?v?(\d+)(?:\.(\d+|x|\*))?/);
    if (!m) return true;
    const [, op = '', n] = m;
    const v = Number(n);
    if (op === '>=') return major >= v;
    if (op === '>') return major > v;
    if (op === '<') return major < v;
    if (op === '<=') return major <= v;
    return major === v; // X, X.x, ^X, ~X, =X
  }));
}

export const NODE_MANAGERS = ['fnm', 'volta', 'nvm', 'npx'] as const;
export type NodeManager = typeof NODE_MANAGERS[number];

const onPath = (cmd: string, env: NodeJS.ProcessEnv) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8', env }).status === 0;
const nvmScript = (env: NodeJS.ProcessEnv) => path.join(env.NVM_DIR || path.join(env.HOME || '', '.nvm'), 'nvm.sh');

/** Whether a Node version manager can be used here. */
export function managerAvailable(m: NodeManager, env: NodeJS.ProcessEnv = process.env): boolean {
  if (m === 'nvm') return fs.existsSync(nvmScript(env));
  return onPath(m, env);
}

/** <cmd> run with Node <version> through <manager>. */
export function wrapCommand(cmd: string, version: string, manager: NodeManager): string {
  const inner = `sh -c ${shellQuote(cmd)}`;
  if (manager === 'fnm') return `fnm exec --using=${version} -- ${inner}`;
  if (manager === 'volta') return `volta run --node ${version} -- ${inner}`;
  if (manager === 'nvm') return `bash -c ${shellQuote(`. "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm exec --silent ${version} ${inner}`)}`;
  return `npx -y -p node@${version} -- ${inner}`;
}

/** The `node` setting in sdlc.config.json. */
export interface NodeSetting {
  /** "auto" (what the project asks for), "current" (the Node running the tool) or a version ("16", "18.20"). */
  version?: string;
  /** "auto" (the first available of fnm, volta, nvm, npx), one of them, or "none" (never switch). */
  manager?: string;
}

/** How the project's commands are run: with the current Node, or switched to another one. */
export interface NodeRun {
  /** The Node running the tool. */
  current: string;
  /** What the project asks for, if anything. */
  wanted: ProjectNode | null;
  /** The version commands switch to, or null when the current Node is used. */
  switchTo: string | null;
  manager: NodeManager | null;
  warning: string | null;
}

/** How to run the project's commands, from its `node` setting and what it asks for. */
export function nodeRun(root: string, setting: NodeSetting = {}, env: NodeJS.ProcessEnv = process.env, current = process.versions.node): NodeRun {
  const major = Number(current.split('.')[0]);
  const version = setting.version || 'auto';
  const wanted = version === 'auto' ? projectNode(root) : null;
  const base: NodeRun = { current, wanted, switchTo: null, manager: null, warning: null };
  if (version === 'current') return base;
  let target: string | null = null;
  if (version !== 'auto') target = version;
  else if (wanted && wanted.kind === 'pin' && firstVersion(wanted.spec)?.[0] !== major) target = wanted.spec;
  else if (wanted && wanted.kind === 'range' && !satisfiesMajor(wanted.spec, major)) target = String(wanted.lowest[0]);
  if (!target || firstVersion(target)?.[0] === major) return base;
  const asked = setting.manager || 'auto';
  const candidates = asked === 'auto' ? [...NODE_MANAGERS] : (NODE_MANAGERS as readonly string[]).includes(asked) ? [asked as NodeManager] : [];
  const manager = asked === 'none' ? undefined : candidates.find(m => managerAvailable(m, env));
  const from = wanted ? `${wanted.source} asks for ${wanted.spec}` : `node.version is ${target}`;
  if (!manager) {
    return { ...base, warning: `${from} but the tool runs on Node ${current}, and ${asked === 'none' ? 'node.manager is "none"' : `no Node version manager was found (${candidates.join(', ') || asked})`}; tests run with Node ${current}. Install fnm, Volta or nvm, or set "node": { "version": "current" }.` };
  }
  return { ...base, switchTo: target, manager };
}
