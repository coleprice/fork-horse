# FH-062 synthetic browser captures

## Evidence location

JPGs are kept outside Git. Local evidence bundle: `fh-062-token-usage-evidence-6ce9674.tar.gz`.
It contains `fh-062/` with the original fifteen captures and `return-1/` with the
six rechecks, plus the source-head READMEs and `SHA256SUMS`. The operator handback
provides its local location; tracked documentation records only the bundle name.
Source snapshot: `6ce9674c3fb9fd815f673ed63084970498228d5e`.
Archive SHA-256: `0f6bdf460da3269eb49765e1302aa9762921132925392c711ffd731ed07ae34c`.

From the directory containing the bundle, unpack and verify:

```sh
tar -xzf fh-062-token-usage-evidence-6ce9674.tar.gz
cd fh-062-token-usage-evidence-6ce9674
shasum -a 256 -c SHA256SUMS
```

The listed capture filenames below refer to the external bundle. Preserve future
captures outside the checkout; do not recommit JPG evidence.

These screenshots use the loopback fixture API and the real dashboard components.
They are local browser evidence, not live account, Cloudflare, workerd, D5,
Saddler, or owner acceptance. Desktop viewport: 1280 by 720; phone: 390 by 844.
Full-page captures show content beyond the viewport; horizontally scrolling tables
show their initial scroll position. Theme controls were hidden through the fixture UI.

| File | Fixture route | Evidence |
| --- | --- | --- |
| race-light.jpg | `?scenario=usage-race#race/FH-040` | Separate source labels, accepted FH-055 track, 42%/82%/over-budget meters, facts-only Compare and Results |
| race-dark.jpg | `?scenario=usage-race#race/FH-040` | Same facts under dark host tokens |
| agent-over-review.jpg | `?scenario=usage-over&role=agent#review/usage-review-2` | Read-only agent sees the automatic rejection caption and no owner controls |
| over-review.jpg | `?scenario=usage-over#review/usage-review-2` | Usage snapshot, three milestone cells, over-budget caption and no Promote |
| unchecked-queue.jpg | `?scenario=usage-unchecked#review` | Conditional Tokens column, Not reported, missing-report promotion caption |
| agents-both-sources.jpg | `?scenario=usage-both#agents` | Separate reported/metered totals and cumulative-window explanation |
| phone-agent-race.jpg | `?scenario=usage-unchecked&role=agent#race/FH-040` | Accepted phone milestone cards, unchecked warning, horizontal Compare table |
| phone-agent-totals.jpg | `?scenario=usage-both&role=agent#agents` | Totals fold beneath agent names on narrow screens |
| unbudgeted-race.jpg | `?scenario=usage-unbudgeted#race/FH-040` | Core unchecked state with null budget shows Not reported without meter/warning |
| unbudgeted-promote.jpg | `?scenario=usage-unbudgeted#review/usage-review-0` | Promote remains visible with no budget caption; no write performed |
| photo-finish-integration.jpg | `?scenario=race-photo#race/race-01` | Accepted placings, photo-finish badge, rejected CAS evidence, shared glyphs and silks retained |
| reused-forks-pushes.jpg | `?scenario=race-reused-forks#race/race-01` | Shared race-window counts: Compare and Results both show one push per reused fork |
| fork-table-collapsed.jpg | `?scenario=usage-race#overview` | State-owned clipping keeps Tokens in the accessibility twin and closed controls out of tab order |
| fork-history-integration.jpg | `?scenario=fork-history#overview` | Accepted compact event cells and earlier-event disclosure retained |
| fork-table.jpg | `?scenario=usage-race#overview` | Expanded table twin includes Tokens; graph labels contain no figures |

The source fixture also covers legacy records, metered precedence, zero reports,
80%/100%/over boundaries, snapshot deduplication, missing review-detail capability,
immutable snapshots versus current budget state, and unchanged Needs you kinds.

## Prior FH-055 integration checks

