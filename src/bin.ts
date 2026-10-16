#!/usr/bin/env node
import readline from 'node:readline';
import { main } from './cli/main.js';

const ask = (question: string): Promise<string> => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
});

main(process.argv.slice(2), {
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  ask: process.stdin.isTTY ? ask : undefined,
}).then(code => { process.exitCode = code; }, error => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
