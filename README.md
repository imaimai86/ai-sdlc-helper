# Dark Factory

**ai-sdlc-helper** runs an AI-driven SDLC pipeline on your project with Claude Code agents: Spec, Plan, Red tests, Implement, Review and Ship, each stage checked before the next starts.

It works with the project's own language, test framework and database: it detects the test runner (Jest, Vitest, Mocha, node:test, or any runner that writes JUnit XML), reads `sdlc.config.json` for anything detection cannot know, and sets up a test framework for projects that have none.

> Early work: the configuration and set-up commands are here; the pipeline itself is being ported. See [docs/PLAN.md](docs/PLAN.md).

## Requirements
- Node 18 or newer to run the tool. Your project may use any Node version: when it asks for another one (`.nvmrc`, `.node-version`, `.tool-versions`, `volta.node` or `engines.node`), its commands run through fnm, Volta, nvm or npx.
- [Claude Code](https://claude.com/claude-code) for the pipeline.
- A code indexer is recommended, not required: [graft](https://www.npmjs.com/package/@nanonets/graft), graphify or your own. Without one the agents search with Grep and Glob.

## Commands
```
ai-sdlc-helper detect [dir]          the test suites found
ai-sdlc-helper show [dir]            the resolved settings
ai-sdlc-helper node [dir]            the Node the project's commands run with
ai-sdlc-helper suggest [dir]         test frameworks for a project without tests
ai-sdlc-helper init-tests [dir]      set one up: confirm the language, pick a framework, apply
ai-sdlc-helper code-search [dir] --list | --use <name>
ai-sdlc-helper skill <name> [dir]
```

## Development
```
npm ci
npm run check
npm run build
```

MIT licensed.
