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
    this.parentNode = null;
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    this._listeners = {};
  }
  appendChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c.parentNode === this) c.parentNode = null; return c; }
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
    documentElement: new El("html"),
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
  assert.equal(app.getFilters().length, 5);
  assert.equal(JSON.parse(storage.getItem("gmail-filter-builder/v1")).length, 5);
  app = runApp(storage);
  assert.equal(app.getFilters().length, 5);
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

test("dialog delete button: hidden for New, shown for Edit; deleting removes the filter", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const f = app.normalizeFilter({ name: "VIP", from: "boss@example.com", actions: { star: true } });
  app.setFilters([f]);
  // New filter: no delete button — there is nothing to delete yet.
  app.openNewFilter();
  assert.equal(doc.getElementById("deleteBtn").hidden, true);
  // Edit: the delete button shows, and deleting removes the filter.
  app.openEditFilter(f);
  assert.equal(doc.getElementById("deleteBtn").hidden, false);
  doc.getElementById("deleteBtn")._listeners.click[0]();
  assert.equal(app.getFilters().length, 0);
  assert.equal(app.getDialog().open, false);
  assert.equal(doc.getElementById("deleteBtn").hidden, true);
});

test("deleting a filter asks first; a no leaves it in place", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const f = app.normalizeFilter({ name: "VIP", from: "boss@example.com", actions: { star: true } });
  app.setFilters([f]);
  // Dialog delete: "no" keeps the filter and the dialog stays open.
  app.openEditFilter(f);
  app._setConfirm(false);
  doc.getElementById("deleteBtn")._listeners.click[0]();
  assert.equal(app.getFilters().length, 1);
  assert.equal(app.getDialog().open, true);
  app._setConfirm(true);
  doc.getElementById("deleteBtn")._listeners.click[0]();
  assert.equal(app.getFilters().length, 0);
  assert.equal(app.getDialog().open, false);
  // Card delete: same ask-first, via the trash button (top > buttons > third).
  const g = app.normalizeFilter({ name: "News", from: "news@example.com", actions: { skip: true } });
  app.setFilters([g]);
  const card = doc.getElementById("filterList").children[0];
  const delBtn = card.children[0].children[1].children[2];
  app._setConfirm(false);
  delBtn._listeners.click[0]();
  assert.equal(app.getFilters().length, 1);
  app._setConfirm(true);
  delBtn._listeners.click[0]();
  assert.equal(app.getFilters().length, 0);
});

