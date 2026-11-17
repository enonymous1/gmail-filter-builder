# Staff Review — Gmail Filter Builder

**Reviewer role:** staff software engineer / open-source maintainer
**Date:** 2026-11-13
**Scope:** `index.html` (905 lines, 53,856 bytes), `README.md`, `LICENSE`, `.nojekyll`
**Commit reviewed:** `acd21c0` ("Initial commit: Gmail Filter Builder"), single commit on `main`
**Method:** read the whole file end to end; verified counts with `grep`/`wc` (11 `innerHTML` uses, 0 `localStorage`/`sessionStorage` references, 0 `console.` calls, no `.github/`, no test files, no `package.json`); checked the XML mapping against the project's own verified source of truth, `gmail-forensic-toolkit` (`src/gmail_toolkit/cli/filters.py`: `_parse_xml_entry`, `_filter_properties`, `filters_to_xml`).

## Verdict

This is a good v1. The hard part — the Gmail XML contract — is right: export uses `shouldArchive` and `size` + `sizeOperator` + `sizeUnit`, the feed/entry IDs match Gmail's export, values are escaped with `escXml()`, and the importer accepts the old (wrong) names as a fallback. The UI is genuinely usable, the theming is solid, and the no-backend constraint is honoured throughout.

What would stop me approving this as a maintainer is not the format, it is the missing safety net around it: **there is no persistence, no test, no 1,000-filter guard, and the import path silently drops data** (multi-label filters, `excludeChats`). A user who builds 40 filters, refreshes the tab, and loses them all will not care that the XML was correct. Fix the P0s first, in the order listed. Do not add features until they land.

**Severity key:** P0 — data loss or a wrong export; fix before promoting the repo. P1 — a real bug or a maintainability trap that will bite on the next change. P2 — polish / future-proofing.

| # | Finding | Severity |
|---|---------|----------|
| F1 | No persistence — refresh wipes the whole list | P0 |
| F2 | No 1,000-filter guard, although the README cites the limit | P0 |
| F3 | Import drops multi-label filters and `excludeChats` | P0 |
| F4 | Validation gaps: size, email, empty label/forward, duplicates | P1 |
| F5 | `searchQuery()` wraps every term in parens; semantics drift from Gmail | P1 |
| F6 | `render()` rebuilds the entire DOM and re-attaches thousands of listeners | P1 |
| F7 | `innerHTML` string-building (11 uses) is the XSS pattern waiting for data | P1 |
| F8 | Silent `catch(){}` blocks, no `FileReader.onerror`, copy toast can lie | P1 |
| F9 | DRY violations: size-unit and category mappings repeated in 3 places | P1 |
| F10 | One 905-line file, `var`/ES5, implicit filter shape, mutable globals | P1 |
| F11 | No tests, CI, lint, or `package.json` | P1 |
| F12 | Drag-only reorder has no keyboard equivalent; focus is lost on every render | P1 |
| F13 | External font dependency, `color-mix()` without fallback, no CSP / meta description / OG tags | P2 |
| F14 | Small logic slips: edit keeps the "Example" badge; `#a_label:checked` inconsistency | P2 |

---

## 1. Best practices & code quality

### F1 — P0: No persistence. A refresh destroys the user's work.

`grep -c "localStorage\|sessionStorage" index.html` returns **0**. The footer admits it ("close the tab and the list is gone"), but admitting a data-loss bug in the footer is not fixing it. This is the single biggest UX defect in the project: the whole point is building a set of filters over time, and the app treats that set as disposable.

**Fix (drop-in, §4A):** versioned `localStorage` autosave on every `render()`, restore on load, and a "Clear all" with confirmation. Keep the XML download as the durable export — localStorage is the working copy, XML is the artifact. Add a storage-quota guard: 1,000 filters × ~500 bytes is ~500 KB, well under the 5 MB limit, but wrap `setItem` in `try/catch` for private-mode `QuotaExceededError`.

### F2 — P0: No 1,000-filter guard.

The README (old and new) cites Gmail's 1,000-filter limit, and the project's own history proves the failure mode: the Gmail filters endpoint 503s above ~1,000 filters. The code has no constant, no counter check, and no warning — `downloadXML()` happily emits 1,500 entries. The user finds out in Gmail, after the work is done.

**Fix:** add `var GMAIL_MAX_FILTERS = 1000;` (§4A), check it in the add handler and in `downloadXML()`, and show the count as `n / 1000` in the toolbar. The toolbar already shows the count; make the limit visible there, not just in the README.

### F3 — P0: Import silently drops data.

Two losses, both in `parseFiltersFromXML()` (~line 830):

1. **Multi-label filters.** `props` is a plain object keyed by property name, so a filter with two `<apps:property name="label">` entries keeps only the last. Gmail allows several `label` properties per filter, and the toolkit's own parser deliberately uses a *list of pairs* for exactly this reason ("one filter can carry several `label` properties, and a dict would keep only the last"). The app reintroduces the bug the toolkit fixed.
2. **`excludeChats`.** The parser has no branch for it, so it is dropped on import and never re-exported. Same for any unknown property: silently ignored, with no skipped-entry report. `importXMLText()` toasts only a total count.

**Fix:** collect `label` properties into an array (§4C), carry `excludeChats` through the model and `propsFor()`, and return `{ filters, skipped }` from the parser with a per-entry reason, surfaced in the toast ("Imported 42 filters, 3 skipped — see console / details"). The model change (label string → `labels[]`) is the one breaking internal change in this review; do it now, while the repo has one commit and no users, not after launch.

### F4 — P1: Validation gaps.

- **Size:** `fSizeVal` is `type="number" min="1"`, but `readBuilder()` takes `.value.trim()` as a string and `propsFor()` emits it verbatim. `"0"`, `"-5"`, `"10.5"`, and `"999999999"` all export as `size` values Gmail will reject or misinterpret. `hasCriteria()` treats `(sizeOp && sizeVal)` as a match, so `Larger than` + empty value is silently dropped with no error — the user thinks they added a size rule and did not.
- **Email:** the forward input is `type="email"`, but nothing calls `checkValidity()` or validates the address in JS. An unchecked box + empty value is caught; a checked box + `not-an-email` is not.
- **Label/forward empty:** the add handler checks them, but through two different mechanisms — `document.querySelector("#a_label:checked")` for the label, `$("a_forward").checked` for forward. The label check is redundant with `!f.actions.label` (which is already `""` when empty) and fragile: it depends on the checkbox ID matching the `a_` + key convention. One helper, `requireValue(action, inputId, message)`, replaces both.
- **Duplicates:** nothing detects two identical filters. Importing the same file twice doubles the list. At minimum, warn on exact-duplicate criteria+actions on add/import.

**Fix:** one `validateFilter(f)` (§4B) that returns a list of messages; the add handler shows the first (or all) and adds nothing. Validate size as a positive integer, forward as an email, label/forward as non-empty when ticked, and criteria/actions presence in the same place.

