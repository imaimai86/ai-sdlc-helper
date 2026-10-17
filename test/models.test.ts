import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, test } from 'vitest';
import { TEST_TIMEOUT_MS, userDir, modelsMain, parseModels, resolvePath } from '../src/models/index.js';
import { run as runCli, tmp } from './helpers.js';

const KEY = 'sk-test-secret-9876';
const GOOD = {
  providers: {
    gw: { endpoint: 'https://gw.example/api', api_key_env: 'GW_KEY', models: ['m1', 'm2'], effort: false },
  },
};

let dir;
let file;
// A new, empty registry location. Every test starts with one; a test that checks several cases calls it between them.
function fresh() {
  dir = tmp('sdlc-models-');
  file = path.join(dir, 'sub', 'models.json');
}
beforeEach(fresh);

// Never the real home or config folder: the registry is the file named in the environment, home a temp folder.
async function cli(args: string[], { env = {} }: { env?: NodeJS.ProcessEnv } = {}) {
  let stdout = '';
  let stderr = '';
  const status = await modelsMain(args, {
    env: { AI_SDLC_HELPER_MODELS_FILE: file, ...env }, home: dir, platform: 'linux',
    out: l => { stdout += `${l}\n`; }, err: l => { stderr += `${l}\n`; },
  });
  return { status, stdout, stderr };
}
function seed(data: unknown = GOOD, f = file) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const ADD = ['add', 'gw', '--endpoint', 'https://gw.example/api', '--key-env', 'GW_KEY', '--models', 'm1,m2'];
const withArgs = (over: Record<string, string>) => {
  const a = { endpoint: 'https://gw.example/api', 'key-env': 'GW_KEY', models: 'm1,m2', ...over };
  return ['add', over.name === undefined ? 'gw' : over.name, '--endpoint', a.endpoint, '--key-env', a['key-env'], '--models', a.models];
};

