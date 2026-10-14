# FH-079 source checkpoint and pending evidence

This directory is a capture plan, not captured or accepted evidence. Source and
fixtures were authored from `c2114b97a320047e1c360306436e6828d812a670` on the
packet branch. Heavy validation and captures are held until a fresh named grant.

The controller separates owner-write `busy` from read `refreshing`. A complete
state/activity read records an ISO `updatedAt`. Failed reads retain that snapshot
and its activity, mark it stale and reject all owner handlers. A normal read does
not disable actions; a write invalidates any older pending read before starting.
Existing review, receipt, authorization and confirmation bindings still apply.

The tab-row stamp reuses `relativeTime`, updates every 30 seconds and has no
seconds counter. Failed reads retain their timestamp while a retry is pending.
Stale controls stay visible with a focusable tooltip. Agent owner controls stay
hidden. Review detail adds the approved slow-read explanation after 3 seconds,
uses plain failure copy with a default-size secondary Try again only for retryable
errors, and shows only a bounded response UUID to owners. A 404 has no retry
button. Raw detail response bodies never reach the view.

## Lean capture plan (pending; supersedes the original matrix)

The 12:26 design ruling supersedes the earlier larger capture request. Capture
only the five cases below, with the stamp in light mode at width 1600. All cases
use the labeled offline fixture entry. No live account is contacted.
No fixture or production endpoint was added. The freshness fixture adapter wraps
existing review fixture routes, with read delays/errors only in the fixture build.

| Scenario | Fixture URL suffix | Evidence required |
| --- | --- | --- |
| Successful populated snapshot | `fixtures.html?scenario=review-current#review` | Stamp, exact-time tooltip; populated content geometry unchanged |
| Read in flight | `fixtures.html?scenario=freshness-refreshing#review` | Existing data and enabled actions, Refreshing… in tab row, no spinner or live region |
| Failed read | `fixtures.html?scenario=freshness-failed#review` | Retained data/time, "Couldn't refresh. Last updated {age}.", ghost sm Try again, disabled Approve with its tooltip open |
| Slow review | `fixtures.html?scenario=freshness-slow-review#review/review-1` | Initial Loading review…; approved caption after 3 seconds; completed detail after 15 seconds |
| Failed review (owner) | `fixtures.html?scenario=freshness-review-error#review/review-1` | Plain error/caption, diagnostic ID, default-size secondary Try again |

Retained-data fixture scenarios initiate their second read after one second. The
in-flight scenario releases after 30 seconds. The failed-read and failed-review
scenarios fail once; Try again succeeds. The fixture suite still covers owner
write guards, open confirmations, fresh-read recovery and agent hiding; these
cases do not expand the lean capture request. The live-paused banner now reads
"Live updates paused. Last updated {age}."

## Validation gates (all pending)

- Dashboard fixture suite, including `test/freshness.test.ts`, and dashboard types.
- Root `pnpm test` and `pnpm lint`, with lint zero; touched-package checks.
- Fresh-clone suite plus D5 following `docs/receipts.md` offline isolation.
- UI captures, geometry comparison, Saddler PASS and any requested re-shoot.
- Coordinator reconciliation of shared dashboard/controller/style/test files
  with FH-073/074/075/078 before integration.
- Publication and main integration remain separately gated.

No install, test, typecheck, lint, build, D5, browser capture, live access,
deployment, cross-merge or upstream edit was performed for this checkpoint.
