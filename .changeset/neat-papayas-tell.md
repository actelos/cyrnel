---
"@cyrnel/web": minor
---

Add registry install tabs and split update buttons to web UI

- **Module/Service install popovers**: replaced single-form popovers with
  tabbed Manual/Registry install. Manual tab sends `POST /{type} { url }`;
  Registry tab sends `POST /{type}/install { source }`.
- **Update buttons**: replaced single Update button with a split button +
  dropdown. Registry-managed items show "Check for update" (fetches registry,
  compares hashes, confirms before applying) with a "Manual update" dropdown
  option. Direct-installed items show "Manual update" that opens a URL input
  popover.
- **Update indicator dot**: detail pages display an amber dot when the
  registry hash differs from the stored hash, re-checked every 2 minutes.
