/** A glob (`**`, `*`, `?`, `[..]`, `{a,b}`, `?(a|b)`, `+(..)`, `*(..)`, `@(..)`) as an anchored regular expression source. */
export function globToRegex(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const ext = /[?+*@!]/.test(c) && glob[i + 1] === '(';
    if (ext) {
      let depth = 0;
      let j = i + 1;
      for (; j < glob.length; j++) {
        if (glob[j] === '(') depth++;
        else if (glob[j] === ')' && --depth === 0) break;
      }
      const body = glob.slice(i + 2, j).split('|').map(globToRegex).map(r => r.slice(1, -1)).join('|');
      re += c === '!' ? '[^/]*' : `(?:${body})${({ '?': '?', '+': '+', '*': '*', '@': '' } as Record<string, string>)[c]}`;
      i = j;
    } else if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = glob.indexOf(']', i);
      re += j > i ? glob.slice(i, j + 1) : '\\[';
      i = j > i ? j : i;
    } else if (c === '{') {
      const j = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, j).split(',').map(globToRegex).map(r => r.slice(1, -1)).join('|')})`;
      i = j;
    } else re += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
  }
  return `^${re}$`;
}

/**
 * A glob as globs git understands (`:(glob)` pathspecs know `**`, `*`, `?` and `[..]` only): `{a,b}` and the extglobs
 * `?(..)`, `@(..)`, `+(..)`, `*(..)` are expanded into their alternatives (`+` and `*` as one occurrence, `?` and `*`
 * also as none). At most 64 globs.
 */
export function expandGlob(glob: string): string[] {
  const m = glob.match(/([?@+*])\(([^()]*)\)|\{([^{}]*)\}/);
  if (!m || m.index === undefined) return [glob];
  const [whole, kind, ext, brace] = m;
  const alts = brace !== undefined ? brace.split(',') : ext.split('|');
  const options = kind === '?' || kind === '*' ? ['', ...alts] : alts;
  const start = m.index;
  const out = [...new Set(options.flatMap(o => expandGlob(glob.slice(0, start) + o + glob.slice(start + whole.length))))];
  return out.slice(0, 64);
}