### F5 — P1: `searchQuery()` changes search semantics.

`searchQuery()` (~line 579) wraps *every* term in parens: `from:(sender@example.com)`, `subject:(Invoice)`, `(unsubscribe)`. For a single term that is harmless; for user input that already contains grouping it double-wraps (`((receipt OR invoice))`), and for a `from:` value with `OR` it is correct only by accident. Worse, it never quotes or escapes: a subject containing `"` or `(` produces a Gmail query that does not mean what the preview shows. The preview is presented as "the Gmail search this creates" — it should be exactly what Gmail will run, or it should say it is approximate.

**Fix:** only wrap when the value contains whitespace or an operator, and quote values containing spaces. Extract one `quoteIfNeeded(value)` helper and use it in both `searchQuery()` and the chip rendering, so the preview and the chips can never disagree.

### F6 — P1: `render()` is O(n) DOM churn on every keystroke-adjacent action.

`render()` (~line 656) does `list.innerHTML = ""`, then `appendChild` per card directly to the live DOM (a reflow per card), creates 3 buttons + 4 drag listeners per card, and regenerates the full XML preview with `buildXML()` on every render — including after a single drag reorder. At 1,000 filters that is ~4,000 listeners and a full re-parse of the list, on an interaction that should be a two-node move.

**Fix (in order):** build cards into a `DocumentFragment` and append once; use event delegation on `#filterList` (one listener for edit/dup/del, one for drag) instead of per-card listeners; regenerate the XML preview lazily (only when the XML panel is open, or debounced 150 ms). Do not reach for virtualization yet — the fragment + delegation fix covers the realistic range, and virtualization is a P2 follow-up if lists regularly exceed ~300.

### F7 — P1: `innerHTML` string-building is the XSS pattern.

There are 11 `innerHTML` uses. Today most of them interpolate only static strings (icons, labels from the `ACTIONS` constant), and user data correctly goes through `textContent` in the card title, chips, and preview — credit where due, that part is right. But the *pattern* is unsafe: `row.innerHTML` builds markup by concatenating `a.input.placeholder` and option labels, `top.innerHTML` concatenates the grip SVG, and `empty.innerHTML` is a raw HTML string. The moment any of those sources becomes user- or file-driven (an imported label is one step away), the same code becomes an injection. `parseFiltersFromXML()` already puts attacker-controlled XML values into the model; the only reason they do not execute is that every sink happens to use `textContent` today.

**Fix:** adopt a rule — `innerHTML` only for static, literal markup; everything else via `createElement` + `textContent`. Replace the action-row builder with DOM APIs (§4E shows the shape), and add a one-line comment at the top of the script stating the rule so the next contributor keeps it.

### F8 — P1: Error handling swallows failures.

- `builderEl` drop handler: `try { activateBlock(JSON.parse(...)); } catch(err){}` — empty catch, no toast, no console. A malformed drag payload fails invisibly.
- `fallbackCopy()`: `try { document.execCommand("copy"); } catch(e){}` — and `copyXML()` calls `done()` (toast: "XML copied") unconditionally after the fallback, so the toast can lie.
- `FileReader` in the import handler has no `onerror` and no size cap. A 100 MB paste/file will freeze the tab in `DOMParser` with no feedback.
- `importXMLText()` catches and toasts `e.message`, but `parseFiltersFromXML()` throws a generic message for every failure mode (not XML, no entries, bad property) — the user cannot tell which.

**Fix:** never an empty catch. Log to `console.warn` at minimum, toast a specific message, and make `copyXML()` toast success only from the success path. Cap imports at a sane size (e.g. 5 MB / 2,000 entries) with a clear error before parsing.

### F9 — P1: DRY violations — the same mapping lives in three places.

- Size-unit display: `searchQuery()` maps `s_skb → "K"`, `s_sb → ""`, else `"M"`; `criteriaChips()` maps the same codes to `" KB" / " bytes" / " MB"`. Two functions, same knowledge, different strings.
- Category names: `ACTIONS` holds `"^smartlabel_social" → "Social"` (in the select options), and `CATEGORY_NAMES` holds the identical map again for chips. Change a label in one place and the chips disagree with the form.
- Size codes themselves (`"s_sb" / "s_skb" / "s_smb"`, operators `"s_sl" / "s_ss"`) are magic strings scattered through HTML (`<option value="s_sl">`), `mkFilter` defaults, `loadIntoBuilder`, `propsFor`, and the parser.
- SVG icons: the grip SVG is a string constant reused (good), but the edit/copy/trash icons are three more inline string constants, and the template icons live in a separate `ICONS` map with the same shape.

**Fix:** one `SIZE_UNITS` table and one `SMART_LABELS` table (§4A), and derive the `<option>` elements, the search suffix, the chip text, and the XML codes from them. Delete `CATEGORY_NAMES` and read the display name from the same table the form uses.

### F10 — P1: One file, ES5, implicit types, mutable globals.

905 lines, one IIFE, `var` throughout, no modules, no types. The filter shape exists only as an object literal in `mkFilter()` (~line 414) — there is no typedef, no schema, and no assertion that an imported object has the fields `propsFor()` assumes (`f.actions.label`, `f.sizeUnit`). State is four mutable globals (`filters`, `uid`, `editingId`, `dragId`) closed over by ~30 functions; `filters = filters.filter(...)` reassigns the array while closures hold the old reference in the same tick (it works today because `render()` re-reads the variable, but it is a trap for the next edit).

**Fix (staged, §3):** Stage 1 — add a `@typedef` for `Filter` and `FilterActions`, convert `var` → `const`/`let`, and freeze the shape with a `normalizeFilter(raw)` function at the import boundary. Stage 2 — split into ES modules (`model.js`, `gmail-xml.js`, `ui.js`) behind a tiny static build that inlines them back to one file for Pages, *or* keep the single file and add a Node test harness that extracts the pure functions. Do not split the file just to split it; split at the seam that already exists (XML serialization vs. DOM), and keep the deploy artifact a single file.

### F11 — P1: No tests, CI, lint, or `package.json`.

Zero automated checks. The XML mapping — the load-bearing contract of the whole project — is verified only by a human reading `propsFor()` and by the one manual round-trip in the README checklist. The `shouldSkipArchive` bug that this repo already fixed once is exactly the class of regression a test would have caught, and it will come back the next time someone edits that table.

**Fix:** add a minimal Node test file (`tests/gmail-xml.test.js`, plain `node:test`, no dependencies) that asserts: Skip Inbox → `shouldArchive`, size → `size`/`sizeOperator`/`sizeUnit`, multi-label round-trips, unknown properties are reported not swallowed, and `escXml()` escapes `&<>"'`. Add a GitHub Actions workflow that runs `node --test` on push. No framework, no build — the workflow is ~20 lines, and it is the highest-leverage file in this review.