test("theme toggle: button names the theme it switches to; choice persists", () => {
  const storage = makeStorage();
  const app = runApp(storage);
  const doc = app._document;
  // No saved choice: the stub has no matchMedia, so the system reads light.
  assert.equal(app.getTheme(), "light");
  assert.equal(doc.getElementById("themeLabel").textContent, "Dark");
  assert.equal(doc.documentElement.getAttribute("data-theme"), null);
  // Toggle to dark: attribute set, choice saved, button flips.
  doc.getElementById("themeBtn")._listeners.click[0]();
  assert.equal(app.getTheme(), "dark");
  assert.equal(doc.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(doc.getElementById("themeLabel").textContent, "Light");
  assert.equal(storage.getItem("gmail-filter-builder/theme"), "dark");
  // A fresh page with the saved choice applies it on load.
  const app2 = runApp(storage);
  const doc2 = app2._document;
  assert.equal(app2.getTheme(), "dark");
  assert.equal(doc2.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(doc2.getElementById("themeLabel").textContent, "Light");
});

test("theme override blocks carry the light and dark palettes", () => {
  const html = fs.readFileSync(INDEX, "utf8");
  assert.match(html, /html\[data-theme="light"\]\{[^}]*--bg:#f6f4ef/);
  assert.match(html, /html\[data-theme="dark"\]\{[^}]*--bg:#121416/);
});

test("primary button is green and the dialog delete button is filled red", () => {
  const html = fs.readFileSync(INDEX, "utf8");
  assert.match(html, /\.btn\.primary\{background:var\(--green\);border-color:var\(--green\);color:#fff\}/);
  assert.match(html, /\.btn\.red\{background:var\(--red\);border-color:var\(--red\);color:#fff\}/);
  assert.match(html, /\.btn\[hidden\]\{display:none\}/);
});

test("examples never export; import replaces them only when it brings filters", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  // Fresh page: only the five starters, and the export is empty.
  assert.equal(app.getFilters().length, 5);
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
  assert.equal(app2.getFilters().length, 5);
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
  const box = doc.getElementById("actionCounts");
  // The stub DOM keeps every pill render() ever appended, so the newest
  // render's pills are the tail of the button children.
  const latestPills = (n) => box.children.filter((c) => c.tagName === "BUTTON").slice(-n);
  const pillText = (n) => latestPills(n).map((c) => c.textContent).join(" · ");
  const latestShowing = () => {
    const spans = box.children.filter((c) => c.tagName === "SPAN");
    return spans.length ? spans[spans.length - 1].textContent : "";
  };
  // Fresh page: the five starters drive the counts (examples included).
  assert.match(pillText(7), /Skip the Inbox 2 · Mark as read 2 · Star it 3 · Apply a label 3/);
  const mk = (actions) => app.normalizeFilter({ from: "a@b.c", actions });
  app.setFilters([mk({ skip: true }), mk({ star: true }), mk({ skip: true, label: "X" })]);
  assert.match(pillText(3), /Skip the Inbox 2 · Star it 1 · Apply a label 1/);
  app.setActionFilter("star");
  assert.equal(app.getVisibleFilters().length, 1);
  assert.match(latestShowing(), /showing 1 of 3/);
  assert.equal(app.buildXML().match(/<entry>/g).length, 3);
  app.setActionFilter("trash");
  assert.equal(app.getVisibleFilters().length, 0);
  assert.match(latestShowing(), /showing 0 of 3/);
  app.setActionFilter("");
  assert.equal(app.getVisibleFilters().length, 3);
});

test("action count pills set and clear the view filter", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const box = doc.getElementById("actionCounts");
  // Newest pill with a given label (the stub keeps every render's pills).
  const findPill = (label) => {
    for (let i = box.children.length - 1; i >= 0; i--) {
      const c = box.children[i];
      if (c.tagName === "BUTTON" && c.textContent.startsWith(label)) return c;
    }
    return null;
  };
  const star = findPill("Star it");
  assert.ok(star);
  assert.equal(star.getAttribute("aria-pressed"), "false");
  star._listeners.click[0]();
  assert.equal(app.getVisibleFilters().length, 3);
  assert.equal(findPill("Star it").getAttribute("aria-pressed"), "true");
  // Clicking the active pill again clears the filter.
  findPill("Star it")._listeners.click[0]();
  assert.equal(app.getVisibleFilters().length, 5);
});

test("search narrows the cards by name, address, or label", () => {
  const app = runApp(makeStorage());
  const mk = (o) => app.normalizeFilter(o);
  app.setFilters([
    mk({ name: "Amazon orders", from: "orders@amazon.com", actions: { label: "Shopping" } }),
    mk({ name: "Bank alerts", from: "alerts@bank.com", actions: { star: true } }),
    mk({ name: "Newsletters", has: "unsubscribe", actions: { skip: true } }),
  ]);
  app.setSearch("amazon");
  assert.equal(app.getVisibleFilters().length, 1);
  assert.equal(app.getVisibleFilters()[0].name, "Amazon orders");
  app.setSearch("BANK"); // case-insensitive
  assert.equal(app.getVisibleFilters().length, 1);
  app.setSearch("shopping"); // label match
  assert.equal(app.getVisibleFilters().length, 1);
  app.setSearch("amazon bank"); // every word must match
  assert.equal(app.getVisibleFilters().length, 0);
  app.setSearch("");
  assert.equal(app.getVisibleFilters().length, 3);
  // Search composes with the action pill.
  app.setSearch("alerts");
  app.setActionFilter("star");
  assert.equal(app.getVisibleFilters().length, 1);
  app.setActionFilter("trash");
  assert.equal(app.getVisibleFilters().length, 0);
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
  // Fresh page: starters are #1 and #2, in the bottom-right footer
  // (foot is the card's 4th child).
  const list = doc.getElementById("filterList");
  assert.match(list.children[0].children[3].innerHTML, /order-num[^>]*>#1</);
  assert.match(list.children[1].children[3].innerHTML, /order-num[^>]*>#2</);
  // Under a filter, the visible card keeps its full-list position — the
  // hidden cards are still there, only display:none.
  const mk = (actions) => app.normalizeFilter({ from: "a@b.c", actions });
  app.setFilters([mk({ skip: true }), mk({ star: true }), mk({ trash: true })]);
  app.setActionFilter("star");
  const visible = list.children.filter((c) => c.style.display !== "none");
  assert.equal(visible.length, 1);
  assert.match(visible[0].children[3].innerHTML, /order-num[^>]*>#2</);
});

test("pill click and search reuse the card elements instead of rebuilding", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (o) => app.normalizeFilter(o);
  app.setFilters([
    mk({ name: "Amazon orders", from: "orders@amazon.com", actions: { label: "Shopping" } }),
    mk({ name: "Bank alerts", from: "alerts@bank.com", actions: { star: true } }),
    mk({ name: "Newsletters", has: "unsubscribe", actions: { skip: true } }),
  ]);
  const list = doc.getElementById("filterList");
  const before = list.children.slice();
  assert.equal(before.length, 3);
  // Pill click: same elements, same order, only visibility changes.
  app.setActionFilter("star");
  assert.equal(list.children.length, 3);
  before.forEach((c, i) => assert.equal(list.children[i], c));
  assert.equal(list.children.filter((c) => c.style.display !== "none").length, 1);
  assert.equal(list.children[1].style.display, "");
  // Search: same again.
  app.setActionFilter("");
  app.setSearch("amazon");
  before.forEach((c, i) => assert.equal(list.children[i], c));
  assert.equal(list.children.filter((c) => c.style.display !== "none").length, 1);
  assert.equal(list.children[0].style.display, "");
  // Clearing both shows everything again — still the same elements.
  app.setSearch("");
  assert.equal(list.children.filter((c) => c.style.display !== "none").length, 3);
  before.forEach((c, i) => assert.equal(list.children[i], c));
});

test("adding and removing a filter keeps the other cards and renumbers", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (o) => app.normalizeFilter(o);
  const a = mk({ name: "A", from: "a@example.com", actions: { star: true } });
  const b = mk({ name: "B", from: "b@example.com", actions: { skip: true } });
  app.setFilters([a, b]);
  const list = doc.getElementById("filterList");
  const cardA = list.children[0], cardB = list.children[1];
  assert.match(cardB.children[3].innerHTML, /order-num[^>]*>#2</);
  // Add a third: the first two cards are the same elements.
  const c = mk({ name: "C", from: "c@example.com", actions: { trash: true } });
  app.setFilters([a, b, c]);
  assert.equal(list.children.length, 3);
  assert.equal(list.children[0], cardA);
  assert.equal(list.children[1], cardB);
  const cardC = list.children[2];
  assert.match(cardC.children[3].innerHTML, /order-num[^>]*>#3</);
  // Remove the middle one: the survivors keep their elements, C renumbers to #2.
  app.setFilters([a, c]);
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0], cardA);
  assert.equal(list.children[1], cardC);
  assert.match(list.children[1].children[3].innerHTML, /order-num[^>]*>#2</);
});

test("long filter names live in their own span so they truncate instead of wrapping", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const longName = "From notifications@notifications3.creditkarma.com";
  const f = app.normalizeFilter({ name: longName, from: "notifications@notifications3.creditkarma.com", actions: { skip: true } });
  const ex = app.normalizeFilter({ name: "Newsletters", has: "unsubscribe", actions: { skip: true }, example: true });
  app.setFilters([f, ex]);
  const list = doc.getElementById("filterList");
  const card = list.children[0];
  // The name is a span.fc-name holding the full name (plus a hover
  // tooltip); the h3 holds it as its first child.
  assert.equal(card._els.title.className, "fc-name");
  assert.equal(card._els.title.textContent, longName);
  assert.equal(card._els.title.title, longName);
  assert.equal(card._els.h3.children[0], card._els.title);
  // The Example badge is the h3's second child — beside the truncating
  // span, never inside it (or it would be cut off with the name).
  const exCard = list.children[1];
  assert.equal(exCard._els.badge.textContent, "Example");
  assert.equal(exCard._els.h3.children[1], exCard._els.badge);
});

test("every truncatable bit of card text carries its full text as a hover tooltip", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const f = app.normalizeFilter({ name: "Stir", from: "gruwwl3hpfjfs2krg43w223uojbuqyjujzuvqrdbordvc2kkmvza===@talk.stir.com", actions: { skip: true, label: "A very long label name that will not fit" } });
  app.setFilters([f]);
  const card = doc.getElementById("filterList").children[0];
  // Title, search line, and every chip: the tooltip is the full text.
  assert.equal(card._els.title.title, card._els.title.textContent);
  assert.equal(card._els.title.title, "Stir");
  assert.equal(card._els.search.title, card._els.search.textContent);
  assert.equal(card._els.search.title, "from:(gruwwl3hpfjfs2krg43w223uojbuqyjujzuvqrdbordvc2kkmvza===@talk.stir.com)");
  const chipTexts = (box) => box.children.slice(1).map((c) => [c.textContent, c.title]);
  assert.deepEqual(chipTexts(card._els.matches).map((p) => p.join("|")).join(";"), "From: gruwwl3hpfjfs2krg43w223uojbuqyjujzuvqrdbordvc2kkmvza===@talk.stir.com|From: gruwwl3hpfjfs2krg43w223uojbuqyjujzuvqrdbordvc2kkmvza===@talk.stir.com");
  const acts = chipTexts(card._els.actions);
  assert.equal(acts.length, 2);
  acts.forEach((p) => assert.equal(p[1], p[0]));
  assert.equal(acts[1][0], "Label: A very long label name that will not fit");
});

test("editing a filter refreshes its card in place", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const f = app.normalizeFilter({ name: "Old name", from: "a@example.com", actions: { star: true } });
  app.setFilters([f]);
  const list = doc.getElementById("filterList");
  const card = list.children[0];
  assert.equal(card._els.title.textContent, "Old name");
  // Edit through the dialog: rename it (the from address stays loaded).
  app.openEditFilter(f);
  // A label-less filter must load with the label/forward/category boxes
  // unticked — normalizeFilter() fills those with "", which used to read
  // as "on" and made Save fail validation on the empty text.
  assert.equal(doc.getElementById("a_label").checked, false);
  assert.equal(doc.getElementById("a_forward").checked, false);
  assert.equal(doc.getElementById("a_category").checked, false);
  assert.equal(doc.getElementById("a_star").checked, true);
  doc.getElementById("fName").value = "New name";
  doc.getElementById("addBtn")._listeners.click[0]();
  assert.equal(app.getFilters().length, 1);
  assert.equal(app.getFilters()[0].name, "New name");
  // Same card element, refreshed content.
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0], card);
  assert.equal(card._els.title.textContent, "New name");
});

test("loadExamples loads one example per template, none exportable", () => {
  const app = runApp(makeStorage());
  app._setConfirm(true);
  app.clearAllFilters();
  assert.equal(app.getFilters().length, 0);
  app.loadExamples();
  assert.equal(app.getFilters().length, 5);
  // (join, not deepEqual: the app runs in a vm realm, so its arrays
  // have a different prototype and strict deep-equality rejects them.)
  assert.equal(app.getFilters().map((f) => f.name).join("|"), "Newsletters|Receipts|Social alerts|Large mail|VIP");
  assert.equal(app.getFilters().every((f) => f.example), true);
  assert.equal(app.exportableFilters().length, 0);
});

test("clear all asks first — even for only starters — and a cleared list stays empty after reload", () => {
  const storage = makeStorage();
  const app = runApp(storage);
  const doc = app._document;
  assert.equal(app.getFilters().length, 5);
  assert.equal(doc.getElementById("clearAllBtn").disabled, false);
  app._setConfirm(false);
  app.clearAllFilters();
  assert.equal(app.getFilters().length, 5);
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

test("step titles are the only block bold in a step card", () => {
  const html = fs.readFileSync(INDEX, "utf8");
  // The title rule must target the direct-child <b> only: a plain
  // ".step b" selector also turns the bold phrases inside the step
  // text into blocks, stranding their punctuation at line starts.
  assert.match(html, /\.step > b\{/);
  assert.doesNotMatch(html, /\.step b\{/);
});

test("security check flags forwarding, match-all, sensitive hiding, and never-spam-plus-skip", () => {
  const app = runApp(makeStorage());
  const check = app.securityCheck;
  const mk = (data) => app.normalizeFilter(data);
  // 1. Forwarding to another address: high, with the address in the reason.
  let fwd = check([mk({ from: "a@b.com", actions: { forward: "someone@else.com" } })]);
  assert.equal(fwd.length, 1);
  assert.equal(fwd[0].level, "high");
  assert.equal(fwd[0].rule, "forward");
  assert.ok(fwd[0].reason.indexOf("someone@else.com") !== -1);
  // 2. Matches everything, then deletes it: high. No criteria and no
  // action at all is harmless and is not flagged.
  let all = check([mk({ actions: { trash: true } })]);
  assert.equal(all.length, 1);
  assert.equal(all[0].level, "high");
  assert.equal(all[0].rule, "match-all");
  assert.equal(check([mk({})]).length, 0);
  // 3. Hides mail from a sensitive sender: medium. The same sender
  // without Skip Inbox, and Skip Inbox without a sensitive sender,
  // are both clean.
  let sens = check([mk({ from: "alerts@mybank.com", actions: { skip: true } })]);
  assert.equal(sens.length, 1);
  assert.equal(sens[0].level, "medium");
  assert.equal(sens[0].rule, "sensitive");
  assert.equal(check([mk({ from: "alerts@mybank.com", actions: { star: true } })]).length, 0);
  assert.equal(check([mk({ from: "news@x.com", actions: { skip: true } })]).length, 0);
  // 4. Never Spam plus Skip Inbox: medium. Either one alone is clean.
  let ns = check([mk({ from: "news@x.com", actions: { neverspam: true, skip: true } })]);
  assert.equal(ns.length, 1);
  assert.equal(ns[0].level, "medium");
  assert.equal(ns[0].rule, "neverspam-skip");
  assert.equal(check([mk({ from: "news@x.com", actions: { neverspam: true } })]).length, 0);
  // A plain filter with a label is clean.
  assert.equal(check([mk({ from: "news@x.com", actions: { skip: true, label: "News" } })]).length, 0);
});

test("security check runs on exportable filters only — starters are not real filters", () => {
  const app = runApp(makeStorage());
  const ex = app.normalizeFilter({ from: "a@b.com", actions: { forward: "someone@else.com" } });
  ex.example = true;
  const real = app.normalizeFilter({ from: "news@x.com", actions: { skip: true } });
  app.setFilters([ex, real]);
  assert.equal(app.securityCheck(app.exportableFilters()).length, 0);
});

test("table view renders one row per filter with name and pills, and three row buttons", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ name: "News", from: "news@x.com", actions: { skip: true, label: "News" } }),
    mk({ name: "Starred", from: "a@b.com", actions: { star: true, forward: "me@other.com" } }),
  ]);
  app.setViewMode("table");
  assert.equal(doc.getElementById("filterTableWrap").style.display, "");
  assert.equal(doc.getElementById("filterList").style.display, "none");
  const rows = doc.getElementById("filterTableBody").children.filter((c) => c._els);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]._els.num.textContent, "#1");
  assert.equal(rows[0]._els.name.textContent, "News");
  assert.equal(rows[0]._els.name.title, "News");
  // The matches/actions cells hold the same pills as the card, not
  // one truncated line — each pill carries its own text on hover, and
  // the cell's tooltip holds the whole list.
  const chipTexts = (box) => box.children.map((c) => c.textContent);
  assert.equal(chipTexts(rows[0]._els.matches).join("|"), "From: news@x.com");
  assert.equal(rows[0]._els.matches.title, "From: news@x.com");
  assert.equal(chipTexts(rows[0]._els.actions).join("|"), "Skip Inbox|Label: News");
  assert.equal(rows[0]._els.actions.title, "Skip Inbox · Label: News");
  assert.equal(rows[1]._els.num.textContent, "#2");
  assert.equal(chipTexts(rows[1]._els.actions).join("|"), "Star it|Forward to me@other.com");
  // Three row buttons (Edit, Duplicate, Delete) — no move arrows.
  assert.equal(rows[0].children[4].children.length, 3);
  assert.equal(rows[0]._els.up, undefined);
  assert.equal(rows[0]._els.down, undefined);
});

