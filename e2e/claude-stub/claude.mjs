#!/usr/bin/env node
/* global process, console */
// A recorded stand-in for `claude`, for the end-to-end checks: no API key, no network. The pipeline runs it as
// `claude -p <prompt> ... --output-format json`; it tells the stage from the prompt's first words, checks what the engine
// passed, copies the recorded outputs of that stage (E2E_RECORDING/<stage>/, paths from the project root) into the
// checkout it runs in, and answers with the JSON result `claude --output-format json` prints.
//
// Environment:
//   E2E_RECORDING        the project's recordings folder (e2e/recordings/<project>)
//   E2E_STUB_LOG         a file that gets one JSON line per call (stage, cwd, files written), for the checks
//   E2E_SPEC_QUESTIONS   1: the first Spec round writes questions.md (spec-questions/) instead of the spec, so the run
//                        pauses; once decisions.md exists (the answers were recorded) Spec writes the spec
import fs from 'node:fs';
import path from 'node:path';

const STAGES = [
  ['You are a Requirements Agent', 'spec'],
  ['You are an Architecture Planner', 'plan'],
  ['You are a QA Engineer', 'red-tests'],
  ['You are a Senior TDD Developer', 'implement'],
  ['You are a Test Repair Agent', 'test-repair'],
  ['You are an independent, skeptical Test Auditor', 'test-audit'],
  ['You are a code reviewer', 'review'],
];

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('0.0.0 (ai-sdlc-helper e2e stand-in)');
  process.exit(0);
}

const opts = { prompt: null, outputFormat: null, permissionMode: null, model: null, allowedTools: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-p' || a === '--print') opts.prompt = argv[++i];
  else if (a === '--output-format') opts.outputFormat = argv[++i];
  else if (a === '--permission-mode') opts.permissionMode = argv[++i];
  else if (a === '--model') opts.model = argv[++i];
  else if (a === '--allowedTools') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.allowedTools.push(argv[++i]); }
}

const cwd = process.cwd();
const stage = (STAGES.find(([start]) => (opts.prompt || '').startsWith(start)) || [null, 'unknown'])[1];
const json = opts.outputFormat === 'json';
const problems = [];

function answer(code, text) {
  if (json) {
    console.log(JSON.stringify({
      type: 'result', subtype: code === 0 ? 'success' : 'error_during_execution', is_error: code !== 0, result: text,
      session_id: 'e2e-stub', num_turns: 1, permission_denials: [],
    }));
  } else console.log(text);
  if (code !== 0) process.stderr.write(`claude stand-in: ${text}\n`);
  process.exit(code);
}

function log(entry) {
  if (!process.env.E2E_STUB_LOG) return;
  fs.appendFileSync(process.env.E2E_STUB_LOG, `${JSON.stringify({ stage, cwd, ...entry })}\n`);
}

/** Every file under <dir>, from <dir>. */
function filesUnder(dir, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

// What every agent call must look like.
if (opts.prompt === null) problems.push('no -p <prompt>');
if (stage === 'unknown') problems.push(`prompt of no known stage: ${JSON.stringify(String(opts.prompt).slice(0, 80))}`);
const left = String(opts.prompt || '').match(/\{\{[A-Z_]+\}\}/g);
if (left) problems.push(`placeholders left in the prompt: ${[...new Set(left)].join(', ')}`);
if (stage === 'test-audit') {
  if (json) problems.push('the auditor runs without --output-format json');
} else if (stage !== 'unknown') {
  if (!json) problems.push('--output-format json is missing');
  if (!['acceptEdits', 'bypassPermissions'].includes(opts.permissionMode)) problems.push(`unexpected --permission-mode ${opts.permissionMode}`);
  if (!opts.allowedTools.some(t => /^Bash\(.* run --file:\*\)$/.test(t))) problems.push('no Bash(<tool> run --file:*) rule in --allowedTools');
}
if (!fs.existsSync(path.join(cwd, '.git'))) problems.push(`not run at the top of a git checkout: ${cwd}`);
const docs = (String(opts.prompt || '').match(/(\S+)\/(?:brief|specs-1|plan-1)\.md/) || [])[1];
if (!docs && stage !== 'unknown') problems.push('the prompt names no backlog item folder');
const recording = process.env.E2E_RECORDING;
if (!recording) problems.push('E2E_RECORDING is not set');
if (problems.length) { log({ problems }); answer(1, problems.join('; ')); }

if (stage === 'test-audit') { log({ written: [] }); answer(0, 'VERDICT: VALID'); }

// The inputs each stage reads must be there (the engine's gates make sure of it; this checks the order of the stages).
const needs = { plan: ['specs-1.md'], 'red-tests': ['specs-1.md', 'plan-1.md'], implement: ['plan-1.md', 'test-cases-1.md'], review: ['specs-1.md'] };
const missing = (needs[stage] || []).filter(f => !fs.existsSync(path.join(cwd, docs, f)));
if (missing.length) { log({ problems: [`missing ${missing.join(', ')}`] }); answer(1, `${stage}: missing ${missing.map(f => `${docs}/${f}`).join(', ')}`); }

let source = stage;
if (stage === 'spec' && process.env.E2E_SPEC_QUESTIONS === '1' && !fs.existsSync(path.join(cwd, docs, 'decisions.md'))) source = 'spec-questions';
const from = path.join(recording, source);
if (!fs.existsSync(from)) { log({ problems: [`no recording ${from}`] }); answer(1, `no recording for ${source} in ${recording}`); }

const written = filesUnder(from);
for (const f of written) {
  fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
  fs.copyFileSync(path.join(from, f), path.join(cwd, f));
}
log({ source, written, model: opts.model, permissionMode: opts.permissionMode });
answer(0, `${stage}: wrote ${written.join(', ')}`);
