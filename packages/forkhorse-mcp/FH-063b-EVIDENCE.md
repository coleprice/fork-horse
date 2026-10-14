# FH-063b local fixture checkpoint

Branch: `fh/FH-063b-mcp-judge`.

Base: `d1ded9e0c43ec1276ebb8fd03ab3fe7852272051`, verified after a fresh `git fetch origin main` (exit 0) and before any edits. Accepted `65161b36f47c08d8eb93000078654c9e4795c404` is already an ancestor; no redundant merge or rebase was made. The prior FH-054 checkpoint and its evidence are preserved in this base and its original branch.

Scope: `packages/forkhorse-mcp/**`, `docs/agents/**`, `skills/forkhorse/**`. The original implementation used labeled fixtures. The source integration below inherits accepted changes to core and other packages through a normal merge; builder conflict resolutions remain inside the allowed paths.

## Implemented behavior

- `list_judge_races({project})` filters public race state by the authenticated caller's judge assignment and retains latest advice, entrant evidence and finished history.
- `get_review({project, review})` and `get_review_diff({project, review, path})` forward the caller's bearer on the existing detail/diff routes. Core owns the scoped cross-agent read exception. The owner-only full receipt route is not exposed.
- `submit_verdict({project, packet, ranking, rationale})` sends exactly `{ranking, rationale}` to the assigned advisory endpoint. Safe unique agent names, three-entry cap and 1–2000 character rationale are validated locally. Exact roster membership, judge authority, replacement and finish refusal remain core responsibilities.
- Public judge/advice fields and reported usage survive the race parsing seam. Existing entrant resume, binding and OAuth workflows pass their regression checks. Six read tools and six non-idempotent write tools are advertised; owner approval and promotion remain absent.
- The judge skill explains receipts, diff size/content, recorded time and reported tokens, including incomplete evidence, missing usage, plain-text rationale and untrusted source content. Advice never promotes or determines the winner.

## Fixture evidence and limitations

Actual workerd tests use a fake core policy implementing the supplied contract. They do not validate FH-063's real authorization or storage implementation. Superprime's 19:28 shared contract answer confirms the full retained `/state.races[].entrants` roster, including withdrawn and closed entrants. Workerd fixtures verify that omitting a withdrawn entrant is refused and including it succeeds. MCP does not compute membership, change placings or override core decisions.

The capture at `__tests__/judge-capture.fixture.json` records five calls through the real MCP facade: assigned-race list, review detail, diff, advice submission and refreshed list. A Node test compares the generated capture against this saved artifact and optionally exports it through `FH063_CAPTURE_PATH`. It is credential-free **offline fixture evidence**, not a UI screenshot, deployed MCP response or live judge race.

Capture SHA-256: `1e9c8b47fbecc8b6df93fa4daa171c891425bd6bf4f1ae4ee203a3af1f605c08`.

## Pre-merge checks (historical checkpoint only)

| Command | Exit | Evidence |
| --- | --- | --- |
| `FH063_CAPTURE_PATH=<local-output> pnpm --config.verify-deps-before-run=false --filter forkhorse-mcp test:run` | 0 | 63 tests passed across seven files, including nine new actual-workerd judge cases and the offline capture comparison. |
| `pnpm --config.verify-deps-before-run=false --filter forkhorse-mcp types:check` | 0 | `tsc --noEmit` passed. |
| Scoped `vp lint --config <temporary-repository-lint-json> packages/forkhorse-mcp` | 0 | No lint findings; the JSON contains this checkout's repository lint rules. |
| `git -c core.fsmonitor=false diff --check` | 0 | No whitespace errors. |
| `shasum -a 256 <saved-capture> <exported-capture>` | 0 | Both capture hashes match the value above. |

Checks reuse locally available MCP dependencies without a workspace install or upstream initialization, and are not fresh-clone evidence. The first typecheck attempt failed because the new checkout lacked dependencies; the focused retry passed after package dependency setup. SDK source-map warnings about missing original sources are non-failing. All workerd judge fixtures block outbound fetch.

Local untracked logs: `FH-063b-package-tests.log`, `FH-063b-types.log`, `FH-063b-lint.log`; exported capture: `FH-063b-judge-capture.json`. The handback supplies their locations, the exact final SHA and path manifest. Tracked evidence excludes machine paths and credentials.

## Open gates

- Accepted FH-063 is source-integrated below; post-merge validation and live judge acceptance remain open.
- The full-retained-roster question is resolved by the 19:28 shared answer; guidance and fixtures use that rule.
- GitHub local-candidate/operator-publication route was confirmed at 19:38. No live packet, join, fork reuse, credential refresh, push or review submission was inferred.
- Root test/lint, fresh-clone suite and D5 remain on heavy hold pending a serialized grant.
- No live Cloudflare, deployment, spend or owner mutation was attempted. Local success is not packet acceptance.

## Source integration after reboot

The same assigned branch resumes from `0a81d1bbc8499c82bfcb55aea2ef2d849b012151` and plain-merges accepted main `4636d114cbac9140847a8f7cb5ce77e45305057b`. Seven allowed files required conflict resolution, combining accepted usage/reporting behavior with the judge tools. The inventory now contains thirteen tools: six reads and seven non-idempotent writes. Race parsing retains typed usage, budget and token-budget fields alongside judge/advice fields.

The accepted core source confirms the full retained entrant roster, the judge-to-entrant/fork review exception, and the verdict endpoint. MCP continues forwarding core's response and authorization; the saved `{verdict}` response remains explicitly a fixture. No core source was edited during resolution.

This integration is source-only under the post-reboot Coordinator directive. No installs, assets, tests, typechecks, lint, root suite, D5 or live checks ran on the merged tree. The historical check results above apply only to the pre-merge checkpoint. A fresh exclusive grant is required before post-merge checks.
