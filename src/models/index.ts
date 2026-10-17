// The user-level model registry (models.json): the only reader and writer of that file. It holds the NAME of the
// variable that carries each provider's key, never the key.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { has } from '../util.js';
import { configDir } from '../configDir.js';

export const TEST_TIMEOUT_MS = 10000;
const TEST_BODY_MAX = 65536;
const MAX_MODELS = 50;
export const MODELS_COMMANDS = ['path', 'list', 'get', 'add', 'add-model', 'remove-model', 'remove', 'test'];

export interface Provider { endpoint: string; api_key_env: string; models: string[]; effort?: boolean; [key: string]: unknown }
export interface Registry { providers: Record<string, Provider>; [key: string]: unknown }

class RegistryError extends Error {}
class UsageError extends Error {}

const set = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface Where { env: NodeJS.ProcessEnv; platform: NodeJS.Platform | string; home: string }

/**
 * A user-level folder <name>: $XDG_CONFIG_HOME/<name>, %APPDATA%\<name> on Windows, else ~/.config/<name>. Used for
 * the folder of the scripts before this package ("sdlc"); the tool's own folder is configDir().
 */
export function userDir({ env, platform, home }: Where, name: string): string {
  if (platform !== 'win32' && set(env.XDG_CONFIG_HOME)) return `${env.XDG_CONFIG_HOME}/${name}`;
  if (platform === 'win32' && set(env.APPDATA)) return path.win32.join(env.APPDATA, name);
  return `${home}/.config/${name}`;
}

/**
 * Where the registry is written (`file`) and read (`read`): AI_SDLC_HELPER_MODELS_FILE (or the older SDLC_MODELS_FILE)
 * names the file outright; otherwise models.json in the config folder. While that file does not exist, the one the
 * scripts used (`sdlc/models.json` in the same place) is read instead; the first change writes the new file.
 */
export function resolvePath(where: Where, fileExists: (f: string) => boolean = fs.existsSync): { file: string; read: string } {
  const named = [where.env.AI_SDLC_HELPER_MODELS_FILE, where.env.SDLC_MODELS_FILE].find(set);
  if (named) return { file: named, read: named };
  const join = (dir: string) => (where.platform === 'win32' ? path.win32.join(dir, 'models.json') : `${dir}/models.json`);
  const file = join(configDir({ ...where.env, HOME: where.home }, where.platform as NodeJS.Platform));
  const legacy = join(userDir(where, 'sdlc'));
  return { file, read: !fileExists(file) && fileExists(legacy) ? legacy : file };
}

// Whitespace and control characters are refused although URL() would strip them: get and list print the stored text
// as one line. A user:password part is refused because the file must hold no secret.
function validEndpoint(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(s)) return false;
  let u: URL;
  try { u = new URL(s); } catch { return false; }
  if (u.username !== '' || u.password !== '') return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/** null, or '<field>: <rule>' for the first rule <p> breaks. */
export function validateProvider(name: string, p: unknown): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return 'provider name: must match ^[a-z0-9][a-z0-9-]*$';
  if (name === 'anthropic') return "provider name: 'anthropic' is reserved";
  if (!isObject(p)) return 'provider: must be an object';
  if (typeof p.endpoint !== 'string') return 'endpoint: must be a string';
  if (typeof p.api_key_env !== 'string') return 'api_key_env: must be a string';
  if (!Array.isArray(p.models) || p.models.some(m => typeof m !== 'string')) return 'models: must be a list of strings';
  if (p.effort !== undefined && typeof p.effort !== 'boolean') return 'effort: must be true or false';
  if (!validEndpoint(p.endpoint)) return 'endpoint: must be https, or http to localhost, 127.0.0.1 or [::1]';
  if (!/^[A-Z_][A-Z0-9_]*$/.test(p.api_key_env)) return 'api_key_env: must match ^[A-Z_][A-Z0-9_]*$';
  if (p.models.length < 1) return 'models: at least 1 model';
  if (p.models.length > MAX_MODELS) return `models: at most ${MAX_MODELS} models`;
  for (const m of p.models) if (!/^[A-Za-z0-9._:/-]+$/.test(m)) return `models: '${m}' must match ^[A-Za-z0-9._:/-]+$`;
  const seen = new Set<string>();
  for (const m of p.models) {
    if (seen.has(m)) return `models: duplicate '${m}'`;
    seen.add(m);
  }
  return null;
}

