# FH-062 design return: eight fixes, local fixture evidence

The six capture filenames below are external evidence in `fh-062-token-usage-evidence-6ce9674.tar.gz`,
under `fh-062/return-1/`. See [the bundle instructions](../README.md#evidence-location).
They are retained outside Git along with the preceding fifteen captures.

This follow-up starts at `08bbe827c5cb66f0edd8531a8a4d7c1ca697a690` on
`fh/FH-062-usage-ui`. Accepted-main ancestry remains
`1749a394caa4f78b7fbf6a1645659e89e78e9b99`; no merge was needed. The FH-060
contract remains an optional fixture projection, pending accepted implementation.

The eight returned items are addressed:

1. Budgeted usage prints one ratio figure per source, then the selected source's
   meter/state, then freshness. Reported and metered remain separate.
2. Within budget is a plain caption without a dot; warning/danger words and dots
   remain for unchecked/near/over states.
3. Full figures keep their segments unbreakable. Freshness starts its own line
   with `as of`, without a leading separator. Review split segments wrap together.
4. Compare and Results share `entrantChecks`: passing receipts out of the entrant's
   receipts. A three-check passed receipt plus one failed receipt reads `1 of 2`
   in both tables, rather than `3 of 3` in Compare.
5. Full ties show no fastest/fewest caption. Distinct minima retain neutral captions.
6. Queue usage refusals appear once, only in Actions. Compact usage cells show
   number/source, with exact totals, input/output, model, freshness and source
   disclaimer in the Tooltip. Requested/receipt metadata folds into State when
   the docked pane is narrow; the visible columns use the available width.
7. The graph table uses the same compact cell and reserves width for Tokens.
   Closed-table compact controls stay outside keyboard tab order.
8. Phone Compare stacks by fact, with a saddlecloth/name and value per entrant.
   The table header remains available to accessibility tools.

Unbudgeted races still have no budget state or usage prerequisite; missing usage
still reads Not reported. Core's promotion refusal words are unchanged. Both roles
retain factual Compare and the agent view remains read-only. Agents' cumulative
window explanation is retained. The graph-caption clamp was left outside scope.

## Six requested offline scenes

All images use loopback fixtures and the real dashboard source components, not a
live account, production bundle, Cloudflare, workerd, D5, Saddler or owner acceptance.
Desktop viewport is 1280 by 720, phone is 390 by 844. Full-page captures include
content below the viewport. Fixture controls were hidden through their UI.
The preceding fifteen JPG captures remain untouched as historical evidence.

| Capture | Route and host state | Recheck |
| --- | --- | --- |
| `race-light.jpg` | `?scenario=usage-race#race/FH-040`, light | One ratio figure; meter/state/freshness; both tables show `1 of 1`; files `4/4/4` have no best caption |
| `race-dark.jpg` | Same route, dark | Same source labels and boundary words with host semantic colors |
| `unchecked-queue.jpg` | `?scenario=usage-unchecked#review`, light, activity panel open | One refusal per affected row in Actions, compact figures and fully visible Promote |
| `over-review.jpg` | `?scenario=usage-over#review/usage-review-2`, light, activity panel open | Split segments stay together; separate freshness; core caption retained and Promote absent |
| `fork-table.jpg` | `?scenario=usage-race#overview`, light, activity panel open, table expanded | Compact source figures fit within the card; full details remain in the Tooltip/accessibility label |
| `phone-agent-race.jpg` | `?scenario=usage-unchecked&role=agent#race/FH-040`, light, 390 px | Fact blocks contain three entrant lines, without horizontal scrolling or owner actions |

Read-only browser measurements:

- Queue wrapper/table/scroll widths are all 880 px. Promote's right edge is
  about 837 px, inside the table's 920 px right edge. The page width is 1280 px.
- Graph table client/scroll widths are both 848 px. All compact figure right edges
  are about 854 px, inside the card's 920 px right edge.
- At 390 px the page scroll width is 390 px; Compare wrapper/client/scroll widths
  are all 366 px. All five fact rows are blocks, each with three entrant lines;
  budget figures fit inside their cells. No Approve/Promote controls are present.
- Desktop race Tokens cells are 220 px wide, with 200 px figures/meters inside.
  Review's three split segments share the same vertical position at 1280 px.

## Focused checks

| Command | Exit and evidence |
| --- | --- |
| `CI=true pnpm --filter forkhorse-dashboard exec node --import ./test/jsx-runtime.ts --test test/race.test.ts test/usage.test.ts test/fork-graph.test.ts test/review.test.ts test/receipts.test.ts` | 0; 80 passed, 0 failed |
| `CI=true pnpm --filter forkhorse-dashboard types:check` | 0 |
| `CI=true pnpm exec vp lint packages/forkhorse-dashboard` | 0; no findings after a test assertion used the preferred `startsWith` spelling |
| `git -c core.fsmonitor=false diff --check` | 0 |

Literal-color scan, host palette excluded: zero matches, expected rg exit 1.

```sh
rg -n '#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|color)\(' \
  packages/forkhorse-dashboard/src --glob '!host-tokens.json'
```

The fixture suite retains its existing duplicate project-key warnings. No heavy
root test/lint, fresh-clone/D5, workerd, publication, deployment, Board mutation,
core change, or extra agent occurred. Open gates remain accepted FH-060 integration,
FH-049 only if accepted, serialized operator checks, FH-062 Saddler PASS and owner review.

## This follow-up

Changed paths against the saved head above:

```text
packages/forkhorse-dashboard/README.md
packages/forkhorse-dashboard/src/fork-graph.tsx
packages/forkhorse-dashboard/src/race-model.ts
packages/forkhorse-dashboard/src/race-usage.tsx
packages/forkhorse-dashboard/src/race.tsx
packages/forkhorse-dashboard/src/review.tsx
packages/forkhorse-dashboard/src/styles.css
packages/forkhorse-dashboard/src/usage.tsx
packages/forkhorse-dashboard/src/view.tsx
packages/forkhorse-dashboard/test/captures/fh-062/README.md
packages/forkhorse-dashboard/test/captures/fh-062/return-1/README.md
packages/forkhorse-dashboard/test/captures/fh-062/return-1/fork-table.jpg
packages/forkhorse-dashboard/test/captures/fh-062/return-1/over-review.jpg
packages/forkhorse-dashboard/test/captures/fh-062/return-1/phone-agent-race.jpg
packages/forkhorse-dashboard/test/captures/fh-062/return-1/race-dark.jpg
packages/forkhorse-dashboard/test/captures/fh-062/return-1/race-light.jpg
packages/forkhorse-dashboard/test/captures/fh-062/return-1/unchecked-queue.jpg
packages/forkhorse-dashboard/test/race.test.ts
packages/forkhorse-dashboard/test/usage.test.ts
```