Original branch base: `cc71fff99bf72434978ad297329a8a9f05ef6aea`.
Fresh `origin/main` and explicitly accepted integration base both verified as
`ea577a1d96fc52528bd2854d58ee2a29d9ccf679` (FH-055).
Normal merge: `3d87cdca649740984524882a00408cb9780ae327`.
Its parents are `41c6a04461af9fe7b6c82435847b133e0799c50f` and
`ea577a1d96fc52528bd2854d58ee2a29d9ccf679`.
Branch: `fh/FH-062-usage-ui`. No feature-branch copying, rebase, or publication.
No packet-owned example used the former OS-agent seed name, so no rename was needed.
Pinned upstream unchanged: `8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf`.

| Command | Result |
| --- | --- |
| `CI=true pnpm --filter forkhorse-dashboard test` | Exit 0; 104 passed, 0 failed; includes 13 usage tests and accepted FH-055 regressions |
| `CI=true pnpm --filter forkhorse-dashboard types:check` | Exit 0 |
| `CI=true pnpm exec vp lint packages/forkhorse-dashboard` | Exit 0; no lint findings |
| `CI=true pnpm --filter forkhorse-dashboard build` | Exit 0; static production assets built |
| `CI=true pnpm --filter forkhorse-dashboard build:fixture` | Exit 0; separate fixture assets built |
| `git -c core.fsmonitor=false diff --check` | Exit 0 |

Literal-color scan (expected rg exit 1, zero matches; host palette is excluded):

```sh
rg -n '#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|color)\(' \
  packages/forkhorse-dashboard/src --glob '!host-tokens.json'
```

The existing fixture suite logs duplicate project-key warnings. Vite reports its
existing over-500-kB chunk warning. Neither is presented as owner or live acceptance.
The first offline dependency install lacked cached packages; the locked dashboard
install completed with normal network access and the unmodified pinned workspace
submodule initialized. No credential helper or publication route was changed.

Open gates: accepted FH-060 and overlapping FH-049 integration if it lands; serialized
root test/lint, fresh clone/D5, host workerd checks; Saddler PASS and owner review.
The package is a static client, so its DOM tests do not claim Worker runtime acceptance.
Desktop browser geometry: all eighteen milestone mark boxes remain 24 by 24 px;
checks hurdles have zero horizontal center offset. Other glyph centers differ by
at most 0.5 px due to their accepted border geometry. Read-only browser inspection
also confirmed unbudgeted Promote is visible with zero budget captions.

The source is tested against fixtures for the fixed FH-060 contract only.
The FH-060 implementation has not been accepted or merged into this candidate.

## FH-055b follow-up

Fresh `origin/main` was `c3dec6e43994b49007b6ad06ab55d13c61607955`, which
contains the explicitly authorized accepted FH-055b commit
`f924b7a40fa94bc457677dfa3898c940b1676e37`. This follow-up merged that exact
accepted commit, without taking the newer FH-057b merge pending separate acceptance
authority. Normal merge: `97cf0650f6560a0d5d814a85c98d27cc6a342d53`; parents
`90cabe62afb723d0645e62d3c97976e3f8030fc5` and
`f924b7a40fa94bc457677dfa3898c940b1676e37`.

Compare now uses shared `packetPushes` and `oldestLoadedActivity`. Its Recorded
pushes row and caption are omitted whenever Results omits the Pushes column for
incomplete history. Both count default-branch, non-delete pushes by receive time
from claim through entrant close, race finish, or now. Existing accepted regressions
now also assert that Compare agrees with Results for reused forks, unordered history,
interval endpoints, unrelated Git events, and each end condition.

| Latest follow-up command | Result |
| --- | --- |
| `CI=true pnpm --filter forkhorse-dashboard exec node --import ./test/jsx-runtime.ts --test test/race.test.ts test/usage.test.ts test/fork-graph.test.ts` | Exit 0; 40 passed, 0 failed |
| `CI=true pnpm --filter forkhorse-dashboard types:check` | Exit 0 |
| `CI=true pnpm exec vp lint packages/forkhorse-dashboard` | Exit 0; no findings |
| `git -c core.fsmonitor=false diff --check` | Exit 0 |

