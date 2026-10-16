# ai-sdlc-helper

A global npm package and Claude Code plugin that runs an AI-driven SDLC pipeline (Spec, Plan, Red tests, Implement, Review, Ship) on any project. TypeScript, ES modules, Vitest, ESLint. The plan is in `docs/PLAN.md`.

## Commands
| Command | Purpose |
|---|---|
| `npm run check` | Lint, typecheck and test. Run it before every commit and push. |
| `npm run build` | Compile `src/` to `dist/`. |
| `node dist/bin.js <command>` | Run the built command (`ai-sdlc-helper`). |

## Rules
- The tool runs on Node 18 or newer: no APIs newer than Node 18 (`@types/node` is pinned to 18 to catch them). Projects it works on may use any Node version; their commands run through `src/config/node.ts`.
- Tests live in `test/` and run the real code (import it or run the command through `test/helpers.ts`); never assert on Markdown files or comments.
- Prompts and skills shipped to users live in `assets/`.
- Refer to SDLC stages by name (Spec, Plan, Red tests, Implement, Review, Ship), never by number.
- Worktrees live outside the repository, at `../ai-sdlc-helper-sdlc/<slug>`.
- Work goes through pull requests into `main`; confirm every merge with the user first, naming the PR and its CI status.
