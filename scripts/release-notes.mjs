#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version (the text under `## [<version>]`, without the heading), for the
// GitHub release notes. Usage: node scripts/release-notes.mjs <version> [CHANGELOG.md]
// Exits 1 when the version has no section or the section is empty.
import fs from 'node:fs';
import process from 'node:process';

const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
if (!version) {
  process.stderr.write('Usage: node scripts/release-notes.mjs <version> [CHANGELOG.md]\n');
  process.exit(2);
}
const wanted = version.replace(/^v/, '');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const heading = /^## \[([^\]]+)\]/;
const start = lines.findIndex(line => heading.exec(line)?.[1] === wanted);
if (start < 0) {
  process.stderr.write(`ERROR: ${file} has no "## [${wanted}]" section.\n`);
  process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && (heading.test(line) || /^\[[^\]]+\]:\s/.test(line)));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  process.stderr.write(`ERROR: the "## [${wanted}]" section of ${file} is empty.\n`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