The 104-test suite and builds above describe the preceding FH-055 candidate.
This small FH-055b follow-up ran the affected regressions, types, and scoped lint.
Race light/dark, phone race, unbudgeted race, and photo-finish captures were refreshed.
A new reused-forks capture confirms one push in both tables despite historical fork
totals of twenty and three. The usage fixture starts loading after every claim, so
its refreshed captures omit both push facts. Other captures retain their prior
fixture evidence. No root/fresh-clone/D5, live, publication, or Board action occurred.

## FH-057b follow-up

After explicit acceptance authority, fresh `origin/main` verified exactly
`c3dec6e43994b49007b6ad06ab55d13c61607955`. The normal merge has parents
`edb9903c9829a4871b0814fc5bb978a2395ed1d4` and that accepted main commit.
README sections and fixture imports required conflicts to be combined. The graph
source and styles merged automatically, retaining both the accepted bundle fixes
and FH-062's usage tooltip/Tokens table cell. No FH-057c feature branch was copied.

| Latest follow-up command | Result |
| --- | --- |
| `CI=true pnpm --filter forkhorse-dashboard exec node --import ./test/jsx-runtime.ts --test test/race.test.ts test/usage.test.ts test/fork-graph.test.ts` | Exit 0; 42 passed, 0 failed |
| `CI=true pnpm --filter forkhorse-dashboard types:check` | Initial exit 1: accepted gatekeeper fixture referenced an uninstalled local dependency; retry exit 0 after the locked install below |
| `CI=true pnpm install --frozen-lockfile --filter forkhorse-gatekeeper...` | Exit 0; eight cached packages, no tracked changes |
| `CI=true pnpm exec vp lint packages/forkhorse-dashboard` | Exit 0; no findings |
| `git -c core.fsmonitor=false diff --check` | Exit 0 |

The usage DOM regression now checks state-owned clipping and tab-order exclusion
with real token figures present, and verifies opening the table restores controls
and retains those figures. Accepted graph tests cover compact cells, accessible
full text, earlier-event facts, starts, and main labels. Shared race-window Pushes
regressions still pass. The browser independently confirmed the closed table has
absolute positioning, 1 px width, `inset(50%)` clipping, and tab indexes of -1.
Opening restores table controls to 0. Visible cells retain times and concise check
status; full accessible labels retain event names. Dense earlier-event labels retain
all omitted event text and become focusable only when the table is open.

The fork-table capture was refreshed; collapsed-table and dense-history captures
were added. Other captures remain evidence from the preceding integration stages.
The latest checks are focused only; prior full-package tests/builds above describe
older candidate stages. Operator root/fresh-clone/D5/workerd checks, accepted FH-060
integration, FH-049 or FH-057c if accepted, Saddler PASS, and owner review remain open.
No publication, live account action, or Board edit occurred.

## FH-057c follow-up

After explicit resume and acceptance authority, the clean branch head remained
`594b51b5d4d914b51dac2e0cc01b30f92e8da57b` and fresh `origin/main` verified exactly
`05efc0a346a7e91d4f4e56b52eb4266f12475f5b`. These are the normal merge's two
parents. The accepted change applied without conflicts. The merged edge-label
filter drops centered hour labels without 24 px clearance at either plot edge,
while retaining every hour grid line. Tokens/Compare, shared race-window Pushes,
state-owned table clipping, compact cells, and accessible full event facts remain.

| Latest follow-up command | Result |
| --- | --- |
| `CI=true pnpm --filter forkhorse-dashboard exec node --import ./test/jsx-runtime.ts --test test/race.test.ts test/usage.test.ts test/fork-graph.test.ts` | Exit 0; 43 passed, 0 failed, including accepted edge-label regression |
| `CI=true pnpm --filter forkhorse-dashboard types:check` | Exit 0 |
| `CI=true pnpm exec vp lint packages/forkhorse-dashboard` | Exit 0; no findings |
| `git -c core.fsmonitor=false diff --cached --check` | Exit 0 |