test("table view choice persists across reload", () => {
  const storage = makeStorage();
  const app = runApp(storage);
  app.setViewMode("table");
  assert.equal(app.getViewMode(), "table");
  assert.equal(app._document.getElementById("viewTableBtn").getAttribute("aria-pressed"), "true");
  const app2 = runApp(storage);
  assert.equal(app2.getViewMode(), "table");
  assert.equal(app2._document.getElementById("filterTableWrap").style.display, "");
  assert.equal(app2._document.getElementById("filterList").style.display, "none");
  app2.setViewMode("cards");
  const app3 = runApp(storage);
  assert.equal(app3.getViewMode(), "cards");
  assert.equal(app3._document.getElementById("filterTableWrap").style.display, "none");
});

test("sorting by name reorders the display only; # still shows the true export position", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ name: "Bravo", from: "b@x.com", actions: { skip: true } }),
    mk({ name: "Alpha", from: "a@x.com", actions: { skip: true } }),
    mk({ name: "Charlie", from: "c@x.com", actions: { skip: true } }),
  ]);
  app.setViewMode("table");
  const rows = () => doc.getElementById("filterTableBody").children.filter((c) => c._els);
  assert.equal(rows().map((r) => r._els.name.textContent).join(","), "Bravo,Alpha,Charlie");
  app.setTableSort("name");
  assert.equal(rows().map((r) => r._els.name.textContent).join(","), "Alpha,Bravo,Charlie");
  // # is the true export position, not the display position.
  assert.equal(rows().map((r) => r._els.num.textContent).join(","), "#2,#1,#3");
  // The model (and the export) is untouched by a display sort.
  assert.equal(app.getFilters().map((f) => f.name).join(","), "Bravo,Alpha,Charlie");
  // Sorting by name again reverses it; sorting by # restores list order.
  app.setTableSort("name");
  assert.equal(rows().map((r) => r._els.name.textContent).join(","), "Charlie,Bravo,Alpha");
  app.setTableSort("num");
  assert.equal(rows().map((r) => r._els.name.textContent).join(","), "Bravo,Alpha,Charlie");
});

