# FH-062 synthetic browser captures

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

## Candidate changed paths

Complete candidate delta against accepted FH-057c main `05efc0a346a7e91d4f4e56b52eb4266f12475f5b`:

```text
packages/forkhorse-dashboard/README.md
packages/forkhorse-dashboard/src/contracts.ts
packages/forkhorse-dashboard/src/fixture-main.ts
packages/forkhorse-dashboard/src/fork-graph.tsx
packages/forkhorse-dashboard/src/model.ts
packages/forkhorse-dashboard/src/race-usage.tsx
packages/forkhorse-dashboard/src/race.tsx
packages/forkhorse-dashboard/src/review.tsx
packages/forkhorse-dashboard/src/styles.css
packages/forkhorse-dashboard/src/usage.ts
packages/forkhorse-dashboard/src/usage.tsx
packages/forkhorse-dashboard/src/view.tsx
packages/forkhorse-dashboard/test/captures/fh-062/README.md
packages/forkhorse-dashboard/test/captures/fh-062/agent-over-review.jpg
packages/forkhorse-dashboard/test/captures/fh-062/agents-both-sources.jpg
packages/forkhorse-dashboard/test/captures/fh-062/fork-history-integration.jpg
packages/forkhorse-dashboard/test/captures/fh-062/fork-table-collapsed.jpg
packages/forkhorse-dashboard/test/captures/fh-062/fork-table.jpg
packages/forkhorse-dashboard/test/captures/fh-062/over-review.jpg
packages/forkhorse-dashboard/test/captures/fh-062/phone-agent-race.jpg
packages/forkhorse-dashboard/test/captures/fh-062/phone-agent-totals.jpg
packages/forkhorse-dashboard/test/captures/fh-062/photo-finish-integration.jpg
packages/forkhorse-dashboard/test/captures/fh-062/race-dark.jpg
packages/forkhorse-dashboard/test/captures/fh-062/race-light.jpg
packages/forkhorse-dashboard/test/captures/fh-062/reused-forks-pushes.jpg
packages/forkhorse-dashboard/test/captures/fh-062/unbudgeted-promote.jpg
packages/forkhorse-dashboard/test/captures/fh-062/unbudgeted-race.jpg
packages/forkhorse-dashboard/test/captures/fh-062/unchecked-queue.jpg
packages/forkhorse-dashboard/test/fixture-api.ts
packages/forkhorse-dashboard/test/race.test.ts
packages/forkhorse-dashboard/test/usage-fixtures.ts
packages/forkhorse-dashboard/test/usage.test.ts
```
