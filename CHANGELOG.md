# Changelog

All notable changes to `ai-sdlc-helper` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is below 1.0.0, a minor version may
change commands or settings in ways that are not backward compatible.

The release workflow publishes the section whose heading matches the tag (`## [0.1.0]` for `v0.1.0`) as the GitHub
release notes. Keep new work under `## [Unreleased]`, and rename that heading to the version before tagging.

## [Unreleased]

### Added

- **New packages are installed in Implement.** Plan lists exact versions under `## Dependencies`, reads a library's published docs and types from the web (WebFetch, WebSearch, context7, or the new `fetch` command), and the pipeline installs them at the start of Implement, without install scripts unless `SDLC_DEP_SCRIPTS=run`. Spec, Plan and the skills no longer ask for packages to be installed first.
- **`fetch <https-url>`**: one GET from the npm registry, unpkg, jsDelivr or GitHub (`SDLC_FETCH_HOSTS` replaces the list), which stage agents may run where they may not run `curl`.
- **A usage limit is waited out.** The same agent runs again every `SDLC_LIMIT_RETRY` seconds (default 300) for up to `SDLC_LIMIT_MAX_WAIT` seconds (default 21600); `status.json` has a new `note` field with the reset time while it waits.
- **Read-only shell commands** (`cat`, `head`, `tail`, `wc`, `grep`, `rg`, `jq`, `git show` and similar) run without a prompt in every stage.

### Fixed

- A refused command line with several commands (`cd x; sed ...`) offers the rule for the first command that is not allowed, and is not asked again once that rule is allowed.
- A test file an earlier stage wrote and a later stage changed and committed (Test repair) is credited to both stages; a commit that only collects earlier work, unchanged since the last mark, is credited to none.
- `stop` signals only a run whose record says it is running, so a finished run's pid, which another process may now hold, is left alone.
- A Test repair claim may cite the plan (`plan-1.md`) as well as the spec, a decision or an isolation defect.

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