This follow-up ran only the authorized affected tests, types, and scoped lint.
Existing captures describe earlier integration stages; no new browser, build,
root/fresh-clone/D5, workerd, live, publication, or Board work was performed.
FH-060 remains pending. FH-049 if it lands and the separate FH-057d state-dot
change require accepted-main authority before integration. Saddler PASS and
operator/owner acceptance remain open. No unaccepted feature branch was copied.

## FH-057d follow-up

The clean saved head was `761b777bf2c170fe0b6e6674d330458d157d2111`. Fresh
`origin/main` verified exactly `1749a394caa4f78b7fbf6a1645659e89e78e9b99` after
explicit accepted-main authority. The plain merge of `origin/main` has these two
parents, applied without conflicts, and used no rebase or feature-branch copying.
Accepted state captions and semantic dot tones remain distinct: failed checks use
danger, timed-out/infrastructure receipts use warning, review/running use info,
approved/promoted use success, and racing uses brand. Tokens/Compare, shared race
Pushes, edge-hour-label omission, and accepted graph accessibility fixes remain.

| Latest follow-up command | Result |
| --- | --- |
| `CI=true pnpm --filter forkhorse-dashboard exec node --import ./test/jsx-runtime.ts --test test/race.test.ts test/usage.test.ts test/fork-graph.test.ts` | Exit 0; 44 passed, 0 failed, including accepted state-dot/caption regression |
| `CI=true pnpm --filter forkhorse-dashboard types:check` | Exit 0 |
| `CI=true pnpm exec vp lint packages/forkhorse-dashboard` | Exit 0; no findings |
| `git -c core.fsmonitor=false diff --cached --check` | Exit 0 |

Only the authorized affected tests, types, and scoped lint ran. Existing captures
retain their earlier labeled fixture evidence; this follow-up adds no browser or
live acceptance claim. No root/fresh-clone/D5, workerd, publication, deployment,
Board edit, extra agent, or core change occurred. FH-060 remains pending; FH-049
only integrates after accepted-main authority if it lands. FH-062 Saddler PASS
and operator/owner acceptance remain open.

## Eight-item design return

The latest local follow-up starts at `08bbe827c5cb66f0edd8531a8a4d7c1ca697a690`.
See [return-1/README.md](return-1/README.md) for the eight changes, six new offline
captures, measured table/phone bounds, and latest 80-test commands/exits.
The preceding fifteen captures remain unchanged and describe earlier stages.

## Evidence cleanup

Per the operator return, all twenty-one tracked JPGs were copied to the external
bundle above before removal from the current tree. Both the expanded copies and
archive members matched the source-head bytes and SHA-256 manifest. Original
fifteen and new six-scene evidence are retained. No source, fixture, or test logic
changed, so UI checks were not repeated; the latest source checks remain those
at `6ce9674`. Cleanup checks verify the archive and staged scope. No history rewrite,
publication, live action, or unaccepted FH-060 integration occurred. FH-060 acceptance
remains required before the next plain-main integration. Other packet gates remain.

## Accepted FH-060 integration

Fresh `origin/main` verified exactly `f1910e6f571ed7359d30db37d3ddca86f9236803`
after explicit acceptance and normal-merge authority. The saved local first parent
is `d8befb64e9232c67a78044447aa8ec81445555c8`; accepted main is the second parent.
No rebase or feature-branch copying occurred. Five conflicts were confined to
`src/contracts.ts`, `src/fixture-main.ts`, `src/model.ts`, `src/view.tsx`, and
`test/fixture-api.ts`. Resolution combines usage and collision types/scenarios,
retains accepted pushing-fork collision gates and role-specific explanations,
and applies current entrant budget gating after the collision is resolved.
The queue keeps the eight-fix usage refusal in Actions only.

Accepted FH-049 collision UI and FH-050 archive contract arrive through accepted
main. Every path outside the dashboard matches accepted main exactly; no authored
core, runner, deployment, Board, or upstream change was made. The unchanged pin is
`8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf`. Accepted state dots and edge-hour labels,
shared passing-receipt Checks and race-window Pushes, source-separated ratios,
compact accessible figures, no full-tie caption, unbudgeted behavior, and phone
Compare layout retain the eight-fix source. A new regression checks that resolving
an accepted collision cannot bypass an over/unchecked current entrant budget.

