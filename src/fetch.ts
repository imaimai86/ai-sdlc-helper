// GET-only web reads for the stage agents. A `curl` allow rule cannot be limited to GET (-d, -X, -F and -T send data, -o
// writes files), so agents may run `ai-sdlc-helper fetch <https-url>` instead and never curl, wget or node: one https GET
// to a host on the list, the body printed, nothing sent and nothing written.

/** The hosts `fetch` reads from unless SDLC_FETCH_HOSTS names others: package registries, CDNs and GitHub. */
export const FETCH_HOSTS = ['registry.npmjs.org', 'unpkg.com', 'cdn.jsdelivr.net', 'raw.githubusercontent.com', 'github.com', 'api.github.com'];

export const FETCH_LIMITS = { maxBytes: 5_000_000, timeoutMs: 30_000, maxRedirects: 5 };

/** SDLC_FETCH_HOSTS (space-separated) replaces the default list. */
export function fetchHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const set = (env.SDLC_FETCH_HOSTS || '').split(/\s+/).filter(Boolean);
  return set.length ? set : FETCH_HOSTS;
}

/** Why <url> may not be fetched, or null: only https://<host>/<path> without spaces, on a listed host (no port, no user). */
export function urlProblem(url: string, hosts: string[]): string | null {
  const m = /^https:\/\/([A-Za-z0-9.-]+)(\/\S*)?$/.exec(url);
  if (!m) return 'only https://<host>/<path> URLs';
  if (!hosts.includes(m[1])) return `host ${m[1]} is not allowed (SDLC_FETCH_HOSTS)`;
  return null;
}

export interface FetchOptions {
  env?: NodeJS.ProcessEnv;
  /** The HTTP client (default: the global fetch). Tests pass a stand-in. */
  fetch?: typeof fetch;
  limits?: Partial<typeof FETCH_LIMITS>;
}

/** What `fetch` came to: exit 0 with the body, 1 when the request failed, 2 when the URL is not allowed. */
export type FetchResult = { code: 0; body: string } | { code: 1 | 2; error: string };

/** The body of a response, read up to <max> bytes; null when it is larger. */
async function readBody(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One GET of <url> (https only, also after a redirect, at most 5 of them), with a 30 s limit and a 5 MB cap on the body.
 * A 4xx or 5xx answer is a failure, as with `curl -f`.
 */
export async function getUrl(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const env = opts.env || process.env;
  const limits = { ...FETCH_LIMITS, ...opts.limits };
  const doFetch = opts.fetch || globalThis.fetch;
  const problem = urlProblem(url, fetchHosts(env));
  if (problem) return { code: 2, error: `fetch: ${problem}` };
  const signal = AbortSignal.timeout(limits.timeoutMs);
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const res = await doFetch(current, { method: 'GET', redirect: 'manual', signal });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= limits.maxRedirects) return { code: 1, error: `fetch: more than ${limits.maxRedirects} redirects from ${url}` };
        const next = new URL(location, current);
        if (next.protocol !== 'https:') return { code: 1, error: `fetch: ${current} redirects to ${next.protocol}//, only https is followed` };
        current = next.href;
        continue;
      }
      if (!res.ok) return { code: 1, error: `fetch: HTTP ${res.status} from ${current}` };
      const body = await readBody(res, limits.maxBytes);
      if (body === null) return { code: 1, error: `fetch: ${current} is larger than ${limits.maxBytes} bytes` };
      return { code: 0, body };
    }
  } catch (e) {
    const timedOut = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
    return { code: 1, error: `fetch: ${timedOut ? `no answer from ${current} within ${limits.timeoutMs / 1000}s` : (e as Error).message}` };
  }
}
