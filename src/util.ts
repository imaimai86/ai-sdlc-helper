import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The settings file at a project's root. */
export const CONFIG_FILE = 'sdlc.config.json';

/** The package's own files (prompts, skills): `assets/` next to `src/` and `dist/`. */
export const ASSETS_DIR = fileURLToPath(new URL('../assets', import.meta.url));

export type Json = Record<string, any>;

export const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
export const exists = (file: string): boolean => fs.existsSync(file);

/** <dir> as a path from <root> with forward slashes, "." for the root itself. */
export const rel = (root: string, dir: string): string => path.relative(root, dir).split(path.sep).join('/') || '.';

export const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** A word quoted for sh. */
export const shellQuote = (s: unknown): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A shell word, quoted only when it needs to be. */
export const shellWord = (s: string): string => (/^[\w./@:=-]+$/.test(s) ? s : shellQuote(s));

/** The project's package.json, or null. */
export function readPackage(dir: string): Json | null {
  try { return readJson(path.join(dir, 'package.json')); } catch { return null; }
}

/** The project's sdlc.config.json, or {} when it is missing or unreadable. */
export function readSettings(root: string): Json {
  try { return readJson(path.join(root, CONFIG_FILE)); } catch { return {}; }
}
