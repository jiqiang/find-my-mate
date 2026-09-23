# Issue tracker: Local Markdown

Issues and specs live as markdown files under `.scratch/` at the repo root
(`/home/jiqiang/dev/find-my-mate`). `.scratch/` is gitignored, so issue files stay uncommitted; the
durable output of an effort (a spec, docs, code) is written outside it.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Category, where it matters, is a `Category:` line (`bug`/`enhancement`) alongside `Status:`
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed), relative to the repo root.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Current efforts

- `.scratch/find-my-mate/` — the v1 spec effort (wayfinder map plus its decision tickets).

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — Destination / Notes / Decisions so far / Not yet specified / Out of scope.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `open` / `claimed` / `resolved`; an `Agent:` line records who holds the claim.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked and unclaimed; lowest number first.
- **Claim**: set `Status: claimed` and name the agent before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (name + gist + link) to the map's Decisions so far in `map.md`.
- **Refer by name**: tickets are referred to by title in narration and in the map, never by a bare number.
- **One ticket per session**, research tickets excepted.
