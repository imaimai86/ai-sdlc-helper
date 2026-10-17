import { parseJestLike } from './jest.js';
import { noReport, q, namePattern, type Adapter } from './types.js';

/** Vitest: `run --reporter=json --outputFile`, files as arguments, `-t` for names, `--maxWorkers` when limited. */
export const vitestAdapter: Adapter = ctx => {
  const t = ctx.names.length ? ` -t ${q(namePattern(ctx.names))}` : '';
  const workers = ctx.maxWorkers ? ` --maxWorkers=${ctx.maxWorkers}` : '';
  const command = ctx.wrap(`${ctx.exec} vitest run --reporter=json --outputFile=${q(ctx.out)}${workers}${ctx.inSuite.length ? ` ${ctx.inSuite.join(' ')}` : ''}${t}`);
  const r = ctx.sh(command);
  const report = ctx.read(ctx.out);
  if (!report) return noReport(command, r);
  return { command, exitCode: r.status, parts: parseJestLike(JSON.parse(report), { root: ctx.root }) };
};
