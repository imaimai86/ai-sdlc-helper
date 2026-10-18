// The fetch command: a GET-only web read the stage agents may run without a prompt (see src/fetch.ts).
import { getUrl } from '../fetch.js';
import { parseArgs } from './args.js';
import type { Io } from './main.js';

export const FETCH_COMMANDS = ['fetch'];

export const FETCH_USAGE = `  fetch <https-url>                one GET request, the body printed. Only the npm registry, unpkg, jsDelivr and GitHub
                                   (SDLC_FETCH_HOSTS, space-separated, replaces the list); nothing is sent or written.
                                   Stage agents may run this where they may not run curl. Exit 2: URL not allowed`;

/** Runs `fetch` (<argv> starts with it): 0 the body was printed, 1 the request failed, 2 the URL is not allowed. */
export async function fetchCommand(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(argv);
  const [, url, ...extra] = a.positional;
  if (!url || extra.length) {
    io.err('usage: ai-sdlc-helper fetch <https-url>');
    return 2;
  }
  const r = await getUrl(url, { env: io.env || process.env, fetch: io.fetch });
  if (r.code !== 0) { io.err(r.error); return r.code; }
  io.out(r.body.replace(/\n$/, ''));
  return 0;
}
