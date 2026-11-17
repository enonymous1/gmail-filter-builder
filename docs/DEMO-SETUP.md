# Recording the YouTube tutorial — demo setup

Companion to `../gmail-filter-builder-youtube-tutorial.md` (the 7:45
plan/script). This file is the ground truth for what is actually
demonstrable, verified live against this repo on 2026-11-17. Where the
script and the tool disagree, the tool wins — the corrections are
listed at the bottom.

## Recording setup

- **Tool:** open `index.html` from this repo (or the Pages URL) in a
  **fresh browser profile** so `localStorage` starts empty and the 5
  starter examples show. Light theme reads best on camera; the toolbar
  theme button flips it, and the choice persists.
- **Reset between takes:** clear site data for the page (or use a new
  profile). That restores the 5 starters. Re-importing
  `demo/demo-filters.xml` restores the power-tools list.
- **Order matters:** record 0:00–4:20 on the starters first. Importing
  the demo file replaces the starters, so the 5:10 scenes need it and
  the earlier scenes need it gone.
- **Filenames:** the tool downloads `gmail-filters.xml`. Gmail's own
  export is `mailFilters.xml`. They are the same Atom format with
  different names — don't mix them up on camera.

## Scene-by-scene: how to get each state

| Script | State on screen | How to get there (verified) |
| --- | --- | --- |
| 0:00 Hook | Messy Gmail search string | **Do not type this into real Gmail** — autocomplete would show real senders. Use the mock inbox (`gmail-mock-inbox`, `gmail-mock serve`): type `from:(facebookmail.com OR twitter.com) has:unsubscribe -urgent larger:10M` in its search bar. It matches the pinned msg-0025 (Facebook) and msg-0026 (Twitter) and excludes msg-0027 (subject says URGENT). |
| 0:35 Promise | Hero + 4-step How it works | Tool homepage. Headline reads "Gmail filters, filled out — not decoded from Settings." The NO OAUTH / NO SERVER overlays are added in editing, not page text. |
| 1:05 Tour | 5 templates, 5 starters, toolbar | Fresh load. Templates left→right: Newsletters, Receipts & invoices, Social notifications, Big attachments, VIP sender. Toolbar (9 buttons): New filter, Import Filters, Clear all, Security check, Merge Similar, Missing labels, Copy XML, Download .xml, theme. The `n / 1000` counter is **not** in the toolbar — it sits in the row above the list, Cards/Table left, count right. Fresh load reads `0 / 1000` because starters are examples and never count toward the export. |
| 1:50 Demo 1 | Newsletters filter built live | Click the Newsletters template. The builder opens pre-filled: Has the words `unsubscribe`, Skip the Inbox + Mark as read + Apply a label `Newsletters` already checked, live preview reads `(unsubscribe)`. Narrate them as pre-filled, not as steps to check. Click Add filter; the card appears. |
| 3:20 Demo 2 | Big attachments + VIP sender, blank-filter error | New filter → name `Large mail`, Size Larger than `10` MB, Star it, label `Large attachments`; preview reads `larger:10M`. VIP sender template: From is empty and focused; type a sender. It also pre-checks **Star it** alongside Never send to Spam + Always mark as important — mention it or the take shows it checked. Blank filter: click Add with nothing filled. The error is **not** the script's line — see correction 1. |
| 4:20 Manage | Search, pills, Cards/Table, edit/duplicate/delete | Search box: type `receipt` — matches the Receipts starter (name + label `Finance/Receipts`). Filter by action pill: Skip the Inbox. Cards ↔ Table toggle; table columns are # / Name / Matches / Actions / Edit Duplicate Delete. Edit a card, change the label, Save changes. Duplicate a card, then Delete the copy — the confirm reads "Delete this filter? This can't be undone." Export order never changes. |
| 5:10 Power tools | Security check, Merge Similar, Missing labels | **Requires the demo file — the starters cannot produce any of these states.** Import `demo/demo-filters.xml` (Import Filters → drop the file or paste it). It brings 18 filters and the starters are removed. Security check reads `2 high · 2 medium — 18 filters checked`: High = forwards to `outside@example.net`, match-all "Untitled filter / Matches all mail and deletes it"; Medium = bank delete, Never Spam + Skip Inbox. View opens each in the editor. Merge Similar reads `3 mergeable groups (frees 6 slots) · 1 duplicate set (frees 1 slot)`: group 1 is mail8 / mail4 / notifications5 `@creditkarma.com` → one explicit OR, **Frees 2 slots** in bold; group 2 is mail1 / mail2 / mail3 / savings1, Frees 3. The third group is the Amazon duplicate pair showing as a merge as well — skip it on camera and use Keep one under Exact duplicates. Missing labels reads `5 filters without a label (4 with a suggestion)`: Spotify, Netflix, **Creditkarma**, Github, plus one senderless row with no suggestion. Click Apply on the Creditkarma row. |
| 6:05 Round trip | Preview XML → Download → Import into Gmail | Expand **Preview the export file** (a collapsed panel under the list) and scroll the XML: `<feed>`, `<entry>`, `shouldArchive`. Download .xml saves `gmail-filters.xml`. **The Gmail half needs a real Gmail account and cannot be faked here.** Use a throwaway account, never the real one: gear → See all settings → Filters and Blocked Addresses → Import filters → choose the file → Create filters. Tick "Also apply filter to matching conversations" to clean up existing mail. If recording in script order, the exported file contains the 18 demo filters — harmless fake data, and importing them into the throwaway account is the honest round trip. |
| 7:15 Recap | Import existing filters | Import Filters dialog: drop zone + browse + paste-XML box ("Import pasted XML"). Autosave is `localStorage` in that browser only; the XML download is the durable copy. |

