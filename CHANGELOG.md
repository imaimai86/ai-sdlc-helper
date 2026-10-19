# Changelog

All notable changes to `ai-sdlc-helper` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is below 1.0.0, a minor version may
change commands or settings in ways that are not backward compatible.

The release workflow publishes the section whose heading matches the tag (`## [0.1.0]` for `v0.1.0`) as the GitHub
release notes. Keep new work under `## [Unreleased]`, and rename that heading to the version before tagging.

## [Unreleased]

### Added

- **`ai-sdlc-helper triage`** turns a report into backlog items: a Claude agent follows the shipped triage prompt
  (interactive, so it can ask; or headless with `--print`), writes each `brief.md` and index line, and the tool lists
  the new items and commits exactly those files on the current branch when asked (`--commit`). It never pushes.
- **New dependencies are installed by the pipeline.** The Plan stage may read a library's published docs (WebFetch,
  WebSearch, context7, or the new `ai-sdlc-helper fetch <https-url>`, a GET-only read from package-doc hosts) and
  lists exact versions under `## Dependencies` in the plan; Implement installs them first, without install scripts.
- **Usage limits are waited out.** An agent that hits the account's usage limit runs again after the reset
  (`SDLC_LIMIT_RETRY`, `SDLC_LIMIT_MAX_WAIT`); `status.json` has a `note` meanwhile.
- **Read-only commands for every stage agent** (`cat`, `grep`, `git show`, `npm view` and the like), so harmless reads
  are not refused.

### Fixed

- The run controls work on the checkout they are run in. A project that is one worktree of a bigger repository
  used the main working tree's settings (its `git.base`, backlog and links were ignored, so runs started from the wrong
  branch); saved permission rules went there too. A command run inside a pipeline's own worktree still maps back to the
  checkout that started it (recorded as `root` in the run record).
- The shipped `triage` and `sdlc` skills no longer refer to production-retail's scripts (`scripts/sdlc.sh`,
  `sdlc-mod.sh`, `Engineering/bugs.md`) or its API conventions, and triage no longer pushes a branch itself.
- A Test repair claim that cites the plan is accepted.
- A refused command line such as `cd x; sed …` asks for the rule of the part that was not allowed (`sed`), not an
  allowed one, and is not asked again once allowed.
- The files per stage credit a stage with an earlier stage's file that it changed and committed.

## [0.1.0] - Unreleased

The first release: the SDLC pipeline from `production-retail-and-wholesale`, rewritten in TypeScript as a global
command that works on any Node or TypeScript project.

### Added

- **Settings and detection** (#1). The `ai-sdlc-helper` command reads `sdlc.config.json` from your project, then
  detects what it can, then falls back to defaults. It finds Jest, Vitest, Mocha, node:test and any runner that writes
  JUnit XML (`generic-junit`), with their test files and test command.
  - `detect`, `show`, `layout` and `node` show what was found and the resolved settings.
  - `suggest` and `init-tests` set up a test framework for a project that has none, picked to fit the lowest Node
    version the project allows.
  - When the project asks for its own Node version (`.nvmrc`, `.node-version`, `.tool-versions`, `volta.node`,
    `engines.node`), its commands run through fnm, Volta, nvm or npx.
  - `code-search` picks the code indexer the agents search with (graft, graphify, your own, or none), and `skill`
    prints a skill's text for your project.
- **Project registry** (#2). `add`, `list`, `remove` and `doctor` keep a list of your projects in
  `~/.config/ai-sdlc-helper/` (`%APPDATA%` on Windows) and check that a project has what the pipeline needs.
- **Guide to watching several worktrees** (#3), with how to install `watch` on each operating system.
- **Test runs and test checks** (#4). `run` runs a suite, or a single test file with `--file`, and writes one result
  format for every runner; `parse-report` reads JUnit XML; `testcheck` holds the checks the pipeline uses between
  stages (test diffs, test locking, resume and retry). An opt-in guard for flaky suites reruns failed files once and
  limits workers.
- **Changes, permissions, models and backlog** (#5). `changes` lists what a run changed; `permissions` and `permit`
  decide the actions a stage agent was refused; `model` manages your providers and models in
  `~/.config/ai-sdlc-helper/models.json` (an existing `sdlc/models.json` is still read); `backlog` lists the backlog
  by status.
- **Run controls** (#6). Each backlog item's pipeline runs in its own git worktree and branch, with `start`, `stop`,
  `restart`, `discard`, `status`, `watch` (`--follow`) and `changes`, and a cap on how many run at once.
- **The pipeline** (#7). `pipeline [slug]` runs Spec, Plan, Red tests, Implement, Test repair, Review and Ship with
  Claude Code agents, pausing for your answers to Spec and Plan questions and resuming with `--from <stage>`.
  - A resumed run never trusts the previous run's test log.
  - Agents get a command that runs one test file, so they do not run the whole suite for each change.
  - The gates retry a failing suite once and report tests that look flaky.
- A library entry point (`import { detect, resolve } from 'ai-sdlc-helper'`) for settings, detection, test framework
  set-up and code search.

[Unreleased]: https://github.com/imaimai86/ai-sdlc-helper/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/imaimai86/ai-sdlc-helper/releases/tag/v0.1.0
