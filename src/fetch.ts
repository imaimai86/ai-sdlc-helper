// `ai-sdlc-helper fetch <https-url>`: one GET request, the body printed to stdout. Stage agents may run this without a
// prompt; they may not run curl, because a curl rule cannot be limited to GET (-d, -X, -F and -T send data, -o writes files).
import https from 'node:https';

/** The hosts agents may read from: the npm registry, unpkg, jsDelivr and GitHub. */
export const DEFAULT_FETCH_HOSTS = ['registry.npmjs.org', 'unpkg.com', 'cdn.jsdelivr.net', 'raw.githubusercontent.com', 'github.com', 'api.github.com'];
export const FETCH_LIMITS = { maxRedirects: 5, timeoutMs: 30_000, maxBytes: 5_000_000 };

/** AI_SDLC_HELPER_FETCH_HOSTS (or the older SDLC_FETCH_HOSTS), space-separated; else the defaults. */
export function fetchHosts(env: NodeJS.ProcessEnv): string[] {
  const list = env.AI_SDLC_HELPER_FETCH_HOSTS ?? env.SDLC_FETCH_HOSTS;
  return list !== undefined && list.trim() ? list.trim().split(/\s+/) : DEFAULT_FETCH_HOSTS;
}

/** What is wrong with <url> for a fetch, or null: https only, a plain host name, an allowed host, no user:password. */
export function fetchProblem(url: string, hosts: string[]): string | null {
  if (!/^https:\/\/[A-Za-z0-9.-]+(\/\S*)?$/.test(url)) return 'only https://<host>/<path> URLs';
  const host = new URL(url).hostname;
  return hosts.includes(host) ? null : `host ${host} is not allowed (AI_SDLC_HELPER_FETCH_HOSTS)`;
}

/** One GET of <url>: resolves with its body. Redirects are followed (https only, at most 5). Tests pass their own request. */
export function fetchUrl(url: string, { request = https.request, limits = FETCH_LIMITS } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = (target: string, redirects: number) => {
      const req = request(target, { method: 'GET', headers: { 'user-agent': 'ai-sdlc-helper', accept: '*/*' }, timeout: limits.timeoutMs }, res => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          if (!next.startsWith('https://')) return reject(new Error(`redirect to a non-https URL: ${next}`));
          if (redirects >= limits.maxRedirects) return reject(new Error(`more than ${limits.maxRedirects} redirects`));
          return get(next, redirects + 1);
        }
        if (status < 200 || status >= 300) { res.resume(); return reject(new Error(`HTTP ${status} for ${target}`)); }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > limits.maxBytes) { req.destroy(); reject(new Error(`the response is larger than ${limits.maxBytes} bytes`)); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`no answer within ${limits.timeoutMs / 1000}s`)));
      req.on('error', reject);
      req.end();
    };
    get(url, 0);
  });
}