### F12 — P1: Drag-only reorder excludes keyboard users.

Reordering is drag-and-drop only. There is no keyboard path (no "move up/down" buttons), no `aria-grabbed`/`aria-dropeffect`, and `render()` rebuilds the DOM on every change, so focus is lost after edit/duplicate/delete — a keyboard user is dropped back at the top of the page. The toast is `role="status"` (good), but the drag handle is a `<span>` with no keyboard handler and no label for assistive tech.

**Fix:** add Move up / Move down buttons on each card (visible on focus, at minimum), give the handle `tabindex="0"` + `role="button"` + `aria-label`, and restore focus to the edited card after `render()` by id. This is a small change; do it with F1, not after launch.

### F13 — P2: Fonts, `color-mix()`, and missing head metadata.

- Google Fonts is the only external request. It has `display=swap` and a system-font fallback (good), but it is still a third-party request on a page whose selling point is "nothing leaves your browser". Self-host the two fonts (`fonts/` + `@font-face`) or drop to system fonts; either is defensible, the current middle state is not documented.
- `color-mix()` (line 83, `.block` border) has no fallback for older browsers — the border silently becomes invalid and the block loses its outline. Provide a plain `border-color` first, then the `color-mix()` declaration.
- No `<meta name="description">`, no Open Graph / Twitter tags, and `<link rel="icon" href="data:,">` is an explicit empty favicon. For a repo whose README is trying to get clicks, the link preview is the first impression and it is currently blank.
- No Content Security Policy. For a page that parses user-supplied XML, a restrictive CSP (`default-src 'self'`, fonts from Google only) is cheap defence in depth.

### F14 — P2: Small logic slips.

- **Edit keeps the "Example" badge.** The add/edit handler preserves `f.example` on save, so an edited starter filter still says "Example". Set `example: false` on save.
- **`#a_label:checked` vs `$("a_forward").checked`.** See F4 — two mechanisms for one check.
- **`uid` is a process-global counter.** `mkFilter` increments it, duplicates increment it, imports increment it — but an imported file's entries have no ids, so ids are assigned in import order. That is fine, but `uid` is never persisted (see F1), so after a reload-and-restore the counter restarts and can collide with restored ids. Derive the next id from `Math.max(...filters.map(f => f.id)) + 1` on restore.
- **Toast timing.** `showToast()` uses a single 3.4 s timer and overwrites the message; rapid actions (duplicate ×3) show only the last toast. Acceptable, but queue or extend the timer instead of silently dropping messages.

---

## 2. Commenting & in-code documentation

The code has section headers (`/* ---------- XML export ---------- */`) and almost nothing else. There is **no JSDoc on any function**, and the comments that do exist restate the *what* ("Build palette", "Add / edit") rather than the *why*. The places that most need a why-comment are exactly the places a new contributor will break:

1. **`propsFor()` / `buildXML()`** — *why* these property names, and where they come from. There is no published Google schema; the format is reverse-engineered from Gmail's own export. A contributor who "cleans up" `shouldArchive` to `shouldSkipArchive` (which reads better) reintroduces the bug this repo already fixed. The comment must cite the source of truth and the failure mode.
2. **The backwards-compat fallback** in `parseFiltersFromXML()` (`shouldSkipArchive`, `sizeValue`) — *why* the parser accepts names the exporter never emits. Without the comment, the next cleanup deletes the fallback and breaks imports of files the first build produced.
3. **`loadIntoBuilder()`'s `on` expression** — `d.actions[a.key] !== undefined && d.actions[a.key] !== false` is doing three things at once (missing vs. false vs. a string value for label/forward). It deserves a comment or, better, a named helper.
4. **The namespace fallback chain** in the parser (`getElementsByTagNameNS` → `apps:property` → scan all elements for `localName === "property"`) — *why* three strategies. (Answer: exports vary in how they declare the `apps` prefix.)
5. **`searchQuery()`'s paren wrapping** — *why* parens, and when they change meaning (see F5).
6. **The 1,000-filter limit** — it appears nowhere in code (see F2). The constant needs a comment citing the observed failure (Gmail filters endpoint 503s above ~1,000).

### JSDoc to add (drop-in)

Add this block above `mkFilter()` and the function-level docs below. These are the minimum; every exported-shape function (`propsFor`, `buildXML`, `parseFiltersFromXML`, `searchQuery`, `validateFilter`) should carry one.

```js
/**
 * A single Gmail filter, as the app holds it in memory.
 * This is the app's own shape — Gmail's XML uses different property
 * names (see {@link propsFor}); the mapping between the two is the
 * load-bearing contract of this project. Keep them in sync.
 *
 * @typedef {Object} FilterActions
 * @property {boolean} [skip]      Skip the Inbox (archive).
 * @property {boolean} [read]      Mark as read.
 * @property {boolean} [star]      Star it.
 * @property {string}  [label]     Label name to apply, e.g. "Finance/Receipts".
 * @property {string}  [category]  Smart-label value, e.g. "^smartlabel_social".
 * @property {string}  [forward]   Verified forwarding address.
 * @property {boolean} [trash]     Delete it.
 * @property {boolean} [neverspam] Never send to Spam.
 * @property {boolean} [alwaysimp] Always mark as important.
 * @property {boolean} [neverimp]  Never mark as important.
 *
 * @typedef {Object} Filter
 * @property {number} id
 * @property {string} name          Display-only; never sent to Gmail.
 * @property {string} from
 * @property {string} to
 * @property {string} subject
 * @property {string} has           Has the words.
 * @property {string} hasNot        Doesn't have.
 * @property {boolean} attach       Has attachment.
 * @property {string} sizeOp        "" | "s_sl" (larger) | "s_ss" (smaller).
 * @property {string} sizeVal       Size number as typed, e.g. "10".
 * @property {string} sizeUnit      "s_sb" | "s_skb" | "s_smb".
 * @property {FilterActions} actions
 * @property {boolean} [example]    True for the two preloaded starter filters.
 */
```

```js
/**
 * Map one filter to Gmail's Atom-feed properties.
 * Property names are Gmail's, not ours: there is no published schema,
 * they are reverse-engineered from Gmail's own export, and Gmail's
 * importer rejects unknown names — so `shouldArchive` (not the more
 * readable `shouldSkipArchive`) and `size` (not `sizeValue`) are
 * load-bearing spellings. Verified against gmail-forensic-toolkit's
 * `filters_to_xml` mapping. Do not rename without a round-trip test.
 * @param {Filter} f
 * @returns {Array<[string, string]>} [name, value] pairs, in export order.
 */
function propsFor(f) { /* … */ }

/**
 * Parse a Gmail filter export. Returns both the filters and the entries
 * that could not be imported, so a bad entry never silently vanishes.
 * Accepts the legacy names `shouldSkipArchive` / `sizeValue` (emitted by
 * the first build) as a fallback; the exporter never emits them.
 * @param {string} text Raw XML text.
 * @returns {{ filters: Filter[], skipped: Array<{ entry: number, reason: string }> }}
 */
function parseFiltersFromXML(text) { /* … */ }
```

