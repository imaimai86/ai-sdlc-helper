import { resumecheck } from '../testcheck/checks.js';
import type { Ctx } from './context.js';

/** The command that resumes this run at <stage>. */
export const resumeCommand = (slug: string, stage: string): string => `ai-sdlc-helper pipeline ${slug} --from ${stage}`;

/** Tells the developer how to resume at Test repair, only when its preconditions (resumecheck) hold now. */
export function resumeHint(ctx: Ctx): void {
  let errs: string[];
  try { errs = resumecheck(ctx.keys, ctx.origRedSha, `${ctx.docs}/test-issues.md`, ctx.slug, ctx.lockSha || undefined); } catch { return; }
  if (!errs.length) ctx.out(`Resume at Test repair once fixed: ${resumeCommand(ctx.slug, 'test-repair')}`);
}
