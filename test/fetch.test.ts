import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { DEFAULT_FETCH_HOSTS, fetchHosts, fetchProblem, fetchUrl } from '../src/fetch.js';
import { run } from './helpers.js';

// A stand-in for https.request: answers each URL from <routes> ({ status, location?, body? }) and records the calls.
function fakeRequest(routes: Record<string, { status: number; location?: string; body?: string }>) {
  const calls: { url: string; method: string }[] = [];
  const request = ((url: string, opts: { method: string }, onRes: (res: any) => void) => {
    calls.push({ url, method: opts.method });
    const req: any = new EventEmitter();
    req.end = () => setImmediate(() => {
      const r = routes[url] || { status: 404 };
      const res: any = new EventEmitter();
      res.statusCode = r.status;
      res.headers = r.location ? { location: r.location } : {};
      res.resume = () => {};
      onRes(res);
      if (r.body !== undefined) res.emit('data', Buffer.from(r.body));
      res.emit('end');
    });
    req.destroy = (e?: Error) => { if (e) req.emit('error', e); };
    return req;
  }) as any;
  return { request, calls };
}

describe('fetch', () => {
  test('only https URLs to the allowed hosts; the hosts can be replaced', () => {
    expect(fetchHosts({})).toEqual(DEFAULT_FETCH_HOSTS);
    expect(fetchHosts({ AI_SDLC_HELPER_FETCH_HOSTS: 'a.example b.example' })).toEqual(['a.example', 'b.example']);
    expect(fetchHosts({ SDLC_FETCH_HOSTS: 'old.example' })).toEqual(['old.example']);
    expect(fetchProblem('https://registry.npmjs.org/pino/latest', DEFAULT_FETCH_HOSTS)).toBeNull();
    expect(fetchProblem('http://registry.npmjs.org/pino', DEFAULT_FETCH_HOSTS)).toBe('only https://<host>/<path> URLs');
    expect(fetchProblem('https://user:pw@unpkg.com/x', DEFAULT_FETCH_HOSTS)).toBe('only https://<host>/<path> URLs');
    expect(fetchProblem('https://evil.example/x', DEFAULT_FETCH_HOSTS)).toBe('host evil.example is not allowed (AI_SDLC_HELPER_FETCH_HOSTS)');
  });

  test('makes GET requests only, follows https redirects, and refuses a redirect to http', async () => {
    const f = fakeRequest({
      'https://unpkg.com/pino': { status: 302, location: '/pino@9.5.0/README.md' },
      'https://unpkg.com/pino@9.5.0/README.md': { status: 200, body: '# pino\n' },
      'https://unpkg.com/down': { status: 301, location: 'http://unpkg.com/x' },
    });
    expect(await fetchUrl('https://unpkg.com/pino', { request: f.request })).toBe('# pino\n');
    expect(f.calls).toEqual([{ url: 'https://unpkg.com/pino', method: 'GET' }, { url: 'https://unpkg.com/pino@9.5.0/README.md', method: 'GET' }]);
    await expect(fetchUrl('https://unpkg.com/down', { request: f.request })).rejects.toThrow('redirect to a non-https URL: http://unpkg.com/x');
    await expect(fetchUrl('https://unpkg.com/missing', { request: f.request })).rejects.toThrow('HTTP 404');
  });

  test('stops at too many redirects and at a body over the size limit', async () => {
    const loop = fakeRequest({ 'https://unpkg.com/a': { status: 302, location: 'https://unpkg.com/a' } });
    await expect(fetchUrl('https://unpkg.com/a', { request: loop.request })).rejects.toThrow('more than 5 redirects');
    const big = fakeRequest({ 'https://unpkg.com/big': { status: 200, body: 'x'.repeat(20) } });
    await expect(fetchUrl('https://unpkg.com/big', { request: big.request, limits: { maxRedirects: 5, timeoutMs: 1000, maxBytes: 10 } }))
      .rejects.toThrow('the response is larger than 10 bytes');
  });

  test('the command refuses a bad URL or host before any request, with exit 2', async () => {
    expect(await run(['fetch'])).toMatchObject({ status: 2, stderr: 'ERROR: usage: ai-sdlc-helper fetch <https-url>\n' });
    expect(await run(['fetch', 'https://evil.example/x'])).toMatchObject({ status: 2, stderr: 'ERROR: fetch: host evil.example is not allowed (AI_SDLC_HELPER_FETCH_HOSTS)\n' });
    expect(await run(['fetch', 'ftp://unpkg.com/x'])).toMatchObject({ status: 2 });
  });
});