Also add a file-level header comment at the top of the `<script>` stating the three rules that keep this file safe: (1) user data goes through `textContent`, never `innerHTML`; (2) Gmail property names are the source of truth; (3) `render()` is the only function that touches `#filterList`.

---

## 3. Future-proofing & architecture

### What is coupled today

```
 index.html (905 lines)
 ├── <style>        ~350 lines, magic numbers, no design tokens beyond colour
 ├── <body>         static markup + JS-injected palette / actions / templates
 └── <script> (IIFE)
      ├── constants (ACTIONS, BLOCKS, TEMPLATES, ICONS) — data + UI + XML names in one table
      ├── state (filters, uid, editingId, dragId) — mutable globals
      ├── DOM builders (palette, checkrows, cards) — string HTML + listeners
      ├── model ops (mkFilter, readBuilder, loadIntoBuilder, autoName)
      ├── Gmail mapping (searchQuery, propsFor, buildXML, parseFiltersFromXML)
      └── I/O (downloadXML, copyXML, import handlers, toast)
```

Every layer reads the same globals and the same DOM ids. Changing the filter shape touches `mkFilter`, `readBuilder`, `loadIntoBuilder`, `hasCriteria`, `criteriaChips`, `propsFor`, the parser, and the chips — seven places, with no type to catch a miss. Changing the XML mapping touches the same seven. That is the coupling to break, and it breaks at one seam: **the Gmail mapping is pure** (filter object in, property list out, and back) while everything else is DOM. It is the only part that can be tested without a browser, and it is the part with no tests.

### Concrete plan (staged; do not do it all at once)

**Stage 1 — constants + boundaries, no file split (this PR-sized).**
- Extract the tables in §4A (`GMAIL_MAX_FILTERS`, `GMAIL_NS`, `SIZE_UNITS`, `SMART_LABELS`, `ACTION_DEFS`). Derive the form options, chip text, search suffix, and XML codes from them; delete `CATEGORY_NAMES`.
- Add `normalizeFilter(raw)` at the import boundary and `validateFilter(f)` at the add boundary. No object that fails either reaches `filters[]`.
- Add persistence (§4A) and the 1,000 guard (F2). These three changes are the P0s; ship them together.

**Stage 2 — split the pure code out, keep one deployable file.**
- Move the mapping + validation + search-query code into `src/gmail-xml.js` and `src/filter-model.js` as ES modules with no DOM imports. Add `tests/gmail-xml.test.js` (`node:test`, zero dependencies) covering the mapping table.
- Keep the deploy artifact a single `index.html` for Pages: either keep the modules inline in the file with a comment marking the seam, or add a ~10-line build script that concatenates them. Do **not** introduce Vite/webpack for a 900-line static page — the build tool would be bigger than the app. If a framework ever becomes justified, that is a separate decision, not a side effect of this refactor.

**Stage 3 — only if the list grows.**
- Virtualized / paginated filter list (only when lists regularly exceed ~300), undo for delete (command stack on the model, not on the DOM), and JSON backup export (lossless app-native format; XML stays the Gmail interchange format). Do not build any of these before Stage 1 — they all depend on the model boundary Stage 1 creates.

### Hardcoded values to centralise (all in §4A)

| Value | Where it lives today | Where it should live |
|---|---|---|
| 1,000-filter limit | Nowhere in code; README only | `GMAIL_MAX_FILTERS` + toolbar text |
| Atom / Apps namespaces | String literals in `buildXML()` and the parser | `GMAIL_NS.ATOM`, `GMAIL_NS.APPS` |
| `tag:mail.google.com,2008:filter` | String literals in `buildXML()` | `GMAIL_FEED_ID` |
| Size codes `s_sb/s_skb/s_smb`, operators `s_sl/s_ss` | HTML options, `mkFilter`, parser, `propsFor` | `SIZE_UNITS` table |
| Smart labels `^smartlabel_*` | `ACTIONS` options + `CATEGORY_NAMES` | `SMART_LABELS` table |
| Toast duration 3400 ms, XML filename `gmail-filters.xml` | Literals in `showToast` / `downloadXML` | Named constants |

---

## 4. Updated code

These are drop-in replacements for the current code, using the existing identifiers and ES5 style so they apply cleanly. They are not yet applied to `index.html` — apply them as one P0 commit, run the checklist, then rebuild the push zip.

### 4A — Single source of truth: constants + persistence + limit

```js
/* ---------- Gmail contract (single source of truth) ---------- */
// Property names are Gmail's, reverse-engineered from its own export;
// there is no published schema. See the JSDoc on propsFor().
// Gmail's filters endpoint fails above ~1,000 filters (observed 503);
// the app must warn before the user builds past it.
var GMAIL_MAX_FILTERS = 1000;
var GMAIL_NS = {
  ATOM: "http://www.w3.org/2005/Atom",
  APPS: "http://schemas.google.com/apps/2006"
};
var GMAIL_FEED_ID = "tag:mail.google.com,2008:filter";
var XML_FILENAME = "gmail-filters.xml";
var STORAGE_KEY = "gmail-filter-builder/v1"; // bump on any model change
var TOAST_MS = 3400;

/** Size units: one table drives the form, chips, search text, and XML. */
var SIZE_UNITS = {
  s_sb:  { xml: "s_sb",  search: "",  label: "bytes" },
  s_skb: { xml: "s_skb", search: "K", label: "KB" },
  s_smb: { xml: "s_smb", search: "M", label: "MB" }
};
var SIZE_OPERATORS = { s_sl: "larger", s_ss: "smaller" };

/** Smart labels: one table drives the form select and the chip text. */
var SMART_LABELS = {
  "^smartlabel_personal":     "Primary",
  "^smartlabel_social":       "Social",
  "^smartlabel_promo":        "Promotions",
  "^smartlabel_notification": "Updates",
  "^smartlabel_group":        "Forums"
};
// Delete CATEGORY_NAMES; chips read SMART_LABELS[a.category] instead.

/* ---------- Persistence (working copy; XML is the durable export) ---------- */
function saveFilters() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch (err) {
    // Private mode / quota: the list still works for this session,
    // but the user must download the XML before closing the tab.
    console.warn("Could not autosave filters:", err);
    showToast("Autosave failed — download the XML before closing this tab.");
  }
}
function loadSavedFilters() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    var saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return;
    saved.forEach(function (f) {
      var nf = normalizeFilter(f); // see §4B; drops malformed entries
      if (nf) filters.push(nf);
    });
    // Restart ids above the highest restored id (see F14).
    uid = filters.reduce(function (m, f) { return Math.max(m, f.id || 0); }, 0) + 1;
  } catch (err) {
    console.warn("Could not restore saved filters:", err);
  }
}
```

