import fs from 'node:fs';
import path from 'node:path';
import { globToRegex } from '../config/globs.js';
import { posix, type RunSuite } from './types.js';

/** A suite's test files, from the project root, found by its testGlobs (node_modules and dot folders skipped). */
export function suiteFiles(root: string, suite: Pick<RunSuite, 'dir' | 'testGlobs'>): string[] {
  const base = path.join(root, suite.dir);
  const res = suite.testGlobs.map(g => new RegExp(globToRegex(g.replace(/^\.\//, ''))));
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (res.some(r => r.test(posix(path.relative(base, p))))) out.push(posix(path.relative(root, p)));
    }
  };
  walk(base);
  return out.sort();
}
