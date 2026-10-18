import { describe, expect, test } from 'vitest';
import { main } from '../src/cli/main.js';
import { READ_ONLY_RULES } from '../src/config/settings.js';
import { FETCH_HOSTS, fetchHosts, getUrl, urlProblem } from '../src/fetch.js';

type Answer = Response | Error | ((init: RequestInit | undefined) => Promise<Response>);

/** A stand-in for the global fetch: answers in turn and records each request. */
function standIn(...answers: Answer[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const a = answers.shift();
    if (a === undefined) throw new Error('unexpected request');
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(init) : a;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

async function cli(args: string[], fetchFn: typeof fetch, env: NodeJS.ProcessEnv = {}) {
  let stdout = '';
  let stderr = '';
  const status = await main(['fetch', ...args], { out: t => { stdout += `${t}\n`; }, err: t => { stderr += `${t}\n`; }, env, fetch: fetchFn });
  return { status, stdout, stderr };
}

describe('fetch', () => {
  test('one GET of an allowed https URL, the body printed, nothing sent and no redirect followed by the client itself', async () => {
    const url = 'https://unpkg.com/@google-cloud/pino-logging-gcp-config@1.3.6/build/src/pino_gcp_config.d.ts';
    const s = standIn(new Response('export declare function createGcpLoggingPinoConfig(): object;\n'));
    const r = await cli([url], s.fetch);
    expect(r).toEqual({ status: 0, stdout: 'export declare function createGcpLoggingPinoConfig(): object;\n', stderr: '' });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe(url);
    expect(s.calls[0].init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(s.calls[0].init).not.toHaveProperty('body');
    expect(s.calls[0].init).not.toHaveProperty('headers');
  });

  test('refuses other hosts, plain http, other schemes, a port, a user, a lookalike host and a space, with exit 2 and no request', async () => {
    for (const url of [
      'https://example.com/x', 'http://unpkg.com/x', 'file:///etc/passwd', 'https://unpkg.com:8443/x',
      'https://user@unpkg.com/x', 'https://unpkg.com.evil.test/x', 'https://unpkg.com/a b', 'unpkg.com/x',
    ]) {
      const s = standIn(new Response('never'));
      const r = await cli([url], s.fetch);
      expect([url, r.status, s.calls.length]).toEqual([url, 2, 0]);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^fetch: (only https|host )/);
    }
  });

  test('takes exactly one URL: a missing one, an extra one and a curl-style option all exit 2 without a request', async () => {
    for (const args of [[], ['https://unpkg.com/x', 'https://unpkg.com/y'], ['https://unpkg.com/x', '-d', '@.env'], ['-d', '@.env', 'https://unpkg.com/x']]) {
      const s = standIn(new Response('never'));
      const r = await cli(args, s.fetch);
      expect([args, r.status, s.calls.length]).toEqual([args, 2, 0]);
    }
  });

  test('SDLC_FETCH_HOSTS replaces the host list', async () => {
    expect(fetchHosts({})).toEqual(FETCH_HOSTS);
    expect(fetchHosts({ SDLC_FETCH_HOSTS: '  docs.example.org   cdn.example.org ' })).toEqual(['docs.example.org', 'cdn.example.org']);
    expect((await cli(['https://docs.example.org/api'], standIn(new Response('ok')).fetch, { SDLC_FETCH_HOSTS: 'docs.example.org' })).status).toBe(0);
    expect((await cli(['https://unpkg.com/x'], standIn(new Response('ok')).fetch, { SDLC_FETCH_HOSTS: 'docs.example.org' })).status).toBe(2);
    expect(urlProblem('https://unpkg.com/x', FETCH_HOSTS)).toBeNull();
    expect(urlProblem('https://registry.npmjs.org/pino/latest', FETCH_HOSTS)).toBeNull();
  });

  test('follows up to 5 https redirects (also a relative one), and fails on a redirect to http or on a sixth', async () => {
    const hop = standIn(redirect('/b'), redirect('https://cdn.jsdelivr.net/c'), new Response('end'));
    const r = await cli(['https://unpkg.com/a'], hop.fetch);
    expect([r.status, r.stdout]).toEqual([0, 'end\n']);
    expect(hop.calls.map(c => c.url)).toEqual(['https://unpkg.com/a', 'https://unpkg.com/b', 'https://cdn.jsdelivr.net/c']);

    const down = await cli(['https://unpkg.com/a'], standIn(redirect('http://unpkg.com/b')).fetch);
    expect(down.status).toBe(1);
    expect(down.stderr).toContain('only https is followed');

    const loop = standIn(...Array.from({ length: 6 }, (_, i) => redirect(`/r${i}`)));
    const r6 = await cli(['https://unpkg.com/a'], loop.fetch);
    expect(r6.status).toBe(1);
    expect(r6.stderr).toContain('more than 5 redirects');
    expect(loop.calls).toHaveLength(6);
  });

  test('an HTTP error answer and a network error are failures (exit 1) that say why', async () => {
    const missing = await cli(['https://unpkg.com/nope'], standIn(new Response('Not found', { status: 404 })).fetch);
    expect([missing.status, missing.stdout, missing.stderr]).toEqual([1, '', 'fetch: HTTP 404 from https://unpkg.com/nope\n']);
    const down = await cli(['https://unpkg.com/x'], standIn(new Error('getaddrinfo ENOTFOUND unpkg.com')).fetch);
    expect([down.status, down.stderr]).toEqual([1, 'fetch: getaddrinfo ENOTFOUND unpkg.com\n']);
  });
});

describe('getUrl limits', () => {
  test('a body over the size cap fails, whether the length is declared or only found while reading', async () => {
    const declared = await getUrl('https://unpkg.com/big', { limits: { maxBytes: 10 }, fetch: standIn(new Response('x', { headers: { 'content-length': '11' } })).fetch });
    expect(declared).toEqual({ code: 1, error: 'fetch: https://unpkg.com/big is larger than 10 bytes' });
    const streamed = await getUrl('https://unpkg.com/big', { limits: { maxBytes: 10 }, fetch: standIn(new Response('x'.repeat(11))).fetch });
    expect(streamed).toMatchObject({ code: 1 });
    const exact = await getUrl('https://unpkg.com/ok', { limits: { maxBytes: 10 }, fetch: standIn(new Response('x'.repeat(10))).fetch });
    expect(exact).toEqual({ code: 0, body: 'x'.repeat(10) });
  });

  test('a server that does not answer in time fails with the time limit named', async () => {
    const hang = standIn(init => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
    }));
    const r = await getUrl('https://unpkg.com/slow', { limits: { timeoutMs: 20 }, fetch: hang.fetch });
    expect(r).toMatchObject({ code: 1 });
    expect((r as { error: string }).error).toContain('no answer from https://unpkg.com/slow within 0.02s');
  });
});

describe('what agents may run', () => {
  test('the read-only rules hold nothing that can send data, write a file or run code', () => {
    const heads = READ_ONLY_RULES.map(r => /^Bash\(([^:)]+)/.exec(r)![1].split(' ')[0]);
    for (const banned of ['curl', 'wget', 'node', 'python', 'python3', 'sed', 'awk', 'find', 'sh', 'bash', 'npm install', 'git push']) {
      expect(heads, banned).not.toContain(banned);
    }
    expect(READ_ONLY_RULES).not.toContain('Bash(npm:*)');
  });
});
