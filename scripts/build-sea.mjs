#!/usr/bin/env node
// Builds ai-sdlc-helper as a single executable with Node's single executable applications (SEA), for the platform
// and architecture of the Node running this script. Not part of the release workflow yet; see docs/RELEASING.md.
//
//   node scripts/build-sea.mjs [--out <dir>] [--no-build] [--blob-only] [--npx]
//
// Steps: build dist/, pack dist/ + assets/ + package.json into one JSON payload, write the SEA config with
// scripts/sea-bootstrap.cjs as the entry point and the payload as an asset, make the preparation blob
// (node --experimental-sea-config), copy the node binary and inject the blob with postject.
//
// postject is not a dependency. The script uses `postject` from PATH or node_modules/.bin, or, with --npx, runs
// `npx --yes postject@1.0.0-alpha.6`. Without either it stops after the blob and prints the remaining commands.
// Needs Node 22.12 or newer: the bootstrap loads the ES module entry point with require().
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const out = path.resolve(root, option('--out') ?? path.join('build', 'sea'));
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const log = text => process.stdout.write(`${text}\n`);
const run = (cmd, args, opts = {}) => { log(`$ ${[cmd, ...args].join(' ')}`); execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts }); };

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(`ERROR: Node ${process.versions.node}: the single executable needs Node 22.12 or newer.\n`);
  process.exit(1);
}

if (!flag('--no-build')) run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { shell: process.platform === 'win32' });

// 1. The payload: every file the npm package ships, as base64.
const files = {};
const add = rel => {
  const abs = path.join(root, rel);
  if (fs.statSync(abs).isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) add(path.posix.join(rel, name));
  } else {
    files[rel] = fs.readFileSync(abs).toString('base64');
  }
};
for (const rel of ['dist', 'assets', 'package.json']) add(rel);
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const payloadFile = path.join(out, 'payload.json');
fs.writeFileSync(payloadFile, JSON.stringify({ version, files }));
log(`payload: ${Object.keys(files).length} files, ${(fs.statSync(payloadFile).size / 1024).toFixed(0)} KiB`);

// 2. The SEA config and the preparation blob.
const blob = path.join(out, 'sea-prep.blob');
const configFile = path.join(out, 'sea-config.json');
fs.copyFileSync(path.join(root, 'scripts', 'sea-bootstrap.cjs'), path.join(out, 'bootstrap.cjs'));
fs.writeFileSync(configFile, `${JSON.stringify({
  main: path.join(out, 'bootstrap.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: { payload: payloadFile },
}, null, 2)}\n`);
run(process.execPath, ['--experimental-sea-config', configFile]);

// 3. Copy the node binary and inject the blob.
const exe = path.join(out, process.platform === 'win32' ? 'ai-sdlc-helper.exe' : 'ai-sdlc-helper');
const injectArgs = [exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', fuse,
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])];
const local = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');
const onPath = (() => {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['postject'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const postject = fs.existsSync(local) ? [local] : onPath ? ['postject'] : flag('--npx') ? ['npx', '--yes', 'postject@1.0.0-alpha.6'] : null;

if (flag('--blob-only') || !postject) {
  log(`\nBlob ready: ${blob}`);
  log(postject ? 'The remaining steps:' : 'postject was not found (pass --npx to run it through npx). The remaining steps:');
  log(`  cp "${process.execPath}" "${exe}"`);
  if (process.platform === 'darwin') log(`  codesign --remove-signature "${exe}"`);
  log(`  npx postject@1.0.0-alpha.6 ${injectArgs.map(a => `"${a}"`).join(' ')}`);
  if (process.platform === 'darwin') log(`  codesign --sign - "${exe}"`);
  process.exit(0);
}

fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', exe]);
run(postject[0], [...postject.slice(1), ...injectArgs], { shell: process.platform === 'win32' });
if (process.platform === 'darwin') run('codesign', ['--sign', '-', exe]);
log(`\nBuilt ${exe} (Node ${process.versions.node}, ${process.platform}-${process.arch}). Try: "${exe}" --version`);
