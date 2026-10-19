
Turn this report into backlog items that the SDLC pipeline (`ai-sdlc-helper start <slug>`) can run with few or no question rounds. Do not write source code, do not commit, and do not start the pipeline.

## 1. Understand and split
- If the report holds several independent problems or features, make one item for each.
- Classify each as `bug` (existing behaviour is wrong) or `feature` (new behaviour).
- Never make a backlog item for a documentation-only change (README, CLAUDE.md, AGENTS.md, API or schema docs, comments, any `.md` file). The pipeline builds and tests code, and a docs-only item has nothing to test, so it ships docs with no feature. Tell the user which parts of the report are docs-only, create no brief and no index line for them, and say they are better edited directly. If the report mixes code and docs, keep the code part as the item and list the docs under `## Docs`.
- Never paste secrets (passwords, tokens, full connection strings) into any file. Describe them by name only.

## 2. Check for duplicates
- Read `{{BACKLOG_DIR}}/index.md` (and the project's own bug list, if it keeps one), and list the folders under `{{BACKLOG_DIR}}/`.
- If an item already covers the report, tell the user which one and stop for that item. Do not create a second one.

## 3. Ground it in the code
- {{CODE_SEARCH}} Name the real files, functions and endpoints involved.
- For a bug, confirm the cause from the code and, when it is cheap and safe, reproduce it with `{{TEST_CMD}}` or a small read-only command. State what you verified and what you did not.
- Never run anything that changes a database or sends data outside this machine.

## 4. Decide what you can, ask only what you cannot
The Spec stage stops and asks whenever the brief is ambiguous, so every unanswered point costs a full pipeline round. Settle these in the brief, using the project's existing conventions as the default:
- Exact behaviour and the error for every failure, in the format the project already uses (find it in the code: an HTTP status and body, an exception type, an exit code).
- The order in which input is checked (for an API: bad input, then not found, then conflict), and what a failed request must not change.
- Scope: which files and endpoints are in, and what is explicitly out.
- Tests: where they live ({{TEST_FILES}}, mirroring the code layout) and the cases to cover. Every case must run the real code. Never plan a test that reads, greps or asserts on documentation (README.md, CLAUDE.md, AGENTS.md, any *.md); documentation goes under `## Docs` and is checked in the Review stage.
- Docs: which documentation files (README, API or schema docs, AGENTS.md) change.
- Dependencies: name any new package, but never make "the developer installs it first" a precondition and never ask a stage before Implement to read node_modules. The Plan stage confirms the API from the published docs and pins the version; the pipeline installs it at the start of Implement.
- Data and migrations: new migration number, backfill values, and how existing rows are treated.

Use AskUserQuestion (at most 4 questions per round) only for choices that the code and conventions cannot settle: product decisions, breaking API changes, security trade-offs. Put the answers into the brief as decisions. Anything still unknown goes under "Open questions" in the brief, never guessed.

## 5. Write the backlog item
For each item, choose a unique kebab-case slug of at most 4 words that starts with a verb or names the fix (for example `fix-database-url`, `hide-internal-errors`, `add-jwt-login`).

Create `{{BACKLOG_DIR}}/<slug>/brief.md` in exactly this shape:

```
# <slug>

Type: bug | feature
Priority: P0 (security or data loss) | P1 (blocks use) | P2 (normal) | P3 (nice to have)
Source: <where this came from: report, error text without secrets, bug list entry, link>

## Problem
<current behaviour and why it is wrong, or the need for a feature>
<for bugs: steps or request that reproduce it, and the verified cause with file:line>

## Expected behaviour
<what should happen instead, observable from outside>

## Decisions
- <concrete, testable decisions from step 4, one per line>

## Scope
- In: <files and endpoints>
- Out of scope: <what must not change>

## Tests
- <file path and the cases to cover>
- Every case runs the real code (they import or run the code under test). Never list a test that reads or asserts on documentation; put documentation under `## Docs`.

## Docs
- <files to update, or "none">

## Open questions
- <only if something is still unknown; otherwise "none">
```

Then add one line to `{{BACKLOG_DIR}}/index.md`, in this exact format (the pipeline reads it with a regex):

```
- [ ] `<slug>` - <Bug|Feature>: <short title>
```

The pipeline works top-down, so put P0 and P1 items above P2 and P3, and keep items of equal priority in the order they were reported. Create the file if it does not exist, with a `# Backlog` heading.

## 6. Report back
Reply with a short table: slug, type, priority, one-line summary, and any open questions. Then give the command to run it: `ai-sdlc-helper start <slug>`. Refer to SDLC stages by name (Spec, Plan, Red tests, Implement, Review, Ship), never by number.

## 7. Do not commit
Leave the new files uncommitted and do not switch branches. The person commits them (`ai-sdlc-helper triage` offers to commit exactly the new briefs and `{{BACKLOG_DIR}}/index.md` when you finish). A run starts from a committed base, so remind them that the items must be committed before `ai-sdlc-helper start <slug>`.