Call `loadSavedFilters()` before the two starter `filters.push(...)` lines — and only push the starters when nothing was restored — then call `saveFilters()` at the end of `render()`.

### 4B — Validation at the boundary

```js
/**
 * Validate a filter built by readBuilder(). Returns a list of problems;
 * empty means the filter may enter the list. Keep every rule here so
 * the add handler, the import path, and the tests check the same thing.
 * @param {Filter} f
 * @returns {string[]}
 */
function validateFilter(f) {
  var problems = [];
  if (!hasCriteria(f)) problems.push("Add at least one match first.");
  if (!hasActions(f)) problems.push("Tick at least one action.");
  if (f.actions.label !== undefined && !f.actions.label)
    problems.push("You ticked “Apply a label” — type the label name, or untick it.");
  if (f.actions.forward !== undefined) {
    if (!f.actions.forward) problems.push("You ticked “Forward it to” — enter the address, or untick it.");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.actions.forward))
      problems.push("That forwarding address doesn’t look like an email address.");
  }
  if (f.sizeOp && !/^\d+$/.test(f.sizeVal))
    problems.push("Size must be a whole number of " + (SIZE_UNITS[f.sizeUnit] || SIZE_UNITS.s_smb).label + ".");
  if (f.sizeOp && parseInt(f.sizeVal, 10) < 1)
    problems.push("Size must be at least 1.");
  if (filters.length >= GMAIL_MAX_FILTERS)
    problems.push("You’re at Gmail’s " + GMAIL_MAX_FILTERS + "-filter limit — remove one before adding another.");
  return problems;
}
```

The add handler becomes: `var problems = validateFilter(f); if (problems.length) { showError(problems.join(" ")); return; }` — replacing the three ad-hoc checks, including the `#a_label:checked` one.

### 4C — Import that does not drop data

```js
// In parseFiltersFromXML(): collect repeated properties instead of
// overwriting them, and carry excludeChats through the model.
var labels = [];
var excludeChats = false;
for (var k = 0; k < nodes.length; k++) {
  var name = nodes[k].getAttribute("name");
  var value = nodes[k].getAttribute("value") || "";
  if (name === "label") { labels.push(value); continue; }
  if (name === "excludeChats") { excludeChats = value === "true"; continue; }
  props[name] = value; // every other property occurs at most once
}
// … then, when building the filter:
var f = {
  /* …existing fields… */
  actions: actions,           // actions.label = labels[0]
  labels: labels,             // full list; exporter writes one property each
  excludeChats: excludeChats
};
```

This requires the model change flagged in F3 (label string → `labels[]`, with `actions.label` kept as the first label for display until the UI catches up). Ship the model change and the parser change in the same commit, with a test asserting a two-label filter round-trips.

### 4D — Render with a fragment and delegation (sketch)

```js
function render() {
  var list = $("filterList");
  var frag = document.createDocumentFragment(); // one reflow, not one per card
  filters.forEach(function (f) { frag.appendChild(buildCard(f)); });
  list.innerHTML = "";
  list.appendChild(frag);
  $("xmlPreview").textContent = $("xmlPanel").open ? buildXML() : "";
  saveFilters();
}
// Attach ONE click listener on #filterList that reads
// e.target.closest("[data-act]") and the card's data-id, instead of
// three listeners per card. Same for dragstart/dragover/drop.
```

Regenerating the XML preview only when its panel is open removes the largest per-render cost for users who never open it.

### 4E — Stop building rows with `innerHTML`

Replace the action-row builder's `row.innerHTML = html` with DOM APIs: `createElement("input")`, set `type`/`id`/`placeholder` as properties, `textContent` for the label and hint. The rule for the file, stated in the header comment: **static literal markup may use `innerHTML`; anything containing data — including constants that could become data — uses `textContent`.**

---

## 5. README modernization

### What changed

The old README (36 lines) had no Prerequisites, Installation, Local Development, or Deployment sections, claimed import worked by "drag a file onto the import panel" (it does not — import is file picker or paste; only the palette blocks drag), and buried the two facts a new user needs most (no persistence; 1,000-filter limit) in passing sentences. The rewritten `README.md` (committed with this review) now has all four required sections plus: a features list, a **Known limitations** section that states the P0s plainly instead of hiding them, a repository layout, a manual smoke checklist that stands in for the missing test suite, a Usage section with the Gmail import steps, an Architecture section with the diagram, Privacy, Contributing rules (including the XML-contract rule), and a License link. It no longer claims drag-to-import.

### What is still missing from the README

The screenshot/GIF slots are comment-marked, not filled (see §6). Do not push the README's image links live until the files exist — the comments mark the exact spots so the images can be dropped in without re-flowing the document.

---

## 6. Visual asset strategy

No screenshots exist in the repo today, and the old README had none — for a visual, drag-and-drop tool, that is the cheapest win available. Capture on the **real site with real Gmail**; do not mock, stage with fake data, or use stock imagery. The five starter filters (one per template) are the only demo data; they are generic and already in the app, so they are honest to show.

| # | Asset | File | Exactly what it must depict | Exact placement in README |
|---|-------|------|-----------------------------|---------------------------|
| 1 | Hero screenshot | `docs/assets/hero.png` (1280×720, light theme) | Hero headline, all five template cards, the builder dialog open with the Newsletters template loaded, and the five starter filter cards in the list | Directly under the one-paragraph description, before `## Description`'s feature list — the first thing a visitor sees after the intro. Slot is comment-marked in the README. |
| 2 | Architecture diagram | `docs/assets/architecture.svg` | Data flow: Builder UI ⇄ Filter[] model ⇄ `buildXML()` → `gmail-filters.xml` → Gmail Import; reverse: `mailFilters.xml` → `parseFiltersFromXML()` → model. Labelled "No server, no storage." | In `## Architecture`, directly under the intro paragraph. **Shipped with this review** — this file exists. |
| 3 | Round-trip GIF | `docs/assets/round-trip.gif` (≤15 s, 1280×720, no cuts) | The full loop in one take: open the Newsletters template (dialog opens) → Add filter (dialog closes) → drag the new card above the first → Download .xml → Gmail Settings → Filters and Blocked Addresses → Import filters → the new filter appears in Gmail | At the top of `## Usage`, before step 1. Slot is comment-marked. This is the highest-impact asset: it proves the claim the headline makes. |
| 4 | Gmail import dialog screenshot | `docs/assets/import-dialog.png` (1280×720) | Gmail's own import dialog with `gmail-filters.xml` selected and the filter list shown before clicking "Create filters" | Under `### Import into Gmail`, directly under the heading. Slot is comment-marked. It de-risks the step users are most nervous about. |

