const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { IDBFactory } = require("fake-indexeddb");

process.env.TZ = "Europe/Prague";
const source = fs.readFileSync(path.join(__dirname, "../dist/app.js"), "utf8")
  .replace(/\binit\(\);\s*$/, "globalThis.initialized = init();");
const start = Date.parse("2026-10-22T08:00:00+02:00");
const hour = 60 * 60 * 1000;

// Run the actual app with controllable time and isolated IndexedDB, never a user's diary.
function createApp(factory = new IDBFactory(), clock = { now: start }) {
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const nodes = new Map();
  const tools = new Map();
  const timers = new Map();
  const events = new Map();
  let timerId = 0;
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: selector.includes("reminder-") ? "10:00" : "6",
      disabled: true, hidden: false, textContent: "", innerHTML: "", open: false,
      handlers: new Map(),
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, callback) { this.handlers.set(name, callback); },
      querySelector() { return node("#treat-form [type='submit']"); },
      focus() {}, reset() {}, showModal() { this.open = true; }, close() { this.open = false; },
    });
    return nodes.get(selector);
  }
  const document = {
    hidden: false,
    querySelector: node, querySelectorAll: () => [], getElementById: (id) => node(`#${id}`),
    addEventListener: (name, callback) => events.set(name, callback),
    modelContext: { registerTool: (tool) => tools.set(tool.name, tool) },
  };
  const context = vm.createContext({
    indexedDB: factory, Date: ClockDate, Intl, console, URL, URLSearchParams,
    crypto: { randomUUID }, document,
    window: { matchMedia: () => ({ matches: false }), navigator: {}, scrollTo() {}, addEventListener: (name, callback) => events.set(name, callback) },
    navigator: { onLine: true }, location: { search: "" },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source, context, { filename: "app.js" });
  const api = vm.runInContext("({ state, saveCheckin, checkinCycle, latestCheckin, chooseKeptMessage, checkinMessage, renderCheckin, loadSettings, refreshData, putOne, getAll, deleteOne, clearJournal, saveCheckinInterval, syncJournal, dbPromise, KEPT_MESSAGES, TREAT_MESSAGE })", context);
  return { api, node, clock, factory, context, tools, events, timers, ready: context.initialized };
}

test("initial load disables answers; a saved answer locks both buttons for six hours", async () => {
  const app = createApp();
  assert.equal(app.api.state.checkinsReady, false);
  await app.ready;
  assert.equal(app.node("#kept-button").disabled, false);
  const saved = await app.api.saveCheckin({ status: "kept" });
  assert.equal(saved.saved, true);
  assert.equal(saved.nextAt, start + 6 * hour);
  assert.equal(app.node("#checkin-prompt").hidden, true);
  assert.equal(app.node("#checkin-response").hidden, false);
  assert.equal(app.node("#kept-button").disabled, true);
  assert.match(app.node("#checkin-next").textContent, /dnes v 14:00/);
  const repeated = await app.api.saveCheckin({ status: "treat", name: "Čokoláda" });
  assert.equal(repeated.saved, false);
  assert.equal((await app.api.getAll("checkins")).length, 1);
});

test("the same feedback and cooldown survive a new app instance", async () => {
  const first = createApp();
  await first.ready;
  const result = await first.api.saveCheckin({ status: "kept" });
  const reopened = createApp(first.factory, first.clock);
  await reopened.ready;
  assert.equal(reopened.node("#checkin-message").textContent, result.record.feedbackMessage);
  assert.equal(reopened.node("#kept-button").disabled, true);
  assert.equal((await reopened.api.getAll("checkins")).length, 1);
});

test("both answers use the same interval, and treat feedback is always the same", async () => {
  const app = createApp();
  await app.ready;
  const first = await app.api.saveCheckin({ status: "treat", name: "Čokoláda", amount: "2 kousky" });
  assert.equal(first.nextAt, start + 6 * hour);
  app.clock.now += 6 * hour;
  const second = await app.api.saveCheckin({ status: "treat", name: "Koláč" });
  assert.equal(second.saved, true);
  assert.equal(second.record.feedbackMessage, first.record.feedbackMessage);
  assert.match(app.node("#checkin-answer").textContent, /Koláč/);
});

test("no immediate repeated kept feedback, even with a treat between answers", async () => {
  const app = createApp();
  await app.ready;
  const first = await app.api.saveCheckin({ status: "kept" });
  app.clock.now += 6 * hour;
  await app.api.saveCheckin({ status: "treat", name: "Koláč" });
  app.clock.now += 6 * hour;
  const second = await app.api.saveCheckin({ status: "kept" });
  assert.notEqual(second.record.feedbackMessage, first.record.feedbackMessage);
});