test("the action pill and search hide table rows too", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ name: "Starred", from: "a@x.com", actions: { star: true } }),
    mk({ name: "Plain", from: "b@x.com", actions: { skip: true } }),
  ]);
  app.setViewMode("table");
  const rows = () => doc.getElementById("filterTableBody").children.filter((c) => c._els);
  app.setActionFilter("star");
  assert.equal(rows()[0].style.display, "");
  assert.equal(rows()[1].style.display, "none");
  app.setActionFilter("");
  assert.equal(rows()[1].style.display, "");
  app.setSearch("plain");
  assert.equal(rows()[0].style.display, "none");
  assert.equal(rows()[1].style.display, "");
});

test("cards have no drag handle and are not draggable", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const html = fs.readFileSync(INDEX, "utf8");
  // No card-drag machinery left in the page at all (the import dialog's
  // file drop zone still uses dragover/drop, and stays).
  assert.doesNotMatch(html, /dragId|draggable|drag-handle|dragstart|drop-target/);
  const card = doc.getElementById("filterList").children[0];
  assert.ok(!card.draggable);
  // The card top row is just the title and the buttons — no grip.
  assert.equal(card.children[0].children.length, 2);
});

test("table pills are capped at two rows visually but every pill is in the DOM", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const html = fs.readFileSync(INDEX, "utf8");
  // The cap is a max-height on the pill container: two chip rows plus
  // the gap, with the third row clipped.
  assert.match(html, /\.table-chips\{[^}]*max-height:64px;overflow:hidden/);
  const f = app.normalizeFilter({
    from: "a@b.com", to: "c@d.com", subject: "hello", has: "invoice",
    hasNot: "spam", attach: true, sizeOp: "s_sl", sizeVal: "5", sizeUnit: "s_smb",
    actions: { skip: true, read: true, star: true, label: "L", category: "^smartlabel_personal", forward: "x@y.com", trash: true, neverspam: true, alwaysimp: true, neverimp: true },
  });
  app.setFilters([f]);
  app.setViewMode("table");
  const row = doc.getElementById("filterTableBody").children.filter((c) => c._els)[0];
  assert.equal(row._els.matches.className, "table-chips");
  assert.equal(row._els.matches.children.length, 7);
  assert.equal(row._els.actions.className, "table-chips");
  assert.equal(row._els.actions.children.length, 10);
  // The full list is still reachable on hover.
  assert.ok(row._els.matches.title.indexOf("From: a@b.com") !== -1);
  assert.ok(row._els.actions.title.indexOf("Forward to x@y.com") !== -1);
});