describe('where the registry lives', () => {
  const at = (env, platform, home = '/h') => resolvePath({ env, platform, home }, () => false).file;

  test('the file named in AI_SDLC_HELPER_MODELS_FILE or SDLC_MODELS_FILE, then XDG_CONFIG_HOME or APPDATA, then home', () => {
    // a named file wins on any platform; the new name before the old one
    for (const platform of ['linux', 'darwin', 'win32']) {
      expect(at({ SDLC_MODELS_FILE: '/x/y.json', XDG_CONFIG_HOME: '/xdg', APPDATA: 'C:\\A' }, platform)).toBe('/x/y.json');
      expect(at({ AI_SDLC_HELPER_MODELS_FILE: '/n.json', SDLC_MODELS_FILE: '/x/y.json' }, platform)).toBe('/n.json');
    }
    // XDG_CONFIG_HOME when not win32
    expect(at({ XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe('/xdg/ai-sdlc-helper/models.json');
    expect(at({ XDG_CONFIG_HOME: '/xdg' }, 'darwin')).toBe('/xdg/ai-sdlc-helper/models.json');
    // APPDATA on win32, also when XDG_CONFIG_HOME is set
    expect(at({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\h')).toBe('C:\\Users\\a\\AppData\\Roaming\\ai-sdlc-helper\\models.json');
    expect(at({ APPDATA: 'C:\\R', XDG_CONFIG_HOME: '/xdg' }, 'win32', 'C:\\h')).toBe('C:\\R\\ai-sdlc-helper\\models.json');
    // win32 without APPDATA falls back to home\AppData\Roaming, even with XDG_CONFIG_HOME
    expect(at({}, 'win32')).toBe('\\h\\AppData\\Roaming\\ai-sdlc-helper\\models.json');
    expect(at({ XDG_CONFIG_HOME: '/xdg' }, 'win32')).toBe('\\h\\AppData\\Roaming\\ai-sdlc-helper\\models.json');
    // nothing set gives home/.config; empty strings count as not set
    expect(at({}, 'linux')).toBe('/h/.config/ai-sdlc-helper/models.json');
    expect(at({ AI_SDLC_HELPER_MODELS_FILE: '', SDLC_MODELS_FILE: '', XDG_CONFIG_HOME: '' }, 'linux')).toBe('/h/.config/ai-sdlc-helper/models.json');
    expect(at({ APPDATA: '' }, 'win32')).toBe('\\h\\AppData\\Roaming\\ai-sdlc-helper\\models.json');
    expect(userDir({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', home: '/h' }, 'sdlc')).toBe('/xdg/sdlc');
  });

  test('the file the scripts used (sdlc/models.json) is read while the new one is missing; the first change writes the new one', async () => {
    const env = { XDG_CONFIG_HOME: path.join(dir, 'xdg') };
    const legacy = path.join(dir, 'xdg', 'sdlc', 'models.json');
    const next = path.join(dir, 'xdg', 'ai-sdlc-helper', 'models.json');
    seed(GOOD, legacy);
    const run = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const status = await modelsMain(args, { env, home: dir, platform: 'linux', out: l => { stdout += `${l}\n`; }, err: l => { stderr += `${l}\n`; } });
      return { status, stdout, stderr };
    };
    expect((await run(['path'])).stdout.trim()).toBe(next);
    expect((await run(['get', 'gw'])).stdout).toContain('models=m1,m2');
    expect(fs.existsSync(next)).toBe(false);

    expect((await run(['add-model', 'gw', 'm3'])).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(next, 'utf8')).providers.gw.models).toEqual(['m1', 'm2', 'm3']);
    expect(JSON.parse(fs.readFileSync(legacy, 'utf8')).providers.gw.models).toEqual(['m1', 'm2']);

    // from now on the new file is the one read
    fs.writeFileSync(legacy, '{ broken');
    expect((await run(['list'])).status).toBe(0);

    // a broken old file is reported by its path while it is the one read
    fresh();
    seed('{ nope', path.join(dir, 'xdg', 'sdlc', 'models.json'));
    const env2 = { XDG_CONFIG_HOME: path.join(dir, 'xdg') };
    let err = '';
    expect(await modelsMain(['list'], { env: env2, home: dir, platform: 'linux', out: () => {}, err: l => { err += l; } })).toBe(1);
    expect(err).toContain(path.join(dir, 'xdg', 'sdlc', 'models.json'));
  });

  test('TEST_TIMEOUT_MS is 10 seconds; parseModels trims and a blank text gives no models', () => {
    expect(TEST_TIMEOUT_MS).toBe(10000);
    expect(parseModels(' a , b,c ')).toEqual(['a', 'b', 'c']);
    expect(parseModels('   ')).toEqual([]);
  });

  test('path prints the path, exit 0, for a missing file and for a corrupt one, which it leaves', async () => {
    let r = await cli(['path']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(file);
    expect(fs.existsSync(file)).toBe(false);

    seed('{ nope');
    r = await cli(['path']);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ nope');
  });
});

describe('writing commands', () => {
  test('add creates folder and file, trims models, sets effort, and replaces every field of an existing provider', async () => {
    const r = await cli(ADD);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('added gw (2 models)');
    expect(read().providers.gw).toMatchObject({ endpoint: 'https://gw.example/api', api_key_env: 'GW_KEY', models: ['m1', 'm2'] });

    fresh();
    await cli(withArgs({ models: ' a , b ' }));
    expect(read().providers.gw.models).toEqual(['a', 'b']);

    fresh();
    await cli([...ADD, '--effort']);
    expect(read().providers.gw.effort).toBe(true);

    fresh();
    seed({ providers: { gw: { ...GOOD.providers.gw, effort: true }, other: { endpoint: 'https://o.example', api_key_env: 'O', models: ['x'] } } });
    const rep = await cli(['add', 'gw', '--endpoint', 'http://localhost:9', '--key-env', 'NEW_KEY', '--models', 'z']);
    expect(rep.status).toBe(0);
    const d = read();
    expect(d.providers.gw).toMatchObject({ endpoint: 'http://localhost:9', api_key_env: 'NEW_KEY', models: ['z'], effort: false });
    expect(d.providers.other.models).toEqual(['x']);
  });

  test('add without a required option exits 1, names it and writes nothing', async () => {
    for (const opt of ['--endpoint', '--key-env', '--models']) {
      const args = [...ADD];
      args.splice(args.indexOf(opt), 2);
      const r = await cli(args);
      expect([opt, r.status]).toEqual([opt, 1]);
      expect(r.stderr).toContain(opt.replace(/^--/, ''));
      expect(fs.existsSync(path.dirname(file))).toBe(false);
    }
  });

  test('add-model, remove-model and remove; unknown keys survive a rewrite', async () => {
    seed();
    let r = await cli(['add-model', 'gw', 'm3']);
    expect([r.status, r.stdout.trim()]).toEqual([0, 'added gw/m3']);
    expect(read().providers.gw.models).toEqual(['m1', 'm2', 'm3']);
    r = await cli(['remove-model', 'gw', 'm1']);
    expect([r.status, r.stdout.trim()]).toEqual([0, 'removed gw/m1']);
    expect(read().providers.gw.models).toEqual(['m2', 'm3']);
    r = await cli(['remove', 'gw']);
    expect([r.status, r.stdout.trim()]).toEqual([0, 'removed gw']);
    expect(read().providers).toEqual({});

    fresh();
    seed({ extra: { a: 1 }, providers: { gw: { ...GOOD.providers.gw, note: 'keep' } } });
    expect((await cli(['add-model', 'gw', 'm3'])).status).toBe(0);
    const d = read();
    expect(d.extra).toEqual({ a: 1 });
    expect(d.providers.gw.note).toBe('keep');
    expect((await cli(ADD)).status).toBe(0);
    expect(read().extra).toEqual({ a: 1 });
    expect(read().providers.gw.note).toBe('keep');
  });
});

describe('reading commands', () => {
  test('list --json is one line with key_set and a boolean effort; no file prints {"providers":{}} and creates nothing', async () => {
    let r = await cli(['list', '--json']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"providers":{}}');
    expect(fs.existsSync(path.dirname(file))).toBe(false);

    seed({ providers: { gw: { endpoint: 'https://gw.example/api', api_key_env: 'GW_KEY', models: ['m1'] } } });
    r = await cli(['list', '--json'], { env: { GW_KEY: KEY } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ providers: { gw: { endpoint: 'https://gw.example/api', api_key_env: 'GW_KEY', models: ['m1'], effort: false, key_set: true } } });
  });

  test('list text format, effort suffix and key NOT set; an empty list prints no providers (<path>)', async () => {
    let r = await cli(['list']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`no providers (${file})`);

    seed({ providers: {
      gw: { endpoint: 'https://gw.example/api', api_key_env: 'GW_KEY', models: ['m1', 'm2'], effort: true },
      lo: { endpoint: 'http://localhost:1', api_key_env: 'LO_KEY', models: ['a'] },
    } });
    r = await cli(['list'], { env: { GW_KEY: KEY } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      'gw  https://gw.example/api  GW_KEY (key set)  m1,m2  effort',
      'lo  http://localhost:1  LO_KEY (key NOT set)  a',
    ]);
  });

  test('get prints the four lines in order; an unknown provider, no file or a prototype name exits 1', async () => {
    let r = await cli(['get', 'nope']);
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("unknown provider 'nope'");

    seed({ providers: { gw: { ...GOOD.providers.gw, effort: true } } });
    r = await cli(['get', 'gw']);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd().split('\n')).toEqual(['endpoint=https://gw.example/api', 'api_key_env=GW_KEY', 'models=m1,m2', 'effort=true']);

    // effort absent prints effort=false
    seed({ providers: { gw: { endpoint: 'https://e.example', api_key_env: 'K', models: ['m'] } } });
    expect((await cli(['get', 'gw'])).stdout.trimEnd().split('\n')[3]).toBe('effort=false');

    seed();
    for (const n of ['nope', 'constructor', 'toString']) {
      r = await cli(['get', n]);
      expect(r.status).toBe(1);
      expect(r.stderr.trim()).toBe(`unknown provider '${n}'`);
    }
  });
});

describe('validation', () => {
  const bytes = () => (fs.existsSync(file) ? fs.readFileSync(file) : null);
  async function rejects(args: string[], mention?: RegExp) {
    const before = bytes();
    const r = await cli(args);
    expect([args, r.status]).toEqual([args, 1]);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    if (mention) expect(r.stderr).toMatch(mention);
    const after = bytes();
    if (before === null) {
      expect(after).toBeNull();
      expect(fs.existsSync(path.dirname(file))).toBe(false);
    } else {
      expect(after!.equals(before)).toBe(true);
    }
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  }
  async function accepts(over: Record<string, string>) {
    fresh();
    expect([over, (await cli(withArgs(over))).status]).toEqual([over, 0]);
  }

  test('provider name, endpoint and api_key_env rules', async () => {
    for (const name of ['Gw', '-gw', 'g_w', 'g w', 'gw.x', 'anthropic']) await rejects(withArgs({ name }), /name|anthropic/i);
    for (const endpoint of ['/relative', 'gw.example/api', 'ftp://gw.example', 'file:///etc/passwd', 'http://gw.example', 'http://10.0.0.1',
      'http://localhost.evil.com', 'https://user:pw@gw.example', 'https://gw.example/a b']) {
      await rejects(withArgs({ endpoint }), /endpoint/);
    }
    for (const v of ['gw_key', '1KEY', 'MY-KEY', 'MY KEY', 'K$']) await rejects(withArgs({ 'key-env': v }), /api_key_env/);

    for (const name of ['a', '0a', 'a-b-1']) await accepts({ name });
    for (const endpoint of ['http://localhost', 'http://localhost:4000/x', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'https://anything.example', 'https://10.0.0.1']) {
      await accepts({ endpoint });
    }
    for (const v of ['_KEY', 'A1_B2', 'K']) await accepts({ 'key-env': v });
  });

  test('model rules: no space, bad character, empty entry, empty list, duplicate or 51st model', async () => {
    const many = n => Array.from({ length: n }, (_, i) => `m${i}`).join(',');
    await rejects(withArgs({ models: 'ok,bad model' }), /model/);
    await rejects(withArgs({ models: 'ok,b@d' }), /model/);
    await rejects(withArgs({ models: 'a,,b' }), /model/);
    await rejects(withArgs({ models: '' }), /model/);
    await rejects(withArgs({ models: '  ' }), /model/);
    await rejects(withArgs({ models: many(51) }), /model|50/);
    await rejects(withArgs({ models: 'a,b,a' }), /duplicate|model/);

    await accepts({ models: many(50) });
    // . : / - _ are allowed
    await accepts({ models: 'openai/gpt-5,llama3:8b,v1.2_x' });
  });

  test('add-model, remove-model and remove reject an unknown provider or model, and the last model', async () => {
    seed();
    await rejects(['add-model', 'nope', 'm'], /nope/);
    await rejects(['remove-model', 'nope', 'm'], /nope/);
    await rejects(['remove', 'nope'], /nope/);
    await rejects(['add-model', 'gw', 'm1'], /m1/);
    await rejects(['add-model', 'gw', 'bad model'], /model/);
    await rejects(['remove-model', 'gw', 'zzz'], /zzz/);

    seed({ providers: { gw: { ...GOOD.providers.gw, models: Array.from({ length: 50 }, (_, i) => `m${i}`) } } });
    await rejects(['add-model', 'gw', 'extra'], /50|model/);

    // the message points to the remove command
    seed({ providers: { gw: { ...GOOD.providers.gw, models: ['only'] } } });
    await rejects(['remove-model', 'gw', 'only'], /ai-sdlc-helper model remove gw/);
    expect(read().providers.gw.models).toEqual(['only']);
  });

  test('usage errors exit 1: unknown command, unknown option, missing argument', async () => {
    expect((await cli(['bogus'])).status).toBe(1);
    expect((await cli([])).status).toBe(1);
    seed();
    expect((await cli(['list', '--bogus'])).status).toBe(1);
    expect((await cli(['get'])).status).toBe(1);
    expect((await cli(['add-model', 'gw'])).status).toBe(1);
    expect((await cli([...ADD, '--bogus'])).status).toBe(1);
    expect((await cli(['get', 'gw', '--json'])).status).toBe(1);
    expect((await cli(['add', 'gw', '--endpoint'])).stderr).toContain('missing value for --endpoint');
  });
});

describe('file integrity', () => {
  test('no .tmp after success or rejection', async () => {
    await cli(ADD);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['models.json']);
    await cli(withArgs({ name: 'Bad' }));
    await cli(['remove-model', 'gw', 'nope']);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['models.json']);
  });

  const ALL = [
    ['list'], ['list --json', 'list', '--json'], ['add', ...ADD], ['add-model', 'add-model', 'gw', 'x'],
    ['remove-model', 'remove-model', 'gw', 'm1'], ['remove', 'remove', 'gw'], ['get', 'get', 'gw'], ['test', 'test', 'gw/m1'],
  ].map(([label, ...args]) => [label, args.length ? args : [label]] as [string, string[]]);
  const broken = {
    'invalid JSON': '{ not json',
    'no providers object': JSON.stringify({ models: [] }),
    'providers is an array': JSON.stringify({ providers: [] }),
    'models not an array': JSON.stringify({ providers: { gw: { ...GOOD.providers.gw, models: 'm1' } } }),
    'endpoint not a string': JSON.stringify({ providers: { gw: { ...GOOD.providers.gw, endpoint: 5 } } }),
    'effort not a boolean': JSON.stringify({ providers: { gw: { ...GOOD.providers.gw, effort: 'yes' } } }),
    'http endpoint on a remote host': JSON.stringify({ providers: { gw: { ...GOOD.providers.gw, endpoint: 'http://gw.example' } } }),
    'provider name anthropic': JSON.stringify({ providers: { anthropic: GOOD.providers.gw } }),
    'duplicate models': JSON.stringify({ providers: { gw: { ...GOOD.providers.gw, models: ['a', 'a'] } } }),
  };
  // One test per broken file: every command must refuse it.
  test.each(Object.entries(broken))('%s: every command exits 1 naming the file and leaves it unchanged', async (_label, content) => {
    for (const [name, args] of ALL) {
      seed(content);
      const r = await cli(args, { env: { GW_KEY: KEY } });
      expect([name, r.status]).toEqual([name, 1]);
      expect(r.stderr).toContain(file);
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
      expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    }
  });

  test('the message names the provider and the rule', async () => {
    seed({ providers: { ok: { endpoint: 'https://a.example', api_key_env: 'K', models: ['m'] }, gw: { ...GOOD.providers.gw, endpoint: 'http://gw.example' } } });
    const r = await cli(['list']);
    expect(r.stderr).toContain('gw');
    expect(r.stderr).toMatch(/endpoint/);
  });
});

describe('key handling', () => {
  test('key_set is true only for a non-empty key in the environment, not one in a .env file of the working directory', async () => {
    const keySet = async (env, cwd?) => JSON.parse((await runCli(['model', 'list', '--json'], { AI_SDLC_HELPER_MODELS_FILE: file, ...env }, cwd)).stdout).providers.gw.key_set;
    seed();
    expect(await keySet({ GW_KEY: KEY })).toBe(true);
    expect(await keySet({})).toBe(false);
    expect(await keySet({ GW_KEY: '' })).toBe(false);

    fs.writeFileSync(path.join(dir, '.env'), `GW_KEY=${KEY}\n`);
    expect(await keySet({}, dir)).toBe(false);
  });

  test('the key value appears in no output of list, list --json, get and error paths', async () => {
    seed({ providers: { gw: { ...GOOD.providers.gw, effort: true } } });
    const env = { GW_KEY: KEY };
    const runs = [['list'], ['list', '--json'], ['get', 'gw'], ['get', 'nope'], ['test', 'nope/m'], ['test', 'gw/unlisted'], ['add-model', 'gw', 'm1'], ['path']];
    for (const a of runs) {
      const r = await cli(a, { env });
      expect(r.stdout + r.stderr).not.toContain(KEY);
    }
  });
});

/**
 * A stand-in for http.request that never opens a socket. <handler> gets each request and answers it with
 * reply(status, body), fail(code) or nothing at all.
 */
function fakeHttp(handler: (req: any, reply: (status: number, body?: string) => void, fail: (code: string) => void) => void) {
  const reqs: any[] = [];
  const request = (url: URL, options: any, onResponse: (res: any) => void) => {
    const req: any = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    req.end = (body = '') => {
      const seen = { method: options.method, url: url.pathname, href: url.href, headers: options.headers, body };
      reqs.push(seen);
      setImmediate(() => handler(seen,
        (status, text = '') => { const res: any = new PassThrough(); res.statusCode = status; onResponse(res); res.end(text); },
        code => req.emit('error', Object.assign(new Error(code), { code }))));
    };
    return req;
  };
  return { reqs, request: request as any };
}

describe('test command', () => {
  async function run(args: string[], { env = { GW_KEY: KEY }, timeoutMs, http }: { env?: NodeJS.ProcessEnv; timeoutMs?: number; http: ReturnType<typeof fakeHttp> }) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await modelsMain(args, {
      env: { AI_SDLC_HELPER_MODELS_FILE: file, ...env }, out: l => out.push(l), err: l => err.push(l), timeoutMs, home: dir, platform: 'linux', request: http.request,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  const ENDPOINT = 'http://127.0.0.1:4000';
  const seedServer = (endpoint = ENDPOINT, models = ['m1']) => seed({ providers: { gw: { endpoint, api_key_env: 'GW_KEY', models } } });

  test('a 2xx prints ok; the request is the documented one, whatever slashes the endpoint or the model has', async () => {
    seedServer();
    let http = fakeHttp((_q, reply) => reply(200, '{}'));
    let r = await run(['test', 'gw/m1'], { http });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('ok');
    expect(http.reqs).toHaveLength(1);
    const [q] = http.reqs;
    expect([q.method, q.href]).toEqual(['POST', `${ENDPOINT}/v1/messages`]);
    expect(q.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(q.headers['anthropic-version']).toBe('2023-06-01');
    expect(q.headers['content-length']).toBe(Buffer.byteLength(q.body));
    expect(JSON.parse(q.body)).toMatchObject({ model: 'm1', max_tokens: 1 });

    // a 2xx other than 200 is ok
    expect((await run(['test', 'gw/m1'], { http: fakeHttp((_q, reply) => reply(204)) })).code).toBe(0);

    // a model name containing a slash splits at the first slash
    seedServer(ENDPOINT, ['openai/gpt-5']);
    http = fakeHttp((_q, reply) => reply(200));
    r = await run(['test', 'gw/openai/gpt-5'], { http });
    expect(r.code).toBe(0);
    expect(JSON.parse(http.reqs[0].body).model).toBe('openai/gpt-5');

    // trailing slashes do not double up, and the stored value is unchanged
    seedServer(`${ENDPOINT}/base///`);
    http = fakeHttp((_q, reply) => reply(200));
    expect((await run(['test', 'gw/m1'], { http })).code).toBe(0);
    expect(http.reqs[0].href).toBe(`${ENDPOINT}/base/v1/messages`);
    expect(read().providers.gw.endpoint).toBe(`${ENDPOINT}/base///`);
  });

  test('a 401 or 500 prints HTTP <code> and at most 200 characters of the body on one line, never the key', async () => {
    seedServer();
    let r = await run(['test', 'gw/m1'], { http: fakeHttp((_q, reply) => reply(401, 'x'.repeat(500))) });
    expect(r.code).toBe(1);
    expect(`${r.out}${r.err}`.trim()).toBe(`HTTP 401: ${'x'.repeat(200)}`);

    r = await run(['test', 'gw/m1'], { http: fakeHttp((_q, reply) => reply(500, 'boom\r\nagain')) });
    expect(r.code).toBe(1);
    expect(`${r.out}${r.err}`.trim()).toBe('HTTP 500: boom again');

    r = await run(['test', 'gw/m1'], { http: fakeHttp((_q, reply) => reply(401, `bad token ${KEY}`)) });
    expect(r.code).toBe(1);
    expect(`${r.out}${r.err}`).not.toContain(KEY);
    expect(r.out).toBe('HTTP 401: bad token ***');
  });

  test('no answer within the timeout prints timeout after <n>s and drops the request; a refused connection prints connection failed: <code>', async () => {
    seedServer();
    const silent = fakeHttp(() => {});
    let r = await run(['test', 'gw/m1'], { timeoutMs: 50, http: silent });
    expect(r.code).toBe(1);
    expect(`${r.out}${r.err}`.trim()).toBe('timeout after 0.05s');

    r = await run(['test', 'gw/m1'], { http: fakeHttp((_q, _reply, fail) => fail('ECONNREFUSED')) });
    expect(r.code).toBe(1);
    expect(`${r.out}${r.err}`.trim()).toBe('connection failed: ECONNREFUSED');

    // a key that cannot be a header value makes request() throw: reported, not left hanging
    const throwing = { reqs: [], request: () => { throw Object.assign(new TypeError('Invalid character in header content'), { code: 'ERR_INVALID_CHAR' }); } };
    r = await run(['test', 'gw/m1'], { http: throwing as any });
    expect(`${r.out}${r.err}`.trim()).toBe('connection failed: ERR_INVALID_CHAR');
  });

  test('unknown provider, unlisted model, missing file, key unset: exit 1, nothing sent', async () => {
    const http = fakeHttp((_q, reply) => reply(200));
    // a missing file is an unknown provider
    let r = await run(['test', 'gw/m1'], { http });
    expect(r.code).toBe(1);
    expect(r.err).toContain('gw');

    seedServer();
    r = await run(['test', 'nope/m1'], { http });
    expect([r.code, r.err]).toEqual([1, expect.stringContaining('nope')]);
    r = await run(['test', 'gw/zzz'], { http });
    expect([r.code, r.err]).toEqual([1, expect.stringContaining('zzz')]);
    r = await run(['test', 'gw/m1'], { env: {}, http });
    expect([r.code, r.err]).toEqual([1, expect.stringContaining('GW_KEY')]);
    r = await run(['test', 'gw/m1'], { env: { GW_KEY: '' }, http });
    expect([r.code, r.err]).toEqual([1, expect.stringContaining('GW_KEY')]);
    r = await run(['test', 'gwm1'], { http });
    expect([r.code, r.err]).toEqual([1, 'test: expected <provider>/<model>']);
    expect(http.reqs).toHaveLength(0);
  });
});

describe('ai-sdlc-helper model', () => {
  test('runs the registry commands, with their options, through the main command line', async () => {
    const env = { AI_SDLC_HELPER_MODELS_FILE: file };
    let r = await runCli(['model', 'add', 'gw', '--endpoint', 'https://gw.example/api', '--key-env', 'GW_KEY', '--models', 'm1', '--effort'], env);
    expect([r.status, r.stdout.trim()]).toEqual([0, 'added gw (1 models)']);
    expect(read().providers.gw.effort).toBe(true);
    r = await runCli(['model', 'list'], env);
    expect(r.stdout.trim()).toBe('gw  https://gw.example/api  GW_KEY (key NOT set)  m1  effort');
    r = await runCli(['model', 'remove', 'nope'], env);
    expect([r.status, r.stderr.trim()]).toEqual([1, "unknown provider 'nope'"]);
    r = await runCli(['model'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown command');
  });
});
