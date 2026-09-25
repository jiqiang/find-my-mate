# find-my-mate

A family location-sharing app: Expo + TypeScript (React Native) on Firebase, for 4 people in one group to see each other on a live map. Planning artefacts and the issue tracker live under `.scratch/`.

## Coding rules

* NEVER write unit tests after you write code.
* Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
* If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.

## Agent skills

### Issue tracker

Local markdown under `.scratch/`, one directory per feature. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, label string equal to the role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` plus `docs/adr/`, created lazily. See `docs/agents/domain.md`.
