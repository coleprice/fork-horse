# FH-073 first-run capture matrix

All `empty-*` scenarios are synthetic loopback fixtures. They make no live
Cloudflare or Artifacts connection and are not evidence from a deployed instance.
Owner commands contain literal placeholders; Copy does not execute them.

Capture each row in light and dark at viewport width 1600:

| Scenario | Fragment | State |
| --- | --- | --- |
| `empty-projects` | `#overview` | No projects |
| `empty-agents` | `#agents` | Agents table replaced by enrollment guidance |
| `empty-agents` | `#overview` | Graph replaced by enrollment guidance |
| `empty-packets` | `#work` | No packets, including the race hint |
| `empty-packets` | `#overview` | Agents exist, no packets |
| `empty-forks` | `#overview` | Packets exist, no claim/fork history |
| `empty-reviews` | `#review` | No reviews, Go to Work |

Also capture `empty-agents&role=agent#agents` in dark at width 390: no command or
Copy control. Hide fixture controls before captures, retaining the fixture banner.
Check horizontal overflow at both widths. Compare one populated Overview against
Saddler's rehearsal frame; no populated content or shared graph styling changes
are authorized by this packet. Fixture `race-empty#race/race-01` and
`race-unknown#race/race-01` keep their distinct waiting/error messages.

This is the requested capture matrix, not a capture or PASS receipt. Captures,
fixture execution, full checks/D5 and Saddler's review require their recorded
lane and acceptance evidence before this candidate can be handed back for review.
