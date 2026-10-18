# Releasing ai-sdlc-helper

Releases are cut by pushing a version tag. The workflow `.github/workflows/release.yml` checks, builds and tests the
tag, publishes the package to npm with provenance and creates the GitHub release from `CHANGELOG.md`. Versions follow
[semver](https://semver.org/); below 1.0.0 a minor version may break commands or settings.

## Once, before the first release

1. **npm account.** Sign in to npmjs.com as the account that will own `ai-sdlc-helper`, with two-factor
   authentication on. The name is free (`npm view ai-sdlc-helper` returns 404) until the first publish takes it.
2. **A publish token for the first release.** npm trusted publishing can only be set up for a package that exists, so
   the first publish uses a token:
   - npmjs.com > Access Tokens > Generate New Token > **Granular Access Token**: packages and scopes **Read and
     write**, all packages (the package does not exist yet), a short expiry (7 days is enough), and tick
     "Bypass two-factor authentication" so CI can publish.
   - GitHub > imaimai86/ai-sdlc-helper > Settings > Secrets and variables > Actions > New repository secret:
     name `NPM_TOKEN`, the token as the value.
3. **After the first release, switch to trusted publishing** (no long-lived token):
   - npmjs.com > ai-sdlc-helper > Settings > Trusted Publisher > GitHub Actions: organization or user `imaimai86`,
     repository `ai-sdlc-helper`, workflow filename `release.yml`, environment empty.
   - Under "Publishing access", choose "Require two-factor authentication and disallow tokens".
   - Delete the `NPM_TOKEN` secret on GitHub and revoke the token on npm. The workflow updates npm to 11.5.1 or newer,
     which publishes through OIDC when no token is set.
4. **The repository stays public**: npm provenance is only accepted from public repositories, and `repository.url` in
   `package.json` must keep naming `imaimai86/ai-sdlc-helper`.
5. **Workflow permissions**: the workflow asks for `contents: write` (the release) and `id-token: write` (provenance)
   itself. If Settings > Actions > General restricts workflow permissions to read, the job-level `permissions` block
   still applies; nothing to change unless an organization policy blocks it.

## Cutting a release

1. Start from an up-to-date `main` with a clean working tree and a green CI run.
2. In `CHANGELOG.md`, move the entries under `## [Unreleased]` to a new `## [X.Y.Z] - YYYY-MM-DD` section (for the
   first release, replace `- Unreleased` in `## [0.1.0] - Unreleased` with the date), and add the compare link at the
   bottom. Merge that change through a pull request. The workflow fails a tag whose CHANGELOG heading still says
   Unreleased, and one with no section for its version.
3. Check the release locally:
   ```
   npm ci
   npm run check
   npm pack --dry-run          # only dist/, assets/, README.md, LICENSE, CHANGELOG.md, package.json
   node scripts/release-notes.mjs X.Y.Z   # the text the GitHub release will show
   ```
4. Bump the version and tag it. `npm version` updates `package.json` and `package-lock.json`, commits and creates the
   tag `vX.Y.Z`:
   ```
   npm version patch           # or minor, major, or an exact version: npm version 0.1.0
   ```
   For 0.1.0 itself the version is already in `package.json`, so tag it directly: `git tag -a v0.1.0 -m v0.1.0`.
   Pre-releases: `npm version prerelease --preid beta` gives `X.Y.Z-beta.0`, published to the `next` dist-tag
   and marked as a pre-release on GitHub.
5. Push the commit, then the tag:
   ```
   git push origin main
   git push origin vX.Y.Z
   ```
   If `main` only takes pull requests, open one from a `release/vX.Y.Z` branch with the version commit, merge it, then
   tag the merge commit on `main` and push the tag.
6. Watch Actions > Release. When it is green, check:
   ```
   npm view ai-sdlc-helper version dist-tags
   npm i -g ai-sdlc-helper && ai-sdlc-helper --version
   ```
   The npm page shows the provenance badge, and Releases shows `vX.Y.Z` with the CHANGELOG section.

## What the workflow does

On a pushed tag `v*.*.*` (Node 22, Ubuntu):
1. `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
2. Fails unless the tag is `v` + the `package.json` version.
3. Extracts the version's section from `CHANGELOG.md` (`scripts/release-notes.mjs`); fails if it is missing, empty
   or still marked Unreleased.
4. Packs the package, installs the tarball into a temporary prefix and runs `--version`, `help`, `detect` and
   `skill plan` from the installed copy.
5. `npm publish --provenance --access public` (dist-tag `latest`, or `next` for a pre-release), with `NPM_TOKEN` when
   the secret is set, otherwise trusted publishing.
6. `gh release create vX.Y.Z` with the CHANGELOG section as the notes and the packed tarball attached.

## Dry run

Actions > Release > Run workflow, keep "Dry run" ticked (the default), on any branch. It runs steps 1 to 4 (the tag
check only reports the version, and an Unreleased heading is a warning) and then `npm publish --dry-run`: nothing is
published and no release is created. A manual run publishes only when it is started on a tag with the box unticked,
which is a way to retry a tag whose publish step failed.

Locally: `npm publish --dry-run` shows the files and the access without publishing (it runs `prepublishOnly`:
clean, build, check).

## When something goes wrong

- **The workflow failed before publishing** (checks, tag mismatch, CHANGELOG): fix it on `main`, delete the tag
  (`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`), tag again and push.
- **Published but the GitHub release failed:** rerun the failed job, or create the release by hand:
  `node scripts/release-notes.mjs X.Y.Z > notes.md && gh release create vX.Y.Z --notes-file notes.md --verify-tag`.
- **A bad version was published:** npm versions cannot be reused, so publish a fixed `X.Y.(Z+1)`. Then mark the bad
  one: `npm deprecate ai-sdlc-helper@X.Y.Z "Broken: use X.Y.(Z+1)"`. To point `latest` back at a good version
  meanwhile: `npm dist-tag add ai-sdlc-helper@<good> latest`.
- **Unpublish** only as a last resort (secrets in the tarball): `npm unpublish ai-sdlc-helper@X.Y.Z` works within 72
  hours and when no other package depends on it; the version number can never be published again.
- **Publishing from a laptop** (not recommended): `publishConfig.provenance` is on, which only works in CI, so it
  needs `npm publish --provenance=false`, and the package loses its provenance badge for that version.

## Installing from git

The package has a `prepare` script (`npm run build`), because `dist/` is not committed. What works and what does not
(tested with npm 10.9.7):

- **Inside a project:** `npm i github:imaimai86/ai-sdlc-helper` (or `#<branch>`, `#vX.Y.Z`) works: npm clones it,
  installs the dev dependencies in the clone, runs `prepare` and installs the built package.
- **Global, from git: broken in npm 10.** `npm i -g github:imaimai86/ai-sdlc-helper` leaves a dangling link in the
  global `node_modules` and no working command. npm runs the clone's own install in global mode, which links the
  temporary clone into the global folder before it is deleted. This happens to any package with a `prepare` script
  (checked with a one-file package), so it cannot be fixed in this repository.
- **Global, from git, the way that works:** pack first, then install the tarball:
  ```
  npm pack github:imaimai86/ai-sdlc-helper#main
  npm i -g ./ai-sdlc-helper-*.tgz
  ```
- **Global, from a GitHub release:** each release has the npm tarball attached, so
  `npm i -g https://github.com/imaimai86/ai-sdlc-helper/releases/download/vX.Y.Z/ai-sdlc-helper-X.Y.Z.tgz` works
  without the npm registry.

## Single executable (optional, not released yet)

`node scripts/build-sea.mjs` builds `build/sea/ai-sdlc-helper` (`.exe` on Windows), a binary that needs no Node
install, with [Node's single executable applications](https://nodejs.org/api/single-executable-applications.html).
It builds for the platform and architecture of the Node running it, so each target is built on its own runner.

- **Node 22.12 or newer** to build: the entry point (`scripts/sea-bootstrap.cjs`) loads the ES module `dist/bin.js`
  with `require()`. The binary carries that Node version (about 100 MB).
- **No bundler:** SEA runs a single CommonJS script, and the tool is ES modules that read prompts and skills from
  `assets/`. Instead of bundling, the binary carries `dist/`, `assets/` and `package.json` as one SEA asset and writes
  them to a cache folder on first run (`~/Library/Caches/ai-sdlc-helper`, `$XDG_CACHE_HOME/ai-sdlc-helper` or
  `%LOCALAPPDATA%\ai-sdlc-helper\Cache`; `AI_SDLC_HELPER_SEA_CACHE` overrides), one folder per version and content.
  Everything built from `import.meta.url` then works unchanged.
- **Starting itself again:** pipeline runs start the command as `[process.execPath, dist/bin.js, ...]`. In the binary
  `process.execPath` is the binary, so the bootstrap drops that script path when it is the first argument.
- **postject is needed** to inject the blob and is not a dependency: `node scripts/build-sea.mjs --npx` runs
  `npx --yes postject@1.0.0-alpha.6`, or install it yourself. Without it the script stops after the blob and prints
  the remaining commands. On macOS it removes and re-adds an ad-hoc signature (`codesign`); a distributed macOS binary
  needs a Developer ID signature and notarization, and a Windows one a code signature, or users get warnings.
- **Tested so far:** the blob builds on Node 22 (macOS arm64), and the bootstrap runs `--version`, `detect` and
  `skill plan` from the payload outside a binary (`AI_SDLC_HELPER_SEA_PAYLOAD=build/sea/payload.json node
  build/sea/bootstrap.cjs --version`). The injected binary has not been run yet, because postject was not available.
- **Alternative:** `bun build src/bin.ts --compile --outfile ai-sdlc-helper` (Bun 1.1 or newer, `--target
  bun-linux-x64` and others to cross-compile). Bun bundles the ES modules itself, but `assets/` is still read from disk
  through `import.meta.url`, so the asset paths in `src/util.ts` (`ASSETS_DIR`) would need Bun's embedded files
  (`import ... with { type: "file" }`) or the same extract-to-cache step; the self-start in `src/runs/index.ts` and
  `src/pipeline/run.ts` needs the same argument handling.
- To ship binaries later: a matrix job (ubuntu, macos, windows) running `node scripts/build-sea.mjs --npx` on the tag
  and attaching the files with `gh release upload`.
