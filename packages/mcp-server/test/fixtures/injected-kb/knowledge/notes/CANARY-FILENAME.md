---
type: note
# The one alias without a canary: find_canonical matches a whole alias, and no probe may carry one.
aliases: ["filename probe"]
source: lines
last_verified_revision: "CANARY-REVISION rev1"
---

# CANARY-TITLE A page whose filename is the payload

CANARY-BODY The injected page links here, so this path reaches the tools that list pages. It cites the diffing source too, so the path reaches `check_drift` as a stale page and a citing one.[^CANARY-FOOTNOTE]

[^CANARY-FOOTNOTE]: lines @ rev1 · knowledge/notes/CANARY-FILENAME.md#CANARY-LOCATOR

CANARY-BODY