test("security View opens the filter in the editor, from either view", () => {
  const mk = (app, data) => app.normalizeFilter(data);
  // Open the report, click the first finding's View button, return the doc.
  const openFirstView = (app) => {
    const doc = app._document;
    app.openSecurityDialog();
    const results = doc.getElementById("securityResults");
    const grid = results.children[0].children[1]; // first group → its grid
    const viewBtn = grid.children[0].children[2]; // first row → View button
    viewBtn._listeners.click[0]();
    return doc;
  };
  // Cards view.
  let app = runApp(makeStorage());
  app.setFilters([mk(app, { name: "Fwd", from: "a@b.com", actions: { forward: "someone@else.com" } })]);
  let doc = openFirstView(app);
  assert.equal(doc.getElementById("filterDialog").open, true);
  assert.equal(doc.getElementById("builderTitle").textContent, "Edit filter");
  assert.equal(doc.getElementById("fName").value, "Fwd");
  assert.equal(doc.getElementById("a_forward").checked, true);
  assert.equal(doc.getElementById("aForwardText").value, "someone@else.com");
  // Table view — the old scroll-to-card path never worked here.
  app = runApp(makeStorage());
  app.setFilters([mk(app, { name: "Fwd", from: "a@b.com", actions: { forward: "someone@else.com" } })]);
  app.setViewMode("table");
  doc = openFirstView(app);
  assert.equal(doc.getElementById("filterDialog").open, true);
  assert.equal(doc.getElementById("fName").value, "Fwd");
  assert.equal(doc.getElementById("a_forward").checked, true);
});

test("security findings lay out in a two-column grid on wide displays", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const html = fs.readFileSync(INDEX, "utf8");
  // The dialog widens to the builder's width, and the findings grid
  // goes two columns, at the same 860px breakpoint. The tracks are
  // minmax(0,1fr) and the rows min-width:0 — plain 1fr is minmax(auto,1fr),
  // and a long unbreakable name in a row forced its track wider than the
  // dialog, so the right column was cut off with its View buttons gone.
  assert.match(html, /@media \(min-width:860px\)\{[\s\S]*?dialog\.security-dialog\{max-width:920px\}/);
  assert.match(html, /\.sec-grid\{display:grid;grid-template-columns:minmax\(0,1fr\);gap:8px\}/);
  assert.match(html, /\.sec-grid\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)\}/);
  assert.match(html, /\.sec-row\{[^}]*min-width:0/);
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ name: "A", from: "a@b.com", actions: { forward: "x@y.com" } }),
    mk({ name: "B", from: "b@c.com", actions: { forward: "x@y.com" } }),
  ]);
  app.openSecurityDialog();
  const results = doc.getElementById("securityResults");
  const grid = results.children[0].children[1];
  assert.equal(grid.className, "sec-grid");
  assert.equal(grid.children.length, 2);
});

test("help review groups same-domain same-action filters for merging", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  const list = [
    mk({ from: "a@x.com", actions: { skip: true, label: "News" } }),
    mk({ from: "b@x.com", actions: { skip: true, label: "News" } }),
    mk({ from: "c@x.com", actions: { skip: true, label: "News" } }),
    // Same domain, different actions — not the same group.
    mk({ from: "d@x.com", actions: { star: true } }),
    // Same domain and actions, but a different subject — merging
    // would drop the subject, so it stays out of the group.
    mk({ from: "e@x.com", subject: "invoice", actions: { skip: true, label: "News" } }),
    // No From — nothing to group by domain.
    mk({ subject: "hello", actions: { skip: true } }),
    // A compound From — not a single domain.
    mk({ from: "(a@y.com OR b@y.com)", actions: { skip: true } }),
  ];
  const opp = app.findHelpOpportunities(list);
  assert.equal(opp.merges.length, 1);
  assert.equal(opp.merges[0].domain, "x.com");
  assert.equal(opp.merges[0].count, 3);
  assert.equal(opp.merges[0].slotsFreed, 2);
  assert.equal(opp.merges[0].actions, "Skip Inbox · Label: News");
  assert.equal(opp.merges[0].criteria, "");
  assert.equal(opp.merges[0].members.join(","), "a@x.com,b@x.com,c@x.com");
  assert.equal(opp.duplicates.length, 0);
});

test("a bare-domain From groups with per-sender filters from that domain", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  const list = [
    mk({ from: "@x.com", actions: { skip: true } }),
    mk({ from: "a@x.com", actions: { skip: true } }),
  ];
  const opp = app.findHelpOpportunities(list);
  assert.equal(opp.merges.length, 1);
  assert.equal(opp.merges[0].count, 2);
});