## The demo file

`demo/demo-filters.xml` — 18 filters, Gmail's own `mailFilters.xml`
format. Importing it replaces the starters. It is a recording prop:
brand domains are used only so the dialogs show the scripted names.

- Merge groups use **label-only / label+star actions, no Skip
  Inbox**, on purpose: the security heuristic flags any skip/trash
  filter whose sender contains a sensitive word, and "credit" appears
  in "creditkarma.com" — with Skip Inbox, all 7 Credit Karma filters
  would show as Medium "mail matching 'credit'" and drown the
  security scene. The merge mechanic is identical either way.
- The match-all delete entry (no criteria, only `shouldTrash`) imports
  because of a fix in this repo: the importer used to skip
  no-criteria entries, which meant the security check's match-all rule
  could never fire. It now accepts entries with actions but no
  criteria; only entries with neither are skipped. The card shows
  Matches: "All mail".
- The "91 groups freed 177 slots" line in the script is the real run
  against the author's 1,000-filter list, not the demo file — the demo
  frees 6 + 1. Keep the narration; don't present the demo's numbers
  as the real test's.

## Script corrections (tool wins)

1. **3:20, blank-filter error.** The script quotes "Fill in at least
   one match and one action." The tool actually shows both problems
   joined: "Add at least one match first — a sender, a subject, some
   words, an attachment, or a size. Tick at least one action — what
   should Gmail do with matching mail?" (That script line is the
   hero sub-heading, not the error.) Read the real text or show it
   on screen without quoting it.
2. **3:20, VIP sender.** The template also pre-checks Star it.
   Script says only Never send to Spam + Always mark as important.
3. **1:05, counter.** The `n / 1000` counter is in the row above
   the list, not in the toolbar. Point there.
4. **1:50, Demo 1.** The Newsletters template pre-checks Skip the
   Inbox, Mark as read, and the Newsletters label. Narrate them as
   pre-filled.
5. **0:00, hook string.** Verify `has:unsubscribe` in real Gmail
   before recording: Gmail has no documented `has:unsubscribe`
   operator — the working form is the bare word `unsubscribe`, which
   is what the Newsletters template uses. The mock inbox treats
   `has:<word>` as a word search, so the string works there either
   way. If it matches nothing in real Gmail, that is the demo's
   point — but don't call it a working filter string.
6. **6:05, Gmail checkbox.** "Also apply filter to matching
   conversations" is Gmail's wording — confirm the exact label when
   the import dialog is on screen; it is not verifiable from here.