**Capture steps (about 10 minutes, on your box):** open the live Pages site at 1280×720, light theme; for #1 take a full-page screenshot; for #3 record the screen (Windows Game Bar / macOS Screenshot tool) doing the loop for real, trim to ≤15 s, export as GIF; for #4 screenshot the Gmail dialog mid-import. Save to `docs/assets/`, replace the matching HTML comment in `README.md` with the `![alt](docs/assets/…)` line given in the comment, commit, and push. Do not push the README image links before the files exist — Pages will render broken images.

**Do not add:** a logo (the project has no brand to logo), stock photos of inboxes, or a mocked "before/after" comparison. Every visual should be evidence, not decoration.

---

## Appendix — verification and files changed

**Verification performed for this review:** read `index.html` lines 1–905; counted `innerHTML` (11), `localStorage` (0), `console.` (0); confirmed no `.github/`, test files, or `package.json`; confirmed the XML mapping against `gmail-forensic-toolkit`'s `filters_to_xml` / `_parse_xml_entry`; confirmed the fixed export contains `shouldArchive` (×3) and `tag:mail.google.com,2008:filter` (×2) in the committed `index.html`.

**Files changed in this review (committed in the repo, not yet pushed):**
- `README.md` — rewritten (see §5).
- `docs/STAFF-REVIEW.md` — this file.
- `docs/assets/architecture.svg` — new, referenced from the README.

**Applied 2026-11-13:** §4A–§4C are now in `index.html` — Gmail contract constants + single-source size/category tables, versioned `localStorage` autosave with restore, the 1,000-filter guard (toolbar shows `n / 1000`), `validateFilter()` wired into the add handler, multi-label + `excludeChats` round-trip with skipped-entry reporting, and a `window.__gmailFilterBuilder` test seam. Verification: `node --test tests/gmail-xml.test.js` — 6/6 pass — plus a Node harness round-trip (app XML checked against the toolkit's accepted property set: 0 unknown properties) and a persistence reload check (restore without duplicating starters). `tests/gmail-xml.test.js` and `.github/workflows/test.yml` are new (F11, partially addressed — the suite covers the XML contract, validation, persistence, and search query). The README's Known limitations were updated to match. Still open: duplicate detection, keyboard reorder, render virtualization, search-query quoting (F5), silent-catch cleanup (F8), and the screenshot/GIF assets in §6.

**2026-11-14:** palette-block dragging removed at the owner's request — blocks are tap-to-jump only (the builder's `dragstart`/`drop` handlers, the grip icon on blocks, and the "drag or tap" copy are gone). Filter-card reorder drag is unchanged, as is the F8 note above except that the `builderEl` drop handler it cites no longer exists.

**2026-11-14 (modal builder):** the builder moved from a sticky side panel into a native `<dialog>` — New filter, templates, and Edit all open the same form; the list is now the main page. The form, validation, and save flow are unchanged (field IDs identical); close paths are Esc, backdrop click, ✕, Cancel, and Add/Save, with a discard confirm when the form is dirty (snapshot comparison) and focus returned to the opener. The template-click path also now resets `editingId` first (previously a template loaded while editing would have overwritten the edited filter on Add). Two new tests cover open/edit/reset and the dirty-close prompt; suite is 8/8.

**2026-11-14 (palette removed):** the Match Blocks palette is gone at the owner's request — the match fields and action checkboxes are self-explanatory, and the palette's jump-to-section added nothing while its action blocks had a confusing dual behavior (jump *and* check the box). Removed: the palette markup, the `BLOCKS` array, `activateBlock()`, the `.palette`/`.block`/`.field.flash` styles, and the "palette blocks" node in the architecture diagram (now "match fields + actions"). The hero copy was rewritten to match how the app is actually used: "Gmail filters, *filled out* — not decoded from Settings." / "Fill in what a message matches, check off what Gmail should do with it…". No functional loss — every block mapped 1:1 to a field or checkrow that is still there.

**2026-11-14 (examples + README refresh):** one rule — examples never leave the page. `exportableFilters()` (filters without `example:true`) now drives `buildXML()`, the toolbar count, the Download/Copy empty guards, the Add toast, and the 1,000-limit check; `importXMLText()` drops the starters before adding imported filters, but only when the import brings at least one filter (a file that parses to nothing leaves them in place). Editing or duplicating a starter already cleared the flag, so a starter the owner keeps as their own still exports. Two new tests (export/import examples, limit counts exportable only); suite is 10/10. README refreshed the same night: the stale "close the tab and the list is gone" line now says autosave, the smoke checklist no longer says "until tests exist", the dialog is mentioned in the smoke steps and test blurb, and the §6 shot list describes the dialog flow.

**2026-11-14 (action counts + filter, two-column list):** the toolbar gained an action filter (options from the same `ACTIONS` table as the checkrows) and a counts line ("Skip the Inbox 2 · Star it 1 …", plus "showing N of M" while filtered). Both are view-only: `visibleFilters()` narrows the rendered cards, the model and `buildXML()` are untouched, and drag reorder still works under a filter (drop targets are resolved by id against the full model). Counts describe the whole list, examples included; the export count stays exportable-only. The list itself is now two columns at ≥900px (`#filterList` grid, empty state spans both columns) after the owner sent a screenshot showing the single-column stack wasting the width on his PC. One new test (counts, filter, export unaffected); suite is 11/11. The same pass fixed a stale empty-state line ("Build one on the left" → "Build one with New filter").

**2026-11-14 (import modal + clear all):** the bottom `<details>` import panel is gone; **Import Filters** opens a native `<dialog>` with an explanation, a drop zone (drag a `.xml` file or click to browse — file reading is now one shared `readImportFile()` for picker and drop), and the paste box. The dialog closes on a successful import and keeps the pasted text when closed early. **Clear all** sits next to it in the toolbar, disabled when the list is empty, and always asks first — even for only the starters — with a count and a download-first warning when real filters are present; it also resets the action filter. `loadSavedFilters()` now treats a saved empty list as a save (was: only ≥1 restored filter counted), so a cleared list stays cleared across reloads instead of re-seeding the starters. Two new tests (import modal open/import/close; clear-all confirms + reload stays empty); suite is 13/13.

**2026-11-14 (order numbers):** each card shows its position in the full list (1, 2, 3…) as a small number before the drag handle — that is the export order, and it stays put under an action filter, so a filtered card can read e.g. #7. One new test; suite is 14/14.

**2026-11-14 (round-trip steps + number placement):** the steps card is now "How the round trip works" with four steps: an **Optional** first step (export existing filters from Gmail, then Import Filters here to view/edit/add to them) followed by Download → Open Gmail settings → Import & create, so the outbound-only flow is now the full loop and the first step is clearly skippable for new-only users. The steps grid went from 3 to 4 columns above 1020px. Order numbers moved from the card header to a bottom-right footer (`#3`, `.fc-foot` flex row), leaving the drag handle alone at the top left. The order-number test now reads the footer child; suite still 14/14.

