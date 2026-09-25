# find-my-mate

A family location-sharing app: Expo + TypeScript (React Native) on Firebase, for 4 people in one group to see each other on a live map. GitHub Issues on jiqiang/find-my-mate are the single source of truth for work: specs, tickets, status and blockers.

## Rules of testing

* NEVER write unit tests after you write code.
* Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
* If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.

## Agent skills

### Issue tracker

GitHub Issues for jiqiang/find-my-mate, via the `gh` CLI, are the single source of truth. Never track issues, ticket status or blockers in local files (including `.scratch/`); read and write them on GitHub. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, label string equal to the role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` plus `docs/adr/`, created lazily. See `docs/agents/domain.md`.
