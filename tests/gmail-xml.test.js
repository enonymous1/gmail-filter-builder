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