test("elapsed time crosses midnight and DST; exactly six hours unlocks", async () => {
  const app = createApp();
  await app.ready;
  const createdAt = "2026-10-24T23:30:00+02:00";
  const records = [{ id: "legacy", status: "kept", createdAt }];
  assert.equal(app.api.checkinCycle(records, 6, Date.parse("2026-10-25T00:01:00+02:00")).waiting, true);
  const boundary = Date.parse(createdAt) + 6 * hour;
  assert.equal(app.api.checkinCycle(records, 6, boundary - 1).waiting, true);
  assert.equal(app.api.checkinCycle(records, 6, boundary).waiting, false);
  assert.equal(new Date(boundary).getHours(), 4);
});

test("an expired timer and a resumed app unlock the question without reloading", async () => {
  const app = createApp();
  await app.ready;
  await app.api.saveCheckin({ status: "kept" });
  const timer = app.timers.get(app.api.renderCheckin.timer);
  app.clock.now += 6 * hour;
  timer.callback();
  assert.equal(app.node("#checkin-prompt").hidden, false);
  assert.equal(app.node("#kept-button").disabled, false);
  await app.api.saveCheckin({ status: "kept" });
  app.clock.now += 7 * hour;
  await app.events.get("pageshow")();
  assert.equal(app.node("#checkin-prompt").hidden, false);
});

test("changing the persisted interval recalculates the current pause and survives reload", async () => {
  const app = createApp();
  await app.ready;
  await app.api.saveCheckin({ status: "kept" });
  app.clock.now += 2 * hour;
  app.node("#checkin-interval").value = "1";
  await app.api.saveCheckinInterval();
  assert.equal(app.node("#kept-button").disabled, false);
  app.node("#checkin-interval").value = "12";
  await app.api.saveCheckinInterval();
  assert.equal(app.node("#kept-button").disabled, true);
  assert.match(app.node("#checkin-next").textContent, /20:00/);
  const reopened = createApp(app.factory, app.clock);
  await reopened.ready;
  assert.equal(reopened.api.state.checkinIntervalHours, 12);
  assert.equal(reopened.node("#checkin-interval").value, "12");
});

test("legacy records use the latest timestamp and stable feedback; invalid settings fall back to six", async () => {
  const app = createApp();
  await app.ready;
  for (const [id, createdAt] of [["z", start - 10 * hour], ["a", start - hour]]) {
    await app.api.putOne("checkins", { id, status: "kept", createdAt: new Date(createdAt).toISOString() });
  }
  await app.api.putOne("settings", { key: "checkinIntervalHours", value: -10 });
  await app.api.loadSettings();
  await app.api.refreshData();
  assert.equal(app.api.latestCheckin(app.api.state.checkins).id, "a");
  assert.equal(app.api.state.checkinIntervalHours, 6);
  assert.equal(app.node("#checkin-message").textContent, app.api.KEPT_MESSAGES[0]);
});

test("concurrent tabs cannot save two answers to the same interval", async () => {
  const factory = new IDBFactory();
  const clock = { now: start };
  const first = createApp(factory, clock);
  const second = createApp(factory, clock);
  await Promise.all([first.ready, second.ready]);
  const results = await Promise.all([
    first.api.saveCheckin({ status: "kept" }),
    second.api.saveCheckin({ status: "treat", name: "Koláč" }),
  ]);
  assert.equal(results.filter((result) => result.saved).length, 1);
  assert.equal((await first.api.getAll("checkins")).length, 1);
  assert.equal(first.node("#kept-button").disabled, true);
  assert.equal(second.node("#kept-button").disabled, true);
});

test("WebMCP obeys cooldown and returns the actual saved answer and deadline", async () => {
  const app = createApp();
  await app.ready;
  const tool = app.tools.get("record_food_check_in");
  const result = await tool.execute({ status: "kept" });
  const rejected = await tool.execute({ status: "treat", name: "Koláč" });
  assert.equal(result.saved, true);
  assert.equal(rejected.saved, false);
  assert.equal(rejected.createdAt, result.createdAt);
  assert.equal(rejected.nextQuestionAt, result.nextQuestionAt);
  assert.equal(app.tools.get("read_today_food_diary").execute().checkin.ready, false);
});

test("removing the latest answer or clearing the journal recomputes the pause", async () => {
  const app = createApp();
  await app.ready;
  const first = await app.api.saveCheckin({ status: "kept" });
  await app.api.deleteOne("checkins", first.record.id);
  await app.api.refreshData();
  assert.equal(app.node("#kept-button").disabled, false);
  await app.api.saveCheckin({ status: "treat", name: "Koláč" });
  await app.api.clearJournal();
  await app.api.refreshData();
  assert.equal(app.node("#kept-button").disabled, false);
});

test("a failed write does not start a new pause or report success", async () => {
  const app = createApp();
  await app.ready;
  const first = await app.api.saveCheckin({ status: "kept" });
  app.clock.now += 6 * hour;
  app.context.crypto.randomUUID = () => first.record.id;
  await assert.rejects(app.api.saveCheckin({ status: "kept" }));
  assert.equal(app.api.state.savingCheckin, false);
  assert.equal(app.node("#kept-button").disabled, false);
  assert.equal((await app.api.getAll("checkins")).length, 1);
});
