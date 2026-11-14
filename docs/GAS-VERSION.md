# Gmail Filter Builder — Google Apps Script version (sketch)

Status: design sketch, 2026-11-14. **Not built.** The static Pages site stays
as-is; this is a second deployment for people who want live Gmail read/write
with Google-native sign-in, no OAuth client to set up.

## Verdict

Yes, it fits. The Gmail API exposes `users.settings.filters` with list, get,
create, and delete, and Apps Script's Advanced Gmail Service exposes the same
calls (`Gmail.Users.Settings.Filters.list('me')`, `.create(filter, 'me')`).
The built-in `GmailApp` cannot touch filters — the Advanced service is
required. The app's model already maps 1:1 onto Gmail's filter format (the
import path parses it), so the port is mostly a new data source, not a new
app.

## The shape: two deployments, one page

- **Static site (now):** build + export XML, no sign-in, nothing leaves the
  browser. Unchanged.
- **GAS web app (new):** the same page, served by the HTML service, plus two
  buttons — **Load from Gmail** and **Sync to Gmail**. The page detects GAS
  mode (`typeof google !== "undefined" && google.script && google.script.run`)
  and hides those buttons on the static site.

## The sync model (recommended): draft, then sync

The local list stays the working copy (localStorage, as now). Sync is
explicit:

1. **Load from Gmail** — API `list` replaces the local list. If Gmail returns
   nothing, the empty state appears; **Load examples** still works, and
   examples stay local drafts — the `example` flag excludes them from sync,
   exactly as it excludes them from export.
2. **Sync to Gmail** — diff local vs server: create filters with no `gmailId`,
   delete server filters missing locally, recreate edited ones (there is no
   update endpoint — edit is delete + create).

Why not live-edit (every Add/Edit/Delete calling the API immediately)? It
preserves the current UX, gives a review step before anything changes in
Gmail, keeps reorder meaningful locally, and keeps each server call small.
Live-edit is simpler to explain but has no undo, no review, and every save is
a round trip.

## Mapping: app model ↔ Gmail API Filter resource

Criteria use the same names as the XML properties (`from`, `to`, `subject`,
`query` for hasTheWord, `negatedQuery`, `hasAttachment`, `excludeChats`).
Actions convert — the API has no `should*` booleans, only label IDs:

| App action | API action |
|---|---|
| Skip the Inbox | `removeLabelIds: ['INBOX']` |
| Mark as read | `removeLabelIds: ['UNREAD']` |
| Star it | `addLabelIds: ['STARRED']` |
| Delete it | `addLabelIds: ['TRASH']` |
| Never send to Spam | `removeLabelIds: ['SPAM']` |
| Always mark as important | `addLabelIds: ['IMPORTANT']` |
| Never mark as important | `removeLabelIds: ['IMPORTANT']` |
| Apply a label | `addLabelIds: ['<label id>']` — resolved from the name via `users.labels.list`, created if missing |
| Categorize as | `addLabelIds: ['CATEGORY_PERSONAL' / 'CATEGORY_SOCIAL' / 'CATEGORY_PROMOTIONS' / 'CATEGORY_UPDATES' / 'CATEGORY_FORUMS']` |
| Forward it to | `forward: '<address>'` — must already be a verified forwarding address or create fails |

Three gotchas:

- **One user label per filter via the API.** The app supports multiple labels
  per filter; the API allows one. On sync, decide: warn, split into one
  filter per label, or drop the extras. (Warn is the honest default.)
- **No backfill.** The API cannot apply a filter to existing mail — the
  import dialog's "Also apply filter to matching conversations" checkbox is
  Gmail-UI-only.
- **Reorder has no API meaning.** Gmail applies filters in creation order, so
  drag reorder in GAS mode is display-only. (Storing the order in
  `PropertiesService` is possible, but probably not worth it.)

## Files

Standalone Apps Script project (not container-bound — it's a web app, not a
Sheet add-on):

- `Code.gs` — server functions (below).
- `index.html` — the page, lightly adapted (GAS detection, `gmailId`
  tracking, the two new buttons).
- `appsscript.json` — manifest: scopes, web-app settings, Advanced service.

```json
{
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/gmail.labels"
  ],
  "webapp": { "access": "ANYONE", "executeAs": "USER" },
  "dependencies": {
    "enabledAdvancedServices": [
      { "userSymbol": "Gmail", "version": "v1", "serviceId": "gmail" }
    ]
  }
}
```

## Server (`Code.gs`) — sketch

```js
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Gmail Filter Builder');
}

function listFilters() {
  var res = Gmail.Users.Settings.Filters.list('me');
  return res.filter || [];
}

function ensureLabel(name) {
  var labels = Gmail.Users.Labels.list('me').labels || [];
  for (var i = 0; i < labels.length; i++)
    if (labels[i].name === name) return labels[i].id;
  return Gmail.Users.Labels.create({ name: name }, 'me').id;
}

// createFilter(model): map the app's filter to the API Filter resource
// (criteria as-is, actions via the table above, label names resolved
// through ensureLabel), create it, return the server-assigned id.
// deleteFilter(id): Gmail.Users.Settings.Filters.remove('me', id).
// syncFilters(local): diff local vs listFilters() and apply the creates /
// deletes / recreates in batches of ~50 per call (6-minute limit).
```

## Client changes

- `GAS` shim: `google.script.run` when present, `null` on the static site.
- Track `gmailId` per filter (server-assigned id, persisted in localStorage);
  local-only filters have none.
- `Load from Gmail` / `Sync to Gmail` call the server with
  `withSuccessHandler` / `withFailureHandler`, with a working state and toast
  progress; sync maps returned ids back onto the local filters.
- XML export/import stays untouched — it remains the no-auth path and the way
  to move filters between accounts.

## Auth: what a first-time user sees

1. Open the web app URL → Google account chooser.
2. **Only if the script is unverified:** "Google hasn't verified this app" →
   Advanced → "Go to gmail-filter-builder (unsafe)".
3. Permission screen: "See, edit, create and delete your Gmail filters" and
   "See and edit your Gmail labels" → Allow.
4. The app loads with their live filters.

Deploy as **Execute as: User accessing the web app**, **Who has access:
Anyone**, so each visitor's own filters load and the script never sees their
password. Unverified apps are capped at 100 users until verification (privacy
policy, domain, review) — fine for personal use, a real hurdle for a public
post.

## Gaps & verification items

- Category `CATEGORY_*` values and size semantics (API size is bytes with
  `larger`/`smaller`) — confirm against the live discovery doc before
  building.
- Multi-label decision (warn / split / drop) — see above.
- Google Fonts inside the HTML service — verify they load; self-host as the
  fallback (already an open item for the static site).
- 6-minute execution limit — batch syncs with progress toasts.
- `list` returns filters in creation order; there is no order field.

## Build order (spike)

1. Standalone script + manifest + `doGet` serving the page unchanged;
   read-only spike: **Load from Gmail** only.
2. Mapping + list rendering; verify categories/sizes against a real account.
3. Create + delete; then the sync diff; then labels.
4. Unverified-app screen walkthrough on a second account; decide on
   verification before sharing the link widely.