test("help review groups subdomains of the same registrable domain for merging", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  const list = [
    mk({ from: "mail@mail8.creditkarma.com", actions: { skip: true, label: "Creditkarma" } }),
    mk({ from: "mail@mail4.creditkarma.com", actions: { skip: true, label: "Creditkarma" } }),
    mk({ from: "notifications@notifications5.creditkarma.com", actions: { skip: true, label: "Creditkarma" } }),
    // The bare registrable domain — same company, same group.
    mk({ from: "notifications@creditkarma.com", actions: { skip: true, label: "Creditkarma" } }),
    // A different registrable domain, even with the same label —
    // its sender is genuinely elsewhere, so it stays out.
    mk({ from: "info@mail.seedfi.com", actions: { skip: true, label: "Creditkarma" } }),
    // Same company, different actions (never spam) — a separate group.
    mk({ from: "notifications@mail9.creditkarma.com", actions: { skip: true, label: "Creditkarma", neverspam: true } }),
    mk({ from: "notifications@mail6.creditkarma.com", actions: { skip: true, label: "Creditkarma", neverspam: true } }),
  ];
  const opp = app.findHelpOpportunities(list);
  assert.equal(opp.merges.length, 2);
  const plain = opp.merges.find((m) => m.actions.indexOf("Never to Spam") === -1);
  const never = opp.merges.find((m) => m.actions.indexOf("Never to Spam") !== -1);
  assert.equal(plain.domain, "creditkarma.com");
  assert.equal(plain.count, 4);
  assert.equal(plain.domains.join(","), "mail8.creditkarma.com,mail4.creditkarma.com,notifications5.creditkarma.com,creditkarma.com");
  assert.equal(plain.slotsFreed, 3);
  assert.equal(never.domain, "creditkarma.com");
  assert.equal(never.count, 2);
  assert.equal(never.domains.join(","), "mail9.creditkarma.com,mail6.creditkarma.com");
});

test("applying a subdomain merge builds an explicit OR of the subdomains", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "mail@mail8.creditkarma.com", actions: { skip: true, label: "Creditkarma" } }),
    mk({ from: "mail@mail4.creditkarma.com", actions: { skip: true, label: "Creditkarma" } }),
    mk({ from: "notifications@creditkarma.com", actions: { skip: true, label: "Creditkarma" } }),
  ]);
  const opp = app.findHelpOpportunities(app.getFilters());
  assert.equal(opp.merges.length, 1);
  app.applyMerge(opp.merges[0].ids);
  const after = app.getFilters();
  assert.equal(after.length, 1);
  // An explicit OR of the subdomains — it matches exactly the
  // senders it came from, whether or not Gmail's bare
  // "@creditkarma.com" would also match its subdomains.
  assert.equal(after[0].from, "{@mail8.creditkarma.com @mail4.creditkarma.com @creditkarma.com}");
  assert.equal(after[0].name, "Creditkarma");
  assert.equal(after[0].actions.skip, true);
  assert.equal(after[0].actions.label, "Creditkarma");
  // The XML carries the OR in the from property.
  const xml = app.buildXML();
  assert.ok(xml.indexOf('name="from" value="{@mail8.creditkarma.com @mail4.creditkarma.com @creditkarma.com}"') !== -1);
});

test("help review finds exact duplicates and ignores near-misses", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  // No From here, so the duplicates can't also be a merge group.
  const list = [
    mk({ subject: "hello", actions: { skip: true } }),
    mk({ subject: "hello", actions: { skip: true } }),
    // Same criteria, different action — not a duplicate.
    mk({ subject: "hello", actions: { skip: true, star: true } }),
    // Same actions, different criteria — not a duplicate.
    mk({ subject: "bye", actions: { skip: true } }),
  ];
  const opp = app.findHelpOpportunities(list);
  assert.equal(opp.duplicates.length, 1);
  assert.equal(opp.duplicates[0].count, 2);
  assert.equal(opp.duplicates[0].slotsFreed, 1);
  assert.equal(opp.merges.length, 0);
});

test("applying a merge replaces the group with one domain filter", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ name: "A", from: "a@x.com", actions: { skip: true, label: "News" } }),
    mk({ name: "B", from: "b@x.com", actions: { skip: true, label: "News" } }),
    mk({ name: "C", from: "c@x.com", actions: { skip: true, label: "News" } }),
    mk({ name: "Other", from: "z@y.com", actions: { star: true } }),
  ]);
  const opp = app.findHelpOpportunities(app.getFilters());
  assert.equal(opp.merges.length, 1);
  app.applyMerge(opp.merges[0].ids);
  const after = app.getFilters();
  assert.equal(after.length, 2);
  // The merged filter sits where the group started, points at the
  // domain, and carries the shared actions and label.
  assert.equal(after[0].from, "@x.com");
  assert.equal(after[0].actions.skip, true);
  assert.equal(after[0].actions.label, "News");
  assert.equal(after[0].name, "News");
  assert.equal(after[1].name, "Other");
  assert.equal(app.searchQuery(after[0]), "from:(@x.com)");
});

test("applying a duplicate fix keeps one and removes the rest", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ name: "First", from: "a@x.com", actions: { skip: true } }),
    mk({ name: "Copy", from: "a@x.com", actions: { skip: true } }),
    mk({ name: "Other", from: "z@y.com", actions: { star: true } }),
  ]);
  const opp = app.findHelpOpportunities(app.getFilters());
  assert.equal(opp.duplicates.length, 1);
  app.applyDuplicates(opp.duplicates[0].ids);
  const after = app.getFilters();
  assert.equal(after.length, 2);
  assert.equal(after[0].name, "First");
  assert.equal(after[1].name, "Other");
});

test("help dialog lists the groups and applying one refreshes the report", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "a@x.com", actions: { skip: true, label: "News" } }),
    mk({ from: "b@x.com", actions: { skip: true, label: "News" } }),
    mk({ from: "c@x.com", actions: { skip: true, label: "News" } }),
  ]);
  app.openHelpDialog();
  const results = doc.getElementById("helpResults");
  const grid = results.children[0].children[1]; // first group → its grid
  assert.equal(grid.className, "help-grid");
  assert.equal(grid.children.length, 1);
  const row = grid.children[0];
  assert.equal(row.children[0].textContent, "Merge");
  assert.ok(row.children[1].children[0].textContent.indexOf("@x.com") !== -1);
  // The actions and the result are separate lines now, so the gain
  // doesn't blend into the action list: the actions line, then a
  // meta line whose bold part is the slots freed.
  assert.equal(row.children[1].children[1].textContent, "Skip Inbox · Label: News");
  const meta = row.children[1].children[2];
  assert.equal(meta.className, "help-meta");
  assert.equal(meta.children[0].textContent, "Frees 2 slots");
  // The stub's textContent doesn't aggregate children, so read the
  // note span itself.
  assert.ok(meta.children[1].textContent.indexOf("also matches future senders") !== -1);
  // The row lists the senders being merged, in list order, so the
  // user can see what the one filter replaces.
  const members = row.children[1].children[3];
  assert.equal(members.className, "help-members");
  assert.equal(members.children.length, 3);
  assert.equal(members.children[0].textContent, "a@x.com");
  assert.equal(members.children[1].textContent, "b@x.com");
  assert.equal(members.children[2].textContent, "c@x.com");
  // Click Merge — the group collapses to one domain filter and the
  // report re-renders to the clean state.
  row.children[2]._listeners.click[0]();
  assert.equal(app.getFilters().length, 1);
  assert.equal(app.getFilters()[0].from, "@x.com");
  assert.ok(doc.getElementById("helpSummary").textContent.indexOf("No merges or duplicates found") !== -1);
});