| Latest command | Result |
| --- | --- |
| `CI=true pnpm --filter forkhorse-dashboard exec node --import ./test/jsx-runtime.ts --test test/race.test.ts test/usage.test.ts test/fork-graph.test.ts test/review.test.ts test/receipts.test.ts test/collisions.test.ts test/dashboard.test.ts test/needs-you.test.ts` | Exit 0; 120 passed, 0 failed |
| `CI=true pnpm --filter forkhorse-dashboard exec node --import ./test/jsx-runtime.ts --test test/usage.test.ts` | Exit 0; 16 passed, 0 failed after adding the combined gate regression; 121 unique affected tests across these runs |
| `CI=true pnpm --filter forkhorse-dashboard types:check` | Exit 0 after final regression |
| `CI=true pnpm exec vp lint packages/forkhorse-dashboard` | Exit 0 after final regression |
| `git -c core.fsmonitor=false diff --check` | Exit 0 |

The same literal-color scan above returned exit 1 with zero matches. Existing
fixture duplicate-project-key warnings remain. No heavy root/fresh-D5, workerd,
Saddler, live, publication, deployment, route migration, or Board work ran.
Those serialized operator/owner checks remain open. Reported upstream deployment
and live acceptance are coordinator evidence, not evidence produced by this branch.

Three refreshed JPGs remain external in `fh-062-fh060-integration-evidence.tar.gz`.
Archive SHA-256: `dc7dd8e389b4a21768961217d66f758266239760ed0f8f6b0007e7e4bc5ce79c`.
The operator handback supplies its local location. Unpack the basename, enter
`fh-062-fh060-integration-evidence`, and run `shasum -a 256 -c SHA256SUMS`.
All three expanded files and archive members were verified. This new bundle does
not replace the preserved original twenty-one-image bundle above.

| External filename | Offline integration evidence |
| --- | --- |
| unchecked-queue.jpg | Light docked queue, 1280 by 720; table client/scroll/wrapper each 880px, each refusal once in Actions |
| over-review.jpg | Dark over-budget detail; source/freshness segments, three milestone cells, no Promote |
| collision-review.jpg | Dark accepted collision detail; banner/actions coexist with explicit Not reported usage |

These captures were justified by the merged queue/detail gate and collision UI.
No browser API write occurred. The temporary tab closed, viewport reset, and
loopback server stopped (intentional SIGINT exit 130). Its initial sandbox bind
failed with EPERM (exit 1); the authorized loopback retry started successfully.

## Candidate changed paths

Complete current-tree candidate delta against accepted FH-060 main
`f1910e6f571ed7359d30db37d3ddca86f9236803`:

```text
packages/forkhorse-dashboard/README.md
packages/forkhorse-dashboard/src/contracts.ts
packages/forkhorse-dashboard/src/fixture-main.ts
packages/forkhorse-dashboard/src/fork-graph.tsx
packages/forkhorse-dashboard/src/model.ts
packages/forkhorse-dashboard/src/race-model.ts
packages/forkhorse-dashboard/src/race-usage.tsx
packages/forkhorse-dashboard/src/race.tsx
packages/forkhorse-dashboard/src/review.tsx
packages/forkhorse-dashboard/src/styles.css
packages/forkhorse-dashboard/src/usage.ts
packages/forkhorse-dashboard/src/usage.tsx
packages/forkhorse-dashboard/src/view.tsx
packages/forkhorse-dashboard/test/captures/fh-062/.gitignore
packages/forkhorse-dashboard/test/captures/fh-062/README.md
packages/forkhorse-dashboard/test/captures/fh-062/return-1/README.md
packages/forkhorse-dashboard/test/fixture-api.ts
packages/forkhorse-dashboard/test/race.test.ts
packages/forkhorse-dashboard/test/usage-fixtures.ts
packages/forkhorse-dashboard/test/usage.test.ts
```
