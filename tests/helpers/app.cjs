const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { IDBFactory } = require("fake-indexeddb");

process.env.TZ = "Europe/Prague";

const source = fs.readFileSync(path.join(__dirname, "../../dist/app.js"), "utf8")
  .replace(/\binit\(\);\s*$/, "globalThis.initialized = init();");
const start = Date.parse("2026-10-22T08:00:00+02:00");
const hour = 60 * 60 * 1000;

function createApp(factory = new IDBFactory(), clock = { now: start }, options = {}) {
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }

  class TestImage {
    constructor() {
      this.decoding = "auto";
      this.naturalWidth = options.imageWidth || 1200;
      this.naturalHeight = options.imageHeight || 900;
      this.src = "";
    }

    async decode() {
      options.onImageDecode?.(this);
      if (options.imageDecodeError) throw options.imageDecodeError;
    }
  }

  const nodes = new Map();
  const tools = new Map();
  const timers = new Map();
  const events = new Map();
  let timerId = 0;

  function initialValue(selector) {
    if (selector === "#checkin-interval") return "6";
    if (selector.includes("reminder-")) return "10:00";
    return "";
  }

  function initiallyDisabled(selector) {
    return selector === "#kept-button" || selector === "#treat-button" || selector === "#checkin-interval";
  }

  function resetForm(selector) {
    const fields = selector === "#meal-form"
      ? ["#meal-name", "#meal-amount", "#meal-note", "#meal-datetime"]
      : selector === "#treat-form"
        ? ["#treat-name", "#treat-amount"]
        : [];
    fields.forEach((field) => {
      const element = node(field);
      element.value = element.defaultValue;
      element.validationMessage = "";
    });
  }

  function node(selector) {
    if (!nodes.has(selector)) {
      const value = initialValue(selector);
      const attributes = new Map();
      const element = {
        value,
        defaultValue: value,
        disabled: initiallyDisabled(selector),
        hidden: selector === "#checkin-response" || selector === "#meal-time-editor",
        required: selector === "#meal-datetime",
        textContent: "",
        innerHTML: "",
        open: false,
        src: "",
        files: [],
        dataset: {},
        validationMessage: "",
        validityReported: false,
        handlers: new Map(),
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, callback) { this.handlers.set(name, callback); },
        querySelector(childSelector) {
          if (childSelector === '[type="submit"]' || childSelector === "[type='submit']") {
            return node(`${selector} [type='submit']`);
          }
          return node(childSelector);
        },
        setAttribute(name, nextValue) { attributes.set(name, String(nextValue)); },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
        removeAttribute(name) { attributes.delete(name); },
        setCustomValidity(message) { this.validationMessage = String(message); },
        checkValidity() { return !this.required || (Boolean(this.value) && !this.validationMessage); },
        reportValidity() { this.validityReported = true; return this.checkValidity(); },
        focus() {},
        click() {},
        remove() {},
        reset() { resetForm(selector); },
        showModal() { this.open = true; },
        close() { this.open = false; },
      };
      nodes.set(selector, element);
    }
    return nodes.get(selector);
  }

  function createElement(tagName) {
    if (tagName === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
        toBlob(callback, type) {
          callback(options.compressedPhoto || new Blob(["compressed-photo"], { type: type || "image/jpeg" }));
        },
      };
    }
    if (tagName === "a") return { href: "", download: "", click() {}, remove() {} };
    return node(`<${tagName}>`);
  }

  const document = {
    hidden: false,
    querySelector: node,
    querySelectorAll: (selector) => {
      const matches = [];
      if (selector.includes("[data-photo-trigger]")) matches.push(
          node('[data-photo-trigger="meal-photo"]'),
          node('[data-photo-trigger="gallery-photo"]'),
          node('[data-photo-trigger="library-photo"]'),
      );
      if (selector.includes("#meal-form") && /input|textarea|button|:is/.test(selector)) matches.push(
        node("#meal-name"),
        node("#meal-amount"),
        node("#meal-note"),
        node("#meal-datetime"),
        node("#meal-change-time"),
        node("#meal-form [type='submit']"),
        node('#meal-form [data-close="meal-dialog"]'),
      );
      return [...new Set(matches)];
    },
    getElementById: (id) => node(`#${id}`),
    createElement,
    body: { append() {} },
    addEventListener: (name, callback) => events.set(name, callback),
    modelContext: { registerTool: (tool) => tools.set(tool.name, tool) },
  };

  const context = vm.createContext({
    indexedDB: factory,
    Date: ClockDate,
    Intl,
    console: options.console || console,
    URL,
    URLSearchParams,
    Blob,
    File,
    Image: options.Image || TestImage,
    crypto: { randomUUID },
    document,
    exifr: options.exifr,
    window: {
      matchMedia: () => ({ matches: false }),
      navigator: {},
      scrollTo() {},
      addEventListener: (name, callback) => events.set(name, callback),
    },
    navigator: { onLine: true },
    location: { search: "", origin: "https://example.test", pathname: "/", hostname: "example.test" },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });

  vm.runInContext(source, context, { filename: "app.js" });
  const api = vm.runInContext(`({
    state,
    saveCheckin,
    checkinCycle,
    latestCheckin,
    chooseKeptMessage,
    checkinMessage,
    renderCheckin,
    loadSettings,
    refreshData,
    putOne,
    getAll,
    deleteOne,
    clearJournal,
    saveCheckinInterval,
    syncJournal,
    dbPromise,
    KEPT_MESSAGES,
    TREAT_MESSAGE,
    compressPhoto: typeof compressPhoto === "function" ? compressPhoto : undefined,
    parsePhotoTimestamp: typeof parsePhotoTimestamp === "function" ? parsePhotoTimestamp : undefined,
    parseLocalPhotoTime: typeof parseLocalPhotoTime === "function" ? parseLocalPhotoTime : undefined,
    readPhotoCapture: typeof readPhotoCapture === "function" ? readPhotoCapture : undefined,
    readPhotoTimestamp: typeof readPhotoTimestamp === "function" ? readPhotoTimestamp : undefined,
    mealDayKey: typeof mealDayKey === "function" ? mealDayKey : undefined,
    formatMealTime: typeof formatMealTime === "function" ? formatMealTime : undefined,
    formatMealDate: typeof formatMealDate === "function" ? formatMealDate : undefined,
    formatMealDateTime: typeof formatMealDateTime === "function" ? formatMealDateTime : undefined,
    renderGallery: typeof renderGallery === "function" ? renderGallery : undefined,
    stagePhoto: typeof stagePhoto === "function" ? stagePhoto : undefined,
    saveMeal: typeof saveMeal === "function" ? saveMeal : undefined
  })`, context);

  return { api, node, clock, factory, context, tools, events, timers, ready: context.initialized };
}

module.exports = { createApp, start, hour, IDBFactory };