test("help review reports clean when nothing can merge or duplicate", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "a@x.com", actions: { skip: true, label: "News" } }),
    mk({ from: "b@y.com", actions: { star: true, label: "Star" } }),
  ]);
  app.openHelpDialog();
  assert.ok(doc.getElementById("helpSummary").textContent.indexOf("No merges or duplicates found") !== -1);
});

test("help grid uses minmax(0,1fr) so long names can't blow it out", () => {
  const html = fs.readFileSync(INDEX, "utf8");
  assert.match(html, /\.help-grid\{display:grid;grid-template-columns:minmax\(0,1fr\);gap:8px\}/);
  assert.match(html, /\.help-grid\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)\}/);
  assert.match(html, /\.help-row\{[^}]*min-width:0/);
  assert.match(html, /dialog\.help-dialog\{max-width:920px\}/);
});

test("merge all applies every group and leaves the report clean", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "a@x.com", actions: { skip: true, label: "News" } }),
    mk({ from: "b@x.com", actions: { skip: true, label: "News" } }),
    mk({ from: "a@y.com", actions: { star: true, label: "Star" } }),
    mk({ from: "b@y.com", actions: { star: true, label: "Star" } }),
    mk({ from: "c@y.com", actions: { star: true, label: "Star" } }),
  ]);
  app._setConfirm(true);
  app.openHelpDialog();
  app.applyAllMerges();
  const after = app.getFilters();
  assert.equal(after.length, 2);
  // One domain filter per group, in list order.
  assert.equal(after[0].from, "@x.com");
  assert.equal(after[1].from, "@y.com");
  assert.ok(doc.getElementById("helpSummary").textContent.indexOf("No merges or duplicates found") !== -1);
});

test("merge all asks first and a no leaves the list untouched", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "a@x.com", actions: { skip: true } }),
    mk({ from: "b@x.com", actions: { skip: true } }),
  ]);
  app._setConfirm(false);
  app.applyAllMerges();
  assert.equal(app.getFilters().length, 2);
  assert.equal(app.getFilters()[0].from, "a@x.com");
});

test("the merge group header carries a Merge all button with the count", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "a@x.com", actions: { skip: true } }),
    mk({ from: "b@x.com", actions: { skip: true } }),
    mk({ from: "a@y.com", actions: { star: true } }),
    mk({ from: "b@y.com", actions: { star: true } }),
  ]);
  app._setConfirm(true);
  app.openHelpDialog();
  const results = doc.getElementById("helpResults");
  const head = results.children[0].children[0]; // merge group → its head
  assert.equal(head.className, "help-group-head");
  assert.equal(head.children[0].textContent, "Merge into one filter");
  const all = head.children[1];
  assert.equal(all.textContent, "Merge all (2)");
  // Click it — both groups merge at once.
  all._listeners.click[0]();
  assert.equal(app.getFilters().length, 2);
  assert.equal(app.getFilters()[0].from, "@x.com");
  assert.equal(app.getFilters()[1].from, "@y.com");
});

test("help meta line is styled apart from the actions line", () => {
  const html = fs.readFileSync(INDEX, "utf8");
  assert.match(html, /\.help-text \.help-meta\{margin-top:4px\}/);
  assert.match(html, /\.help-text \.help-meta b\{display:inline;font-size:12\.5px;color:var\(--ink\)\}/);
  assert.match(html, /\.help-text \.help-meta \.help-meta-note\{display:inline;margin-top:0\}/);
  assert.match(html, /\.help-group-head\{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px\}/);
});

test("suggestLabel derives a label from the sender's domain", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  assert.equal(app.suggestLabel(mk({ from: "store-news@amazon.com" })), "Amazon");
  assert.equal(app.suggestLabel(mk({ from: "advertise-noreply@support.facebook.com" })), "Facebook");
  assert.equal(app.suggestLabel(mk({ from: "no-reply@rs.email.nextdoor.com" })), "Nextdoor");
  // Compound words stay joined — the heuristic can't split them.
  assert.equal(app.suggestLabel(mk({ from: "a@notifications3.creditkarma.com" })), "Creditkarma");
  // Short labels are uppercased — usually acronyms.
  assert.equal(app.suggestLabel(mk({ from: "extracare@pharmacy.cvs.com" })), "CVS");
  // A two-part public suffix doesn't become the label.
  assert.equal(app.suggestLabel(mk({ from: "a@shop.amazon.co.uk" })), "Amazon");
  assert.equal(app.suggestLabel(mk({ from: "a@x.com" })), "X");
  // No sender, no suggestion.
  assert.equal(app.suggestLabel(mk({ subject: "hello" })), null);
  // A merged "{@a @b ...}" OR still suggests, when every host
  // shares one registrable domain.
  assert.equal(app.suggestLabel(mk({ from: "{@mail8.creditkarma.com @mail4.creditkarma.com @creditkarma.com}" })), "Creditkarma");
  assert.equal(app.suggestLabel(mk({ from: "{@email.apple.com @insideapple.apple.com}" })), "Apple");
  assert.equal(app.suggestLabel(mk({ from: "{@account.one.app @update.one.app @servicing.one.app}" })), "ONE");
  // Mixed registrable domains — no one brand to pick.
  assert.equal(app.suggestLabel(mk({ from: "{@a.com @b.com}" })), null);
  // An OR with an explicit OR keyword still reads the hosts.
  assert.equal(app.suggestLabel(mk({ from: "{@mail8.creditkarma.com OR @mail4.creditkarma.com}" })), "Creditkarma");
});

