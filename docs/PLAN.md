# Plan: ai-sdlc-helper

Goal: an SDLC pipeline (Spec, Plan, Red tests, Implement, Review, Ship) and its control pane that any Claude Code user
can install, independent of the project's language, database and test framework. Phases 1 to 3 were built inside
`imaimai86/production-retail-and-wholesale` (branch `sdlc-as-package`, as Bash and CommonJS scripts); from phase 4 the
work lives here, in TypeScript.

## What we ship

| Piece | Install | Contains |
|---|---|---|
| **`ai-sdlc-helper` npm package** (the engine) | `npm i -g ai-sdlc-helper` | The `ai-sdlc-helper` command, pipeline engine, test runner adapters, project and model registries, default prompts and skills |
| **Claude Code plugin** (the interface) | `/plugin marketplace add imaimai86/ai-sdlc-helper` | Slash commands, the control pane, the guard hooks, and the working rules as a skill |

The plugin is thin: every action calls the command. It checks at SessionStart that a compatible version is installed.

## Decisions

1. **Settings:** `sdlc.config.json` in the project (committed), then detection, then defaults; a user-level registry
   (`~/.config/ai-sdlc-helper/`) for project paths, personal overrides and models.
2. **Name (2026-10-16):** `ai-sdlc-helper` for both the npm package and the command; repo `imaimai86/ai-sdlc-helper`.
3. **Language:** TypeScript from the start (ES modules, `tsc` to `dist/`). Tests with Vitest; lint with ESLint.
4. **First release:** Node/TypeScript projects (jest, vitest, mocha, node:test) plus `generic-junit` for any runner that
   writes JUnit XML. Python, Go and the rest after launch.
5. **Code indexing:** recommended, not required. graft and graphify are built in, projects can declare others
   (`agent.codeIndexers`); `agent.codeSearch` picks one, `auto` (first available) or `none` (Grep and Glob). Skills and
   prompts that search code have a version per indexer, picked by what is available.
6. **Node versions (2026-10-16):** the tool needs Node 18 or newer (`engines`, CI on 18/20/22/24, `@types/node@18`).
   Projects may use any Node version: the Node a project asks for (`.nvmrc`, `.node-version`, `.tool-versions`,
   `volta.node`, `engines.node`) runs its test and lint commands through fnm, Volta, nvm or npx (`node` setting:
   `version` auto|current|X, `manager` auto|fnm|volta|nvm|npx|none). Test framework suggestions follow the lowest Node
   the project allows (below 18: no Vitest or node:test, Jest 29 and Mocha 10 pinned; below 14: none).

## Phases

1. **Settings and detection** (done, in production-retail-and-wholesale).
2. **Runner adapters and one result format** (done there): every run produces `{ ok, exitCode, command, tests, suiteErrors }`.
3. **No hard-coded paths** (done there): the pipeline, guard, prompts and slash commands read the settings.
4. **This repo, in TypeScript.** One pull request per part, each leaving `main` working:
   1. Scaffold, settings, detection, Node versions, test framework set-up, code search, skills; commands `detect`,
      `show`, `layout`, `node`, `suggest`, `init-tests`, `code-search`, `skill`. CI on Node 18, 20, 22 and 24.
   2. Runner adapters and the test checks (`testcheck`: diff, resume and retry checks, test locking).
   3. Changes, permissions, the model registry and the backlog listing.
   4. The pipeline engine (`sdlc.sh` in TypeScript): stages, prompts, agent runs, resume.
   5. Worktrees and runs (`sdlc-mod.sh` in TypeScript), and the project registry: `add`, `list`, `remove`, `doctor`.
   6. production-retail-and-wholesale switches to the package and drops its copies of the scripts.
5. **Plugin and marketplace.** Commands, pane and hooks move here; `/sdlc-init`; the rules skill;
   `.claude-plugin/marketplace.json`.
6. **End-to-end checks.** Sample projects (Node + Jest, TypeScript + Vitest, Node + Mocha, a JUnit-only project) run
   the whole pipeline in CI with a recorded stand-in for `claude`; one real run per release.
7. **Release.** npm publish with provenance, GitHub release, README, semver, CHANGELOG; the plugin declares the
   versions it supports. Optionally a self-contained binary that needs no Node install, built with Node's
   single-executable apps or `bun build --compile`.

## To build in (found by running the scripts on real projects)

From a real agent run (`add-db-health-check`, 2026-10-16):
- **Resume reads a stale `tests.log`:** a resumed run must not trust the previous run's test log; rerun or discard it.
- **One test file for agents:** give the stage agents a command that runs a single test file (the adapter's file
  filter), so they do not run the whole suite to check one change.
- **Full suite flaky under load:** load-sensitive timeouts; run the suite with limited workers in the pipeline and
  retry a failure once before calling it real.
- **Discard must use the run record's worktree path,** not a path rebuilt from the current settings.

From trying detection and `init-tests` on other projects:
- Expo projects (`jest-expo` preset) should be detected as Jest.
- JavaScript folders without a `package.json` are reported, not ignored silently.
- Mention existing test files found outside any runner's patterns.
- Offer the `__tests__` folder convention when the project already uses it.
- Label CommonJS projects as such in the project summary (not only "not ES modules").
