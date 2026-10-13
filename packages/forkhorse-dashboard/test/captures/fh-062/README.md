# FH-062 synthetic browser captures

These screenshots use the loopback fixture API and the real dashboard components.
They are local browser evidence, not live account, Cloudflare, workerd, D5,
Saddler, or owner acceptance. Desktop viewport: 1280 by 720; phone: 390 by 844.
Full-page captures show content beyond the viewport; horizontally scrolling tables
show their initial scroll position. Theme controls were hidden through the fixture UI.

| File | Fixture route | Evidence |
| --- | --- | --- |
| race-light.jpg | `?scenario=usage-race#work` | Separate source labels, 42%/82%/over-budget meters, facts-only Compare |
| race-dark.jpg | `?scenario=usage-race#work` | Same facts under dark host tokens |
| agent-over-review.jpg | `?scenario=usage-over&role=agent#review/usage-review-2` | Read-only agent sees the automatic rejection caption and no owner controls |
| over-review.jpg | `?scenario=usage-over#review/usage-review-2` | Usage snapshot, three milestone cells, over-budget caption and no Promote |
| unchecked-queue.jpg | `?scenario=usage-unchecked#review` | Conditional Tokens column, Not reported, missing-report promotion caption |
| agents-both-sources.jpg | `?scenario=usage-both#agents` | Separate reported/metered totals and cumulative-window explanation |
| phone-agent-race.jpg | `?scenario=usage-unchecked&role=agent#work` | Read-only phone, unchecked warning, horizontal race/Compare tables |
| phone-agent-totals.jpg | `?scenario=usage-both&role=agent#agents` | Totals fold beneath agent names on narrow screens |
| fork-table.jpg | `?scenario=usage-race#overview` | Expanded table twin includes Tokens; graph labels contain no figures |

The source fixture also covers legacy records, metered precedence, zero reports,
80%/100%/over boundaries, snapshot deduplication, missing review-detail capability,
immutable snapshots versus current budget state, and unchanged Needs you kinds.

## Focused checks

Base: `cc71fff99bf72434978ad297329a8a9f05ef6aea` (freshly fetched `origin/main`).
Branch: `fh/FH-062-usage-ui`. No feature-branch copying or integration merge.
Pinned upstream unchanged: `8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf`.

| Command | Result |
| --- | --- |
| `CI=true pnpm --filter forkhorse-dashboard test` | Exit 0; 86 passed, 0 failed; includes 11 new usage tests |
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

Open gates: accepted FH-060/FH-055 and overlapping FH-049 integration; serialized
root test/lint, fresh clone/D5, host workerd checks; Saddler PASS and owner review.
The package is a static client, so its DOM tests do not claim Worker runtime acceptance.

## Candidate changed paths

- `packages/forkhorse-dashboard/README.md`
- `packages/forkhorse-dashboard/src/contracts.ts`
- `packages/forkhorse-dashboard/src/fixture-main.ts`
- `packages/forkhorse-dashboard/src/fork-graph.tsx`
- `packages/forkhorse-dashboard/src/model.ts`
- `packages/forkhorse-dashboard/src/race-usage.tsx`
- `packages/forkhorse-dashboard/src/review.tsx`
- `packages/forkhorse-dashboard/src/styles.css`
- `packages/forkhorse-dashboard/src/usage.ts`
- `packages/forkhorse-dashboard/src/usage.tsx`
- `packages/forkhorse-dashboard/src/view.tsx`
- `packages/forkhorse-dashboard/test/captures/fh-062/README.md`
- `packages/forkhorse-dashboard/test/captures/fh-062/agent-over-review.jpg`
- `packages/forkhorse-dashboard/test/captures/fh-062/agents-both-sources.jpg`
- `packages/forkhorse-dashboard/test/captures/fh-062/fork-table.jpg`
- `packages/forkhorse-dashboard/test/captures/fh-062/over-review.jpg`
- `packages/forkhorse-dashboard/test/captures/fh-062/phone-agent-race.jpg`
- `packages/forkhorse-dashboard/test/captures/fh-062/phone-agent-totals.jpg`
- `packages/forkhorse-dashboard/test/captures/fh-062/race-dark.jpg`
- `packages/forkhorse-dashboard/test/captures/fh-062/race-light.jpg`
- `packages/forkhorse-dashboard/test/captures/fh-062/unchecked-queue.jpg`
- `packages/forkhorse-dashboard/test/fixture-api.ts`
- `packages/forkhorse-dashboard/test/usage-fixtures.ts`
- `packages/forkhorse-dashboard/test/usage.test.ts`