test("labels dialog lists every no-label filter, with Apply and View", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "a@amazon.com", actions: { skip: true } }),
    mk({ subject: "hello", actions: { skip: true } }),
    // Labeled — not no-label at all.
    mk({ from: "b@x.com", actions: { skip: true, label: "News" } }),
  ]);
  app.openLabelsDialog();
  const summary = doc.getElementById("labelsSummary").textContent;
  assert.ok(summary.indexOf("2 filters without a label (1 with a suggestion)") !== -1);
  const results = doc.getElementById("labelsResults");
  const group = results.children[0];
  // The header carries the Apply all button (1 suggestion).
  assert.equal(group.children[0].children[0].textContent, "Missing labels");
  assert.equal(group.children[0].children[1].textContent, "Apply all (1)");
  const grid = group.children[1];
  assert.equal(grid.children.length, 2);
  // Row 0: has a suggestion — Apply and View.
  const row0 = grid.children[0];
  assert.equal(row0.children[0].textContent, "No label");
  assert.ok(row0.children[1].children[2].children[0].textContent.indexOf("Suggested label: Amazon") !== -1);
  assert.equal(row0.children[2].children.length, 2);
  assert.equal(row0.children[2].children[0].textContent, "Apply");
  assert.equal(row0.children[2].children[1].textContent, "View");
  // Row 1: no sender — View only, and the meta says so.
  const row1 = grid.children[1];
  assert.ok(row1.children[1].children[0].textContent.indexOf("Subject: hello") !== -1);
  assert.ok(row1.children[1].children[2].textContent.indexOf("No sender to suggest a label from") !== -1);
  assert.equal(row1.children[2].children.length, 1);
  assert.equal(row1.children[2].children[0].textContent, "View");
  // Apply adds the label action to that filter.
  row0.children[2].children[0]._listeners.click[0]();
  const after = app.getFilters();
  assert.equal(after[0].actions.label, "Amazon");
  assert.equal(after[0].labels.join(","), "Amazon");
  // View opens the filter in the editor (the labels dialog closes first).
  row1.children[2].children[0]._listeners.click[0]();
  assert.equal(doc.getElementById("filterDialog").open, true);
});

test("applying a suggested label sets the label action and the export carries it", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "a@amazon.com", actions: { skip: true } }),
  ]);
  const f = app.getFilters()[0];
  app.applyLabel(f.id, app.suggestLabel(f));
  const after = app.getFilters()[0];
  assert.equal(after.actions.label, "Amazon");
  assert.equal(after.labels.join(","), "Amazon");
  // The name follows the label, the same as the add/edit flow.
  assert.equal(after.name, "Amazon");
  // A label is a real filter action — the XML carries it.
  const xml = app.buildXML();
  assert.ok(xml.indexOf('name="label" value="Amazon"') !== -1);
});

test("apply all labels applies every suggestion and asks first", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "a@amazon.com", actions: { skip: true } }),
    mk({ from: "a@facebook.com", actions: { skip: true } }),
    // No sender — no suggestion, skipped by Apply all.
    mk({ subject: "hello", actions: { skip: true } }),
  ]);
  app._setConfirm(false);
  app.applyAllLabels();
  assert.equal(app.getFilters()[0].actions.label, "");
  app._setConfirm(true);
  app.applyAllLabels();
  const after = app.getFilters();
  assert.equal(after[0].actions.label, "Amazon");
  assert.equal(after[1].actions.label, "Facebook");
  assert.equal(after[2].actions.label, "");
});

test("labels dialog suggests labels for merged OR filters and offers Apply all", () => {
  const app = runApp(makeStorage());
  const doc = app._document;
  const mk = (data) => app.normalizeFilter(data);
  app.setFilters([
    mk({ from: "{@mail8.creditkarma.com @mail4.creditkarma.com @creditkarma.com}", actions: { skip: true, neverspam: true } }),
    mk({ from: "{@email.apple.com @insideapple.apple.com}", actions: { skip: true, neverspam: true } }),
    // No From at all — no suggestion, View only.
    mk({ has: "list:(<10518406.xt.local>)", actions: { skip: true, neverspam: true } }),
  ]);
  app.openLabelsDialog();
  const summary = doc.getElementById("labelsSummary").textContent;
  assert.ok(summary.indexOf("3 filters without a label (2 with a suggestion)") !== -1);
  const results = doc.getElementById("labelsResults");
  const group = results.children[0];
  // Apply all (2) — the senderless filter is skipped.
  assert.equal(group.children[0].children[1].textContent, "Apply all (2)");
  const grid = group.children[1];
  assert.equal(grid.children.length, 3);
  // The merged rows carry their suggestions and an Apply button.
  const row0 = grid.children[0];
  assert.ok(row0.children[1].children[2].children[0].textContent.indexOf("Suggested label: Creditkarma") !== -1);
  assert.equal(row0.children[2].children[0].textContent, "Apply");
  const row1 = grid.children[1];
  assert.ok(row1.children[1].children[2].children[0].textContent.indexOf("Suggested label: Apple") !== -1);
  // The senderless row has View only.
  const row2 = grid.children[2];
  assert.equal(row2.children[2].children.length, 1);
  assert.equal(row2.children[2].children[0].textContent, "View");
  // Apply all labels the two merged filters and leaves the third.
  group.children[0].children[1]._listeners.click[0]();
  const after = app.getFilters();
  assert.equal(after[0].actions.label, "Creditkarma");
  assert.equal(after[1].actions.label, "Apple");
  assert.equal(after[2].actions.label, "");
});

test("noLabelFilters returns every filter without a label action", () => {
  const app = runApp(makeStorage());
  const mk = (data) => app.normalizeFilter(data);
  const list = [
    mk({ from: "a@x.com", actions: { skip: true } }),
    mk({ from: "b@x.com", actions: { skip: true, label: "News" } }),
    mk({ subject: "hello", actions: { star: true } }),
  ];
  assert.equal(app.noLabelFilters(list).length, 2);
});

