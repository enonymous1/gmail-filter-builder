// Tests for the Gmail XML contract and validation — node:test, zero deps.
// Run: node --test tests/gmail-xml.test.js
//
// Executes the real <script> from index.html in a stub DOM and drives it
// through the window.__gmailFilterBuilder test seam. DOMParser is the
// platform's when available (Node 24+); otherwise a minimal stub for the
// test XML shape is used — the tests verify the app's mapping logic,
// not the browser's parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html");
const script = fs.readFileSync(INDEX, "utf8").match(/<script>([\s\S]*)<\/script>/)[1];

// --- Minimal DOM stubs (the app only needs these at load + render) -----
class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._attrs = {};
    this.value = "";
    this.checked = false;
    this.textContent = "";
    this.innerHTML = "";
    this.open = false;
    this.files = null;
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    this._listeners = {};
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k] ?? null; }
  querySelector() { return new El("div"); }
  querySelectorAll() { return [new El("span"), new El("span"), new El("span")]; }
  closest() { return null; }
  scrollIntoView() {}
  focus() {}
  click() {}
  dispatchEvent() { return true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function makeDocument() {
  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new El("div"));
      return byId.get(id);
    },
    createElement(tag) { return new El(tag); },
    querySelector() { return new El("div"); },
    querySelectorAll() { return []; },
  };
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(String(k), String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// Minimal DOMParser for the test XML shape only.
class FakeDOMParser {
  parseFromString(text) {
    const entries = [...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((mm) => {
      const props = [...mm[1].matchAll(/<apps:property name="([^"]*)" value="([^"]*)"\/>/g)]
        .map((p) => ({
          localName: "property",
          getAttribute: (n) => (n === "name" ? p[1] : n === "value" ? p[2] : null),
        }));
      return {
        getElementsByTagNameNS: () => props,
        getElementsByTagName: (n) => (n === "apps:property" ? props : n === "*" ? props : []),
      };
    });
    return {
      querySelector: () => null,
      getElementsByTagName: (n) => (n === "entry" ? entries : []),
    };
  }
}

function runApp(storage) {
  const state = { confirmAnswer: true };
  const sandbox = {
    document: makeDocument(),
    localStorage: storage,
    navigator: {},
    DOMParser: typeof DOMParser !== "undefined" ? DOMParser : FakeDOMParser,
    console,
    setTimeout, clearTimeout,
    Blob, URL, Event,
    confirm: () => state.confirmAnswer,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const seam = sandbox.window.__gmailFilterBuilder;
  seam._setConfirm = (v) => { state.confirmAnswer = v; };
  seam._document = sandbox.document;
  return seam;
}

const GMAIL_XML = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006">
<title>Mail Filters</title><id>tag:mail.google.com,2008:filter</id><updated>2026-11-13T00:00:00Z</updated>
${entries}</feed>`;

test("persistence: reload restores the list without duplicating starters", () => {
  const storage = makeStorage();
  let app = runApp(storage);
  assert.equal(app.getFilters().length, 2);
  assert.equal(JSON.parse(storage.getItem("gmail-filter-builder/v1")).length, 2);
  app = runApp(storage);
  assert.equal(app.getFilters().length, 2);
  assert.equal(app.getFilters()[0].name, "Newsletters");
});

test("export uses Gmail property names (shouldArchive, size)", () => {
  const app = runApp(makeStorage());
  const f = app.normalizeFilter({
    name: "Big newsletters", has: "unsubscribe", excludeChats: true,
    sizeOp: "s_sl", sizeVal: "10", sizeUnit: "s_smb",
    labels: ["Newsletters", "Archive/2026"],
    actions: { skip: true, read: true, label: "Newsletters" },
  });
  app.setFilters([f]);
  const xml = app.buildXML();
  assert.match(xml, /<id>tag:mail\.google\.com,2008:filter<\/id>/);
  assert.match(xml, /name="shouldArchive" value="true"/);
  assert.match(xml, /name="size" value="10"/);
  assert.match(xml, /name="sizeOperator" value="s_sl"/);
  assert.match(xml, /name="sizeUnit" value="s_smb"/);
  assert.match(xml, /name="excludeChats" value="true"/);
  assert.match(xml, /name="label" value="Archive\/2026"/);
  assert.doesNotMatch(xml, /name="shouldSkipArchive"/);
  assert.doesNotMatch(xml, /name="sizeValue"/);
});

test("round-trip preserves multi-label filters and excludeChats", () => {
  const app = runApp(makeStorage());
  const f = app.normalizeFilter({
    has: "unsubscribe", excludeChats: true,
    sizeOp: "s_sl", sizeVal: "10", sizeUnit: "s_smb",
    labels: ["Newsletters", "Archive/2026"],
    actions: { skip: true, label: "Newsletters" },
  });
  app.setFilters([f]);
  const rt = app.parseFiltersFromXML(app.buildXML());
  assert.equal(rt.skipped.length, 0);
  assert.equal(rt.filters.length, 1);
  assert.equal(rt.filters[0].labels.length, 2);
  assert.equal(rt.filters[0].excludeChats, true);
  assert.equal(rt.filters[0].sizeVal, "10");
});

test("legacy names import; unknown properties are reported, not swallowed", () => {
  const app = runApp(makeStorage());
  const xml = GMAIL_XML(`
<entry><category term="filter"/><title>Mail Filter</title><id>tag:mail.google.com,2008:filter:1</id><updated>2026-11-13T00:00:00Z</updated><content/>
<apps:property name="hasTheWord" value="unsubscribe"/><apps:property name="shouldArchive" value="true"/><apps:property name="label" value="Newsletters"/><apps:property name="label" value="Archive/2026"/></entry>
<entry><category term="filter"/><title>Mail Filter</title><id>tag:mail.google.com,2008:filter:2</id><updated>2026-11-13T00:00:00Z</updated><content/>
<apps:property name="from" value="a@example.com"/><apps:property name="shouldSkipArchive" value="true"/><apps:property name="sizeOperator" value="s_sl"/><apps:property name="sizeValue" value="5"/><apps:property name="sizeUnit" value="s_smb"/></entry>
<entry><category term="filter"/><title>Mail Filter</title><id>tag:mail.google.com,2008:filter:3</id><updated>2026-11-13T00:00:00Z</updated><content/>
<apps:property name="from" value="b@example.com"/><apps:property name="bogusProp" value="x"/></entry>`);
  const parsed = app.parseFiltersFromXML(xml);
  assert.equal(parsed.filters.length, 2);
  assert.equal(parsed.filters[0].labels.length, 2);
  assert.equal(parsed.filters[1].sizeVal, "5");
  assert.equal(parsed.filters[1].actions.skip, true);
  assert.equal(parsed.skipped.length, 1);
  assert.match(parsed.skipped[0].reason, /bogusProp/);
});

test("validateFilter rejects empty, bad size, bad email; enforces the 1,000 limit", () => {
  const app = runApp(makeStorage());
  const mk = (o) => app.normalizeFilter({ from: "a@b.c", actions: { star: true }, ...o });
  assert.ok(app.validateFilter(app.normalizeFilter({ actions: {} })).length >= 2);
  assert.ok(app.validateFilter(mk({ sizeOp: "s_sl", sizeVal: "10.5", sizeUnit: "s_smb" })).some((m) => /whole number/.test(m)));
  assert.ok(app.validateFilter(mk({ sizeOp: "s_sl", sizeVal: "0", sizeUnit: "s_smb" })).some((m) => /at least 1/.test(m)));
  assert.ok(app.validateFilter(mk({ actions: { forward: "not-an-email" } })).some((m) => /email address/.test(m)));
  assert.ok(app.validateFilter(mk({ actions: { label: "" } })).some((m) => /Apply a label/.test(m)));
  const many = Array.from({ length: 1000 }, (_, i) =>
    app.normalizeFilter({ name: "F" + i, from: "a" + i + "@example.com", actions: { star: true } }));
  app.setFilters(many);
  assert.ok(app.validateFilter(mk({}), true).some((m) => /1000/.test(m)));
  assert.equal(app.validateFilter(mk({}), false).filter((m) => /limit/.test(m)).length, 0);
});

test("search query uses the single size table", () => {
  const app = runApp(makeStorage());
  const q = (unit) => app.searchQuery(app.normalizeFilter({ sizeOp: "s_sl", sizeVal: "10", sizeUnit: unit, actions: { star: true } }));
  assert.equal(q("s_skb"), "larger:10K");
  assert.equal(q("s_smb"), "larger:10M");
  assert.equal(q("s_sb"), "larger:10");
});

test("modal: New filter opens a clean dialog; Edit loads the filter into it", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  app.openNewFilter();
  assert.equal(app.getDialog().open, true);
  assert.equal(doc.getElementById("builderTitle").textContent, "New filter");
  assert.equal(doc.getElementById("addBtnLabel").textContent, "Add filter");
  const f = app.normalizeFilter({ name: "VIP", from: "boss@example.com", actions: { star: true } });
  app.openEditFilter(f);
  assert.equal(doc.getElementById("builderTitle").textContent, "Edit filter");
  assert.equal(doc.getElementById("fFrom").value, "boss@example.com");
  assert.equal(doc.getElementById("addBtnLabel").textContent, "Save changes");
  // Opening New after Edit resets to a clean create (no stale editingId).
  app.openNewFilter();
  assert.equal(doc.getElementById("builderTitle").textContent, "New filter");
  assert.equal(doc.getElementById("fFrom").value, "");
});

test("examples never export; import replaces them only when it brings filters", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  // Fresh page: only the two starters, and the export is empty.
  assert.equal(app.getFilters().length, 2);
  assert.equal(app.exportableFilters().length, 0);
  assert.equal(app.buildXML().match(/<entry>/g)?.length || 0, 0);
  assert.match(doc.getElementById("filterCount").innerHTML, /<b>0<\/b> \/ 1000/);
  // Import one real filter: the starters go, the real one stays.
  app.importXMLText(GMAIL_XML(`
<entry><category term="filter"/><title>Mail Filter</title><id>tag:mail.google.com,2008:filter:1</id><updated>2026-11-13T00:00:00Z</updated><content/>
<apps:property name="from" value="real@example.com"/><apps:property name="shouldArchive" value="true"/></entry>`));
  assert.equal(app.getFilters().length, 1);
  assert.equal(app.getFilters()[0].from, "real@example.com");
  assert.equal(app.exportableFilters().length, 1);
  assert.equal(app.buildXML().match(/<entry>/g)?.length || 0, 1);
  assert.match(doc.getElementById("filterCount").innerHTML, /<b>1<\/b> \/ 1000/);
  // Importing a file that brings nothing leaves the starters in place.
  const app2 = runApp(makeStorage());
  app2.importXMLText(GMAIL_XML(`
<entry><category term="filter"/><title>Mail Filter</title><id>tag:mail.google.com,2008:filter:1</id><updated>2026-11-13T00:00:00Z</updated><content/>
<apps:property name="bogusProp" value="x"/></entry>`));
  assert.equal(app2.getFilters().length, 2);
  assert.equal(app2.exportableFilters().length, 0);
});

test("the 1,000 limit counts exportable filters only", () => {
  const app = runApp(makeStorage());
  const mk = (o) => app.normalizeFilter({ from: "a@b.c", actions: { star: true }, ...o });
  const examples = Array.from({ length: 1000 }, (_, i) =>
    app.normalizeFilter({ name: "E" + i, from: "a" + i + "@example.com", actions: { star: true }, example: true }));
  app.setFilters(examples);
  assert.equal(app.validateFilter(mk({}), true).filter((m) => /limit/.test(m)).length, 0);
});

test("action counts and filter narrow the view, never the export", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  // Fresh page: the two starters drive the counts (examples included).
  assert.match(doc.getElementById("actionCounts").textContent, /Skip the Inbox 1/);
  assert.match(doc.getElementById("actionCounts").textContent, /Apply a label 2/);
  const mk = (actions) => app.normalizeFilter({ from: "a@b.c", actions });
  app.setFilters([mk({ skip: true }), mk({ star: true }), mk({ skip: true, label: "X" })]);
  assert.match(doc.getElementById("actionCounts").textContent, /Skip the Inbox 2 · Star it 1 · Apply a label 1/);
  app.setActionFilter("star");
  assert.equal(app.getVisibleFilters().length, 1);
  assert.match(doc.getElementById("actionCounts").textContent, /showing 1 of 3/);
  assert.equal(app.buildXML().match(/<entry>/g).length, 3);
  app.setActionFilter("trash");
  assert.equal(app.getVisibleFilters().length, 0);
  assert.match(doc.getElementById("actionCounts").textContent, /showing 0 of 3/);
  app.setActionFilter("");
  assert.equal(app.getVisibleFilters().length, 3);
});

test("modal: closing with unsaved changes asks first; clean close needs no prompt", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  app.openNewFilter();
  assert.equal(app.isDialogDirty(), false);
  // Clean close: confirm must not be consulted — prove it by answering "no".
  app._setConfirm(false);
  assert.equal(app.requestCloseDialog(), true);
  assert.equal(app.getDialog().open, false);
  // Dirty close: "no" keeps it open, "yes" closes it.
  app.openNewFilter();
  doc.getElementById("fFrom").value = "someone@example.com";
  assert.equal(app.isDialogDirty(), true);
  app._setConfirm(false);
  assert.equal(app.requestCloseDialog(), false);
  assert.equal(app.getDialog().open, true);
  app._setConfirm(true);
  assert.equal(app.requestCloseDialog(), true);
  assert.equal(app.getDialog().open, false);
});

test("import modal: opens, imports, and closes on success", () => {
  const app = runApp(makeStorage());
  app.openImportDialog();
  assert.equal(app.getImportDialog().open, true);
  app.importXMLText(GMAIL_XML(`
<entry><category term="filter"/><title>Mail Filter</title><id>tag:mail.google.com,2008:filter:1</id><updated>2026-11-13T00:00:00Z</updated><content/>
<apps:property name="from" value="real@example.com"/><apps:property name="shouldArchive" value="true"/></entry>`));
  assert.equal(app.getImportDialog().open, false);
  assert.equal(app.getFilters().length, 1);
  assert.equal(app.getFilters()[0].from, "real@example.com");
});

test("cards show their position in the export order", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  // Fresh page: starters are #1 and #2, in the bottom-right footer.
  // (The stub DOM keeps every card render() ever appended, so read the
  // first render's cards; foot is the card's 4th child.)
  const list = doc.getElementById("filterList");
  assert.match(list.children[0].children[3].innerHTML, /order-num[^>]*>#1</);
  assert.match(list.children[1].children[3].innerHTML, /order-num[^>]*>#2</);
  // Under a filter, the visible card keeps its full-list position.
  const mk = (actions) => app.normalizeFilter({ from: "a@b.c", actions });
  app.setFilters([mk({ skip: true }), mk({ star: true }), mk({ trash: true })]);
  app.setActionFilter("star");
  const cards = list.children;
  assert.match(cards[cards.length - 1].children[3].innerHTML, /order-num[^>]*>#2</);
});

test("clear all asks first — even for only starters — and a cleared list stays empty after reload", () => {
  const storage = makeStorage();
  const app = runApp(storage);
  const doc = app._document;
  assert.equal(app.getFilters().length, 2);
  assert.equal(doc.getElementById("clearAllBtn").disabled, false);
  app._setConfirm(false);
  app.clearAllFilters();
  assert.equal(app.getFilters().length, 2);
  app._setConfirm(true);
  app.clearAllFilters();
  assert.equal(app.getFilters().length, 0);
  assert.equal(doc.getElementById("clearAllBtn").disabled, true);
  // Reload: the emptied list stays empty — no re-seeded starters.
  const app2 = runApp(storage);
  assert.equal(app2.getFilters().length, 0);
  // Same path with real filters present (note: app2 has its own stub DOM).
  const mk = (actions) => app2.normalizeFilter({ from: "a@b.c", actions });
  app2.setFilters([mk({ skip: true }), mk({ star: true }), mk({ trash: true })]);
  assert.equal(app2._document.getElementById("clearAllBtn").disabled, false);
  app2.clearAllFilters();
  assert.equal(app2.getFilters().length, 0);
});