export function validateRegistry(data: unknown): string | null {
  if (!isObject(data) || !isObject(data.providers)) return 'providers: must be an object';
  for (const [name, p] of Object.entries(data.providers)) {
    const msg = validateProvider(name, p);
    if (msg) return `provider '${name}': ${msg}`;
  }
  return null;
}

/** The registry in <file>; an empty one when the file does not exist. Throws when it is unreadable or invalid. */
export function loadRegistry(file: string): Registry {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { providers: {} };
    throw new RegistryError(`${file}: ${(e as Error).message}`);
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new RegistryError(`${file}: not valid JSON`); }
  const msg = validateRegistry(data);
  if (msg) throw new RegistryError(`${file}: ${msg}`);
  return data as Registry;
}

// The caller has already validated <data>.
function save(file: string, data: Registry): void {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

export function parseModels(text: string): string[] {
  if (text.trim() === '') return [];
  return text.split(',').map(s => s.trim());
}

const SPEC: Record<string, { pos: number; opts: Record<string, number>; flags: string[] }> = {
  path: { pos: 0, opts: {}, flags: [] },
  list: { pos: 0, opts: {}, flags: ['json'] },
  get: { pos: 1, opts: {}, flags: [] },
  add: { pos: 1, opts: { endpoint: 1, 'key-env': 1, models: 1 }, flags: ['effort'] },
  'add-model': { pos: 2, opts: {}, flags: [] },
  'remove-model': { pos: 2, opts: {}, flags: [] },
  remove: { pos: 1, opts: {}, flags: [] },
  test: { pos: 1, opts: {}, flags: [] },
};

function parseArgs(cmd: string, argv: string[]): { pos: string[]; opts: Record<string, string | true> } {
  const spec = SPEC[cmd];
  const pos: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (has(spec.opts, name)) {
        if (i + 1 >= argv.length) throw new UsageError(`missing value for ${a}`);
        opts[name] = argv[++i];
      } else if (spec.flags.includes(name)) {
        opts[name] = true;
      } else {
        throw new UsageError(`unknown option ${a}`);
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length !== spec.pos) throw new UsageError(`${cmd}: expected ${spec.pos} argument(s), got ${pos.length}`);
  return { pos, opts };
}

const keyValue = (env: NodeJS.ProcessEnv, name: string): string => (set(env[name]) ? env[name]! : '');

/** Sends one HTTP request: http.request's signature, so tests can pass a stand-in that never opens a socket. */
export type Request = (url: URL, options: http.RequestOptions, onResponse: (res: http.IncomingMessage) => void) => http.ClientRequest;
const nodeRequest: Request = (url, options, onResponse) => (url.protocol === 'https:' ? https : http).request(url, options, onResponse);

/** Asks <endpoint> for one token from <model>: { ok, line } with the key masked in the line. */
export function probe({ endpoint, model, key, timeoutMs, request = nodeRequest }: {
  endpoint: string; model: string; key: string; timeoutMs: number; request?: Request;
}): Promise<{ ok: boolean; line: string }> {
  return new Promise(resolve => {
    let finished = false;
    let req: http.ClientRequest | undefined;
    const finish = (ok: boolean, line: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok, line: line.split(key).join('***') });
    };
    const failed = (err: unknown) => finish(false, `connection failed: ${(err as NodeJS.ErrnoException)?.code || 'ERROR'}`);
    const timer = setTimeout(() => {
      finish(false, `timeout after ${timeoutMs / 1000}s`);
      if (req) req.destroy();
    }, timeoutMs);
    let url: URL;
    try {
      url = new URL(`${endpoint.replace(/\/+$/, '')}/v1/messages`);
    } catch {
      finish(false, 'connection failed: ERROR');
      return;
    }
    const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    // A key that cannot be a header value makes request() throw: report it instead of leaving the timer running.
    try {
      req = request(url, {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(body),
        },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { if (text.length < TEST_BODY_MAX) text += c; });
        res.on('error', failed);
        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) finish(true, 'ok');
          // The key is masked before the cut, so the cut can never leave part of an echoed key in the line.
          else finish(false, `HTTP ${status}: ${text.split(key).join('***').replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
        });
      });
    } catch (e) {
      failed(e);
      return;
    }
    req.on('error', failed);
    req.end(body);
  });
}

const unknownProvider = (p: string) => new RegistryError(`unknown provider '${p}'`);

function commit(file: string, data: Registry): void {
  const msg = validateRegistry(data);
  if (msg) throw new RegistryError(msg);
  save(file, data);
}

export interface ModelsIo {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  home?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  timeoutMs?: number;
  request?: Request;
}

/**
 * `ai-sdlc-helper model path | list [--json] | get <p> | add <p> --endpoint <url> --key-env <VAR> --models a,b [--effort]
 * | add-model <p> <m> | remove-model <p> <m> | remove <p> | test <p>/<m>`. Returns 0, or 1 on any error.
 */
export async function modelsMain(argv: string[], io: ModelsIo = {}): Promise<number> {
  const env = io.env || process.env;
  const platform = io.platform || process.platform;
  const home = io.home || os.homedir();
  const out = io.out || ((l: string) => { process.stdout.write(`${l}\n`); });
  const err = io.err || ((l: string) => { process.stderr.write(`${l}\n`); });
  const timeoutMs = io.timeoutMs || TEST_TIMEOUT_MS;
  try {
    const [cmd, ...rest] = argv;
    if (!cmd || !has(SPEC, cmd)) throw new UsageError(`unknown command '${cmd || ''}' (${MODELS_COMMANDS.join(', ')})`);
    const { pos, opts } = parseArgs(cmd, rest);
    const { file, read } = resolvePath({ env, platform, home });
    if (cmd === 'path') { out(file); return 0; }
    if (cmd === 'add') {
      for (const o of ['endpoint', 'key-env', 'models']) if (opts[o] === undefined) throw new UsageError(`missing --${o}`);
    }
    const data = loadRegistry(read);
    const providers = data.providers;
    const [p, m] = pos;
    const need = () => { if (!has(providers, p)) throw unknownProvider(p); return providers[p]; };

    switch (cmd) {
      case 'list': {
        const view: Record<string, { endpoint: string; api_key_env: string; models: string[]; effort: boolean; key_set: boolean }> = {};
        for (const [name, v] of Object.entries(providers)) {
          view[name] = { endpoint: v.endpoint, api_key_env: v.api_key_env, models: v.models, effort: v.effort === true, key_set: keyValue(env, v.api_key_env) !== '' };
        }
        if (opts.json) { out(JSON.stringify({ providers: view })); break; }
        const names = Object.keys(view);
        if (!names.length) { out(`no providers (${read})`); break; }
        for (const name of names) {
          const v = view[name];
          out(`${name}  ${v.endpoint}  ${v.api_key_env} (${v.key_set ? 'key set' : 'key NOT set'})  ${v.models.join(',')}${v.effort ? '  effort' : ''}`);
        }
        break;
      }
      case 'get': {
        const v = need();
        out(`endpoint=${v.endpoint}`);
        out(`api_key_env=${v.api_key_env}`);
        out(`models=${v.models.join(',')}`);
        out(`effort=${v.effort === true}`);
        break;
      }
      case 'add': {
        const existing = has(providers, p) ? providers[p] : {};
        providers[p] = {
          ...existing, endpoint: String(opts.endpoint), api_key_env: String(opts['key-env']), models: parseModels(String(opts.models)), effort: Boolean(opts.effort),
        };
        commit(file, data);
        out(`added ${p} (${providers[p].models.length} models)`);
        break;
      }
      case 'add-model': {
        const v = need();
        if (v.models.includes(m)) throw new RegistryError(`model '${m}' is already listed`);
        v.models.push(m);
        commit(file, data);
        out(`added ${p}/${m}`);
        break;
      }
      case 'remove-model': {
        const v = need();
        if (!v.models.includes(m)) throw new RegistryError(`model '${m}' is not listed`);
        if (v.models.length === 1) throw new RegistryError(`provider '${p}' would have no model left: use ai-sdlc-helper model remove ${p}`);
        v.models = v.models.filter(x => x !== m);
        commit(file, data);
        out(`removed ${p}/${m}`);
        break;
      }
      case 'remove': {
        need();
        delete providers[p];
        commit(file, data);
        out(`removed ${p}`);
        break;
      }
      case 'test': {
        const slash = p.indexOf('/');
        if (slash < 1) throw new UsageError('test: expected <provider>/<model>');
        const name = p.slice(0, slash);
        const model = p.slice(slash + 1);
        if (!has(providers, name)) throw unknownProvider(name);
        const v = providers[name];
        if (!v.models.includes(model)) throw new RegistryError(`model '${model}' is not listed for provider '${name}'`);
        const key = keyValue(env, v.api_key_env);
        if (key === '') throw new RegistryError(`key variable ${v.api_key_env} is not set`);
        const r = await probe({ endpoint: v.endpoint, model, key, timeoutMs, request: io.request });
        out(r.line);
        return r.ok ? 0 : 1;
      }
    }
    return 0;
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
}
