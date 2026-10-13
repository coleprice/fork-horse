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
| fork-table.jpg | `?scenario=usage-race#overview` | Expanded table twin includes Tokens; graph labels contain no figures |

The source fixture also covers legacy records, metered precedence, zero reports,
80%/100%/over boundaries, snapshot deduplication, missing review-detail capability,
immutable snapshots versus current budget state, and unchanged Needs you kinds.

## Focused checks

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

The latest source is tested against fixtures for the fixed FH-060 contract only.
The FH-060 implementation has not been accepted or merged into this candidate.

## Candidate changed paths

Complete candidate delta against the accepted FH-055 base above:

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
packages/forkhorse-dashboard/test/captures/fh-062/fork-table.jpg
packages/forkhorse-dashboard/test/captures/fh-062/over-review.jpg
packages/forkhorse-dashboard/test/captures/fh-062/phone-agent-race.jpg
packages/forkhorse-dashboard/test/captures/fh-062/phone-agent-totals.jpg
packages/forkhorse-dashboard/test/captures/fh-062/photo-finish-integration.jpg
packages/forkhorse-dashboard/test/captures/fh-062/race-dark.jpg
packages/forkhorse-dashboard/test/captures/fh-062/race-light.jpg
packages/forkhorse-dashboard/test/captures/fh-062/unbudgeted-promote.jpg
packages/forkhorse-dashboard/test/captures/fh-062/unbudgeted-race.jpg
packages/forkhorse-dashboard/test/captures/fh-062/unchecked-queue.jpg
packages/forkhorse-dashboard/test/fixture-api.ts
packages/forkhorse-dashboard/test/race.test.ts
packages/forkhorse-dashboard/test/usage-fixtures.ts
packages/forkhorse-dashboard/test/usage.test.ts
```
