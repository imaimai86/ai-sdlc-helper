'use strict';
/* global require, process, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports */
// Entry point of the single executable (see scripts/build-sea.mjs and docs/RELEASING.md).
//
// Node's single executable applications run one CommonJS script, but ai-sdlc-helper is ES modules that read their
// prompts and skills from files (assets/). So the executable carries the package (dist/, assets/, package.json) as
// one SEA asset, writes it once to a cache folder, and loads dist/bin.js from there with require(), which loads
// ES modules from Node 22.12 on. Paths built from import.meta.url (ASSETS_DIR, package.json) then work unchanged.
//
// Outside an executable (for testing) the payload is read from the file named by AI_SDLC_HELPER_SEA_PAYLOAD.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

let sea = null;
try { sea = require('node:sea'); } catch { sea = null; }
const inSea = Boolean(sea && sea.isSea());

const text = inSea
  ? sea.getAsset('payload', 'utf8')
  : fs.readFileSync(process.env.AI_SDLC_HELPER_SEA_PAYLOAD || '', 'utf8');
const payload = JSON.parse(text);

const cacheRoot = () => {
  if (process.env.AI_SDLC_HELPER_SEA_CACHE) return process.env.AI_SDLC_HELPER_SEA_CACHE;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ai-sdlc-helper', 'Cache');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ai-sdlc-helper');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ai-sdlc-helper');
};

const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
const dir = path.join(cacheRoot(), `sea-${payload.version}-${hash}`);
const done = path.join(dir, '.complete');

if (!fs.existsSync(done)) {
  // Write to a private folder first, then rename, so two runs starting together never see half a package.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const tmp = fs.mkdtempSync(`${dir}.tmp-`);
  for (const [file, base64] of Object.entries(payload.files)) {
    const target = path.join(tmp, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  }
  fs.writeFileSync(path.join(tmp, '.complete'), `${payload.version}\n`);
  try {
    fs.renameSync(tmp, dir);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(done)) throw error;
  }
}

const bin = path.join(dir, 'dist', 'bin.js');
// The command starts itself again as [process.execPath, <dist/bin.js>, ...] (pipeline runs). For an executable,
// process.execPath is the executable, so that script path arrives as the first argument: drop it.
const args = process.argv.slice(2);
if (args.length && path.resolve(args[0]) === bin) args.shift();
process.argv = [process.argv[0], bin, ...args];

createRequire(bin)(bin);