**2026-11-14 (hero card, hero download, one example per template):** the top-right hero card now matches the steps card — its list gained the same optional first leg ("Import (optional) — already have filters? Export them from Gmail and bring them in here first") ahead of Build → Export → Import. The hero's "Download filters (.xml)" button is gone; the toolbar Download above the list is the one download. Starters are now one example per template (`loadExamples()`, five filters: Newsletters, Receipts, Social alerts, Large mail, VIP) instead of two hand-written ones, and the empty state offers **Load examples** instead of opening the builder with the newsletter template. Updated tests (fresh page is 5 starters, counts are Skip 2 / Label 3) plus a new loadExamples test; suite is 15/15.

**2026-11-14 (clickable count pills):** the counts line is now pills — one button per action with a count ("Star it 3"), active pill filled dark with `aria-pressed`, tap to filter the list to that action, tap again to clear. Same view-only filter the dropdown sets; `render()` keeps both in sync (the select's value follows the pills). The "showing N of M" note is now a small span after the pills, and the row hides entirely when the list is empty. The counts test now reads pill text instead of container text, plus a new pill test that fires the stored click handler; suite is 16/16.

**2026-11-14 (pills card, dropdown removed, search):** the pills moved onto a card of their own ("Filter by action" + one line of instruction) and the dropdown is gone — the pills are the only action filter, so `render()` no longer syncs a select and `clearAllFilters()` no longer resets one. Under the card sits a search box: typing narrows the cards live, matching name, from/to/subject, has/hasNot, labels, and the Gmail search text, case-insensitive, every word must match; it composes with the pill (a card shows only when it passes both). The "showing N of M" note appears when either is active, the no-match empty state names the search ("No filters match “amazon”", built with `textContent`, not `innerHTML`), and both the pills card and the search box hide when the list is empty. One new search test (name/address/label/case/multi-word/composition); suite is 17/17.

**2026-11-14 (step-card bold fix):** the owner spotted the Import & create card reading as broken lines with a comma and a period stranded at line starts. Cause: `.step b{display:block}` matched every `<b>` in a step, so the bold phrases inside the step text ("Import filters", "Create filters" — and step 1's "Filters and Blocked Addresses", "Import Filters") each became their own block. Fixed by scoping the rule to the title only (`.step > b`); the inline phrases stay inline. One new test guards the selector; suite is 18/18.

**2026-11-14 (persistent cards — the list jump):** with his real 1,000-filter list imported, tapping an action pill visibly shifted the cards. Cause: `render()` started with `list.innerHTML = ""` and rebuilt every card from scratch on every view change, and the page got shorter at the same time (835 cards instead of 1,000). Fix: cards are now persistent elements keyed by filter id — `render()` reconciles them against the model (create / refresh / remove / re-order by re-appending, which moves a node) and `applyView()` only toggles which ones show, so a pill click or a search keystroke destroys nothing. Card handlers resolve the live filter by id (an edit save replaces the object, so a closed-over reference would go stale); content refreshes only when the filter's JSON signature changes, while the order number is always refreshed. The empty states are persistent divs too, toggled rather than rebuilt. The test stub gained real `appendChild` (move semantics), `removeChild`, and `parentNode` tracking; the order-number test now reads the visible card instead of the last child. Three new tests (pill/search reuse, add/remove keeps cards + renumbers, edit refreshes in place); suite is 21/21. Full `render()` virtualization is still open — this is reuse, not virtualization.

**2026-11-15 (long titles wrap mid-word):** a filter auto-named "From notifications@notifications3.creditkarma.com" (no label, so `autoName` falls back to "From " + the address) broke across three lines in its card with a lone "m" on the last line — the `overflow-wrap:anywhere` added for the overhang fix let the long unbroken address break anywhere, and the title was a bare text node in a wrapping flex `h3`. Fix: the name now lives in its own `span.fc-name` (one line, truncates with …, full name on hover via the `title` attribute), the `h3` is `flex-wrap:nowrap`, and the Example badge sits beside the span as its sibling so it never gets cut off with the name. The badge logic changed with it: it used to be wiped and rebuilt via `textContent` on the `h3`; now it is added once and removed explicitly when the filter stops being an example. One new test guards the structure (name span + badge as siblings). Suite is 22/22. (Superseded the same day: the search line mentioned here as left wrapping is now single-line too — see the tooltips note below.)

**2026-11-15 (hover tooltips on truncated text):** the overhang fix holds — the new screenshot shows the cards fitting their columns — but truncating hid the full text: the Stir card's MATCHES chip cut its long address off at "@talk.sti…", and the search line still wrapped to two lines for the longest addresses (Stir, iSecretShop), leaving those cards taller than their row-mates. Fix: every truncatable bit of card text now carries its full text as a hover tooltip — the title (already had it), the search line, and every Matches/Then chip (`title` = the full text, set when the chips are built). The search line also went single-line with ellipsis, so all cards are one line per section now and the grid is uniform; the full query is on hover and in the edit dialog. One new test asserts title === textContent for the title, the search line, and every chip. Suite is 23/23.

**2026-11-15 (security check):** new "Security check" button in the toolbar — a heuristic review of the exportable filters for patterns an account takeover leaves behind. It runs entirely on the page and never changes or deletes anything; it only flags. Four rules: (1) high — forwards mail to another address (the address is in the finding); (2) high — matches all mail (no criteria, reusing `hasCriteria`) and deletes, skips the inbox for, or forwards it; (3) medium — skips the inbox for or deletes mail from sensitive senders (bank, password, security, verify, payment, invoice, billing, credit, login, reset, tax, irs, matched against from/to/subject/has/hasNot); (4) medium — Never Spam plus Skip Inbox together. The report is a modal grouped High/Medium with a count summary, a clean "No risks found" state, and a note that it can't tell which forward addresses are yours. Each finding has a View button that closes the modal, clears the pill/search view, scrolls to the card, and flashes a blue outline on it for 2.5s. The scan is a pure `securityCheck(list)` over `exportableFilters()` — starters are demo data, not real filters, so they are never checked. Two new tests cover the four rules plus their clean counterparts and the exportable-only scope. Suite is 25/25.

**2026-11-15 (table view):** a second view of the same list — a Cards / Table toggle above the list, cards stay the default, the choice persists in localStorage (`gmail-filter-builder/view`). Table columns: # (export order), Name, Matches (the Gmail search), Actions (short labels joined with " · "), and row buttons (↑ ↓ Edit Duplicate Delete). Long cells truncate with … and carry the full text as a hover tooltip, like the card text. Clicking the # or Name header sorts the view only — Name toggles asc/desc, # resets to list order — and the # column always shows the true export position, so a name sort never disguises the export order. Rows are persistent elements keyed by id (`rowEls`), built the same way as the cards, so a pill click or keystroke can't rebuild the list and move the page; the pill and search hide rows the same way they hide cards. Reorder in the table is ↑ ↓ buttons per row (`moveFilter`, swaps adjacent filters in the model) — drag doesn't translate to table rows. The arrows are disabled at the ends and whenever the table is sorted by name (there the rows aren't in export order, so "up" would mean nothing visible), with the reason in the tooltip. The toolbar count reads "reorder with ↑ ↓" in table mode instead of "drag to reorder". Five new tests cover row content/tooltips, view persistence across reload, name sort as display-only with # as true position, move up/down with bounds and the name-sort disable, and pill/search hiding rows. Suite is 30/30. Still open: keyboard reorder (arrow keys) — the table arrows cover move up/down buttons only.

**2026-11-16 (reorder removed; table pills, two rows max):** both reorder controls are gone — the cards lost the drag handle and all drag handlers (`dragId`, `grip`, the `dragging`/`drop-target` CSS), and the table lost the ↑ ↓ buttons (`moveFilter`, `refreshMoveButtons`). The list order is now just the order filters were added or imported in; the round-trip step and the toolbar count no longer mention reordering. The table's Matches/Actions columns now show the same pills as the card instead of one truncated line — each pill carries its own text on hover, the cell's tooltip holds the whole list, and the pill container caps at two rows (`max-height:64px`, two chip rows plus the gap, the third row clipped) so tall filters don't stretch the row; every pill stays in the DOM, only the overflow is clipped. The freed button width went to the Matches column (row-actions is 120px now, three buttons). Tests: the move test is deleted, the row test now asserts pills and three buttons, plus a no-drag test (no drag identifiers left in the page, card not draggable, top row is just title + buttons) and a two-row-cap test (7 criteria + 10 action pills all present, container class + max-height rule). Suite is 31/31. Reorder is gone entirely — if it comes back it needs a new mechanism, not a restore of these two.

**2026-11-16 (security report: wider, two columns; View opens the editor):** the security dialog now widens to 920px at the same 860px breakpoint as the builder (it was 560px), and the findings lay out in a two-column grid (`.sec-grid`, one column below 860px) under each risk-group heading instead of one long single column. The View button no longer scrolls to the filter's card — that only worked in the cards view and failed silently from the table, since the card doesn't exist there. It now opens the filter in the builder dialog (the same detail view the Edit button opens), so it works from either view and the user can review and fix the problem right there (e.g. remove the forward). The report closes first so only one dialog is open; focus returns to the Security check button when the editor closes. The old scroll-and-flash code and the `.flash` outline are deleted. Two new tests cover the editor-opening View from both views (builder loaded with the right filter, forward address included) and the two-column grid (dialog width rule, grid rules, two findings in one grid). Suite is 33/33.

**2026-11-16 (security grid blowout — right column cut off):** his screenshot of the two-column report showed the right column clipped at the dialog's edge — reason text cut mid-word, no View buttons. Measured from the screenshot: the left column's cards ran ~460–1185px while the right column started at ~1196px and ran past the dialog edge, so the grid was ~310px wider than the dialog's content box. Cause: the grid tracks were plain `1fr` (= `minmax(auto,1fr)`) and the rows are grid items with the default `min-width:auto`, so a long unbreakable filter name (the `white-space:nowrap` name in `.sec-text`) forced its track wider than the dialog — the same class of bug as the card-list overhang fixed earlier (`795d963`). Fix: tracks are now `minmax(0,1fr)` (one column) and `minmax(0,1fr) minmax(0,1fr)` (two columns), and `.sec-row` gets `min-width:0`, so a row can shrink and its name truncates with … as intended. The grid test now asserts the `minmax(0,1fr)` tracks and the row's `min-width:0`. Suite is still 33/33. (Not visually re-verified here — no browser on this box; the screenshot check is his.)

**2026-11-16 (Help me out — member list):** he asked for more detail on what a merge actually replaces. Each merge row now lists the senders being merged — one line per member, in list order, under a thin left border so they read as the group's contents — under the group's summary line. The opportunity carries a `members` array (the member `from` values); duplicate rows are unchanged, since the members are identical and the name already describes them. The grouping and dialog tests now assert the member list. Suite is still 41/41.

**2026-11-16 (Help me out — brand renames + no-label info):** he approved the rename idea and asked that the report also flag filters not applying a label, since that's the purpose of most of his filters. (1) **Renames:** a "Rename to a brand" section, grouped by derived brand, with a Rename button per group and a "Rename all (N)" in the header. `deriveBrand` takes the sender's registrable domain (last two labels, with a short two-part-suffix list so `amazon.co.uk` doesn't become `co.uk`) and title-cases its first label; labels of 3 letters or fewer are uppercased as likely acronyms (CVS, IRS, UPS, AOL). It's a heuristic — "Creditkarma", not "Credit Karma" — and each group is reviewed before applying. Only unlabeled filters whose displayed name is just "From <address>" are offered; a labeled filter already shows its label, and a custom name is left alone. Renaming only sets `f.name` — the name is never in the XML (`buildXML` writes criteria and actions only), so Gmail never sees it, and the row and the Rename-all confirm both say it doesn't apply a label. (2) **No label:** the summary now counts filters without a label, and a "No label" section lists the ones with no sender to derive a brand from (the renameable ones are already in the Rename section above, so nothing is listed twice), each with a View button that closes the report and opens the filter in the editor so a label can be added. The clean state now requires no merges, duplicates, renames, and no no-label filters. Six new tests cover `deriveBrand` (Amazon/Facebook/Nextdoor, the Creditkarma compound case, CVS uppercasing, co.uk, no sender), rename grouping (labeled, custom-named, and senderless filters skipped), applying a rename (name set, XML carries the sender but not the brand), Rename all (a "no" on the confirm leaves names untouched), and the No label section (summary counts, section order, View opening the editor). Suite is 51/51.

**2026-11-16 (Help me out — renames removed):** he reconsidered — a rename is only a local display change and does nothing to the filters on Gmail's side, so the whole rename step came out. Removed: `deriveBrand`/`registrableDomain`/`findRenameOpportunities`, `renameGroupIntoList`/`applyRename`/`applyAllRenames`, `helpRenameRow`, the "Rename to a brand" section and its Rename-all button, the `.help-badge.rename` style, the rename seam entries, and the four rename tests. The No label section stays and now lists **every** filter without a label (it had only listed the ones with no sender, since the renameable ones were in the Rename section); the summary keeps the no-label count, the clean state is back to no merges, no duplicates, and every filter applying a label, and the dialog explainer drops the rename sentence. A code comment at the no-label section records why renames aren't in the report. Suite is 47/47.
