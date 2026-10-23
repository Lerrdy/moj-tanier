const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, start } = require("./helpers/app.cjs");

function photoFile(contents = "photo", options = {}) {
  return new File([contents], options.name || "photo.jpg", {
    type: options.type || "image/jpeg",
    lastModified: options.lastModified || Date.parse("2012-03-04T05:06:07Z"),
  });
}

function submitEvent(app) {
  return {
    preventDefault() {},
    currentTarget: app.node("#meal-form"),
  };
}

function requirePhotoApi(app, ...names) {
  for (const name of names) assert.equal(typeof app.api[name], "function", `${name} must be exposed by app.js`);
}

// Minimal JPEG containing a real EXIF APP1 segment. It intentionally has no image
// pixels: exifr only needs the JPEG segment structure to read these metadata tags.
function exifJpegFile(dateTimeOriginal, offsetTimeOriginal) {
  const dateBytes = Buffer.from(`${dateTimeOriginal}\0`, "ascii");
  const offsetBytes = offsetTimeOriginal ? Buffer.from(`${offsetTimeOriginal}\0`, "ascii") : null;
  const entryCount = offsetBytes ? 2 : 1;
  const ifd0Offset = 8;
  const exifIfdOffset = 26;
  const exifIfdLength = 2 + entryCount * 12 + 4;
  const dateOffset = exifIfdOffset + exifIfdLength;
  const offsetOffset = dateOffset + dateBytes.length;
  const tiff = Buffer.alloc(offsetOffset + (offsetBytes?.length || 0));

  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0Offset, 4);

  tiff.writeUInt16LE(1, ifd0Offset);
  tiff.writeUInt16LE(0x8769, ifd0Offset + 2); // ExifIFDPointer
  tiff.writeUInt16LE(4, ifd0Offset + 4); // LONG
  tiff.writeUInt32LE(1, ifd0Offset + 6);
  tiff.writeUInt32LE(exifIfdOffset, ifd0Offset + 10);
  tiff.writeUInt32LE(0, ifd0Offset + 14);

  tiff.writeUInt16LE(entryCount, exifIfdOffset);
  let entryOffset = exifIfdOffset + 2;
  tiff.writeUInt16LE(0x9003, entryOffset); // DateTimeOriginal
  tiff.writeUInt16LE(2, entryOffset + 2); // ASCII
  tiff.writeUInt32LE(dateBytes.length, entryOffset + 4);
  tiff.writeUInt32LE(dateOffset, entryOffset + 8);
  entryOffset += 12;

  if (offsetBytes) {
    tiff.writeUInt16LE(0x9011, entryOffset); // OffsetTimeOriginal
    tiff.writeUInt16LE(2, entryOffset + 2); // ASCII
    tiff.writeUInt32LE(offsetBytes.length, entryOffset + 4);
    tiff.writeUInt32LE(offsetOffset, entryOffset + 8);
    entryOffset += 12;
  }
  tiff.writeUInt32LE(0, entryOffset);
  dateBytes.copy(tiff, dateOffset);
  offsetBytes?.copy(tiff, offsetOffset);

  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xe1;
  marker.writeUInt16BE(payload.length + 2, 2);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), marker, payload, Buffer.from([0xff, 0xd9])]);
  return photoFile(jpeg, { name: "with-exif.jpg", lastModified: Date.parse("2010-01-01T00:00:00Z") });
}

test("parsePhotoTimestamp respects positive and negative EXIF offsets", async () => {
  const app = createApp();
  await app.ready;
  requirePhotoApi(app, "parsePhotoTimestamp");

  assert.equal(app.api.parsePhotoTimestamp({
    DateTimeOriginal: "2024:03:31 01:30:45",
    OffsetTimeOriginal: "+01:00",
  }), "2024-03-31T00:30:45.000Z");
  assert.equal(app.api.parsePhotoTimestamp({
    DateTimeOriginal: "2026:01:02 03:04:05",
    OffsetTimeOriginal: "-05:30",
  }), "2026-01-02T08:34:05.000Z");
});

test("parsePhotoTimestamp treats an EXIF timestamp without an offset as local wall time", async () => {
  const app = createApp();
  await app.ready;
  requirePhotoApi(app, "parsePhotoTimestamp");

  assert.equal(app.api.parsePhotoTimestamp({ DateTimeOriginal: "2026:01:02 03:04:05" }), "2026-01-02T02:04:05.000Z");
});

test("photo timestamp parsers reject missing, malformed, normalized, and impossible dates", async () => {
  const app = createApp();
  await app.ready;
  requirePhotoApi(app, "parsePhotoTimestamp", "parseLocalPhotoTime");

  const invalidExif = [
    null,
    {},
    { DateTimeOriginal: new Date() },
    { DateTimeOriginal: "2026:13:02 03:04:05" },
    { DateTimeOriginal: "2026:02:30 03:04:05" },
    { DateTimeOriginal: "2026:01:02 24:00:00" },
    { DateTimeOriginal: "2026:01:02 03:04:05", OffsetTimeOriginal: "Z" },
    { DateTimeOriginal: "2026:01:02 03:04:05", OffsetTimeOriginal: "+24:00" },
    { DateTimeOriginal: "2026:01:02 03:04:05", OffsetTimeOriginal: "+02:60" },
  ];
  for (const tags of invalidExif) assert.equal(app.api.parsePhotoTimestamp(tags), null);

  assert.equal(app.api.parseLocalPhotoTime("2026-01-02T03:04"), "2026-01-02T02:04:00.000Z");
  for (const value of ["", "2026-01-02 03:04", "2026-01-02T03:04:05", "2026-02-30T03:04", "2026-03-29T02:30"] ) {
    assert.equal(app.api.parseLocalPhotoTime(value), null, `${value || "empty value"} must be rejected`);
  }
});

test("readPhotoTimestamp asks exifr for raw capture tags and converts them", async () => {
  const calls = [];
  const file = photoFile();
  const exifr = {
    async parse(receivedFile, options) {
      calls.push({ receivedFile, options });
      return { DateTimeOriginal: "2025:11:12 13:14:15", OffsetTimeOriginal: "+02:30" };
    },
  };
  const app = createApp(undefined, undefined, { exifr });
  await app.ready;
  requirePhotoApi(app, "readPhotoTimestamp");

  assert.equal(await app.api.readPhotoTimestamp(file), "2025-11-12T10:44:15.000Z");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receivedFile, file);
  assert.equal(calls[0].options.reviveValues, false);
  assert.deepEqual([...calls[0].options.pick].sort(), ["DateTimeOriginal", "OffsetTimeOriginal"]);
});

test("readPhotoTimestamp returns null for absent metadata, parser errors, or absent exifr and never uses lastModified", async () => {
  const oldLastModified = Date.parse("2001-02-03T04:05:06Z");
  const file = photoFile("no metadata", { lastModified: oldLastModified });

  const noTags = createApp(undefined, undefined, { exifr: { parse: async () => ({}) } });
  await noTags.ready;
  requirePhotoApi(noTags, "readPhotoTimestamp");
  assert.equal(await noTags.api.readPhotoTimestamp(file), null);
  assert.notEqual(await noTags.api.readPhotoTimestamp(file), new Date(oldLastModified).toISOString());

  const broken = createApp(undefined, undefined, { exifr: { parse: async () => { throw new Error("broken EXIF"); } } });
  await broken.ready;
  assert.equal(await broken.api.readPhotoTimestamp(file), null);

  const unavailable = createApp();
  await unavailable.ready;
  assert.equal(await unavailable.api.readPhotoTimestamp(file), null);
});

let realExifr;
try {
  if (typeof globalThis.FileReader !== "function") {
    globalThis.FileReader = class FileReader {
      readAsArrayBuffer(blob) {
        blob.arrayBuffer().then(
          (result) => {
            this.result = result;
            this.onloadend?.({ target: this });
          },
          (error) => {
            this.error = error;
            this.onerror?.(error);
          },
        );
      }
    };
  }
  realExifr = require("exifr");
} catch {}

test("readPhotoCapture parses a real synthetic JPEG EXIF APP1 payload through exifr", {
  skip: realExifr ? false : "exifr is not installed yet",
}, async () => {
  const app = createApp(undefined, undefined, { exifr: realExifr });
  await app.ready;
  requirePhotoApi(app, "readPhotoCapture", "readPhotoTimestamp");
  const file = exifJpegFile("2026:07:08 09:10:11", "+02:30");

  const capture = await app.api.readPhotoCapture(file);
  assert.equal(capture.timestamp, "2026-07-08T06:40:11.000Z");
  assert.equal(capture.localTime, "2026-07-08T09:10:11");
  assert.equal(capture.offset, "+02:30");
  assert.equal(await app.api.readPhotoTimestamp(file), capture.timestamp);
});

test("stagePhoto reads EXIF from the original before compression and prepares an editable local value", async () => {
  const order = [];
  const exifr = {
    async parse() {
      order.push("metadata");
      return { DateTimeOriginal: "2026:01:15 18:45:47" };
    },
  };
  const app = createApp(undefined, undefined, { exifr, onImageDecode: () => order.push("compression") });
  await app.ready;
  requirePhotoApi(app, "stagePhoto", "parseLocalPhotoTime");

  await app.api.stagePhoto(photoFile(), "gallery");

  assert.deepEqual(order, ["metadata", "compression"]);
  assert.equal(app.api.state.pendingPhotoTime, "2026-01-15T17:45:47.000Z");
  assert.equal(app.api.state.pendingPhotoTimeSource, "exif");
  assert.equal(app.node("#meal-datetime").value, "2026-01-15T18:45");
  assert.equal(app.node("#meal-time-editor").hidden, true);
  assert.equal(app.node("#meal-change-time").getAttribute("aria-expanded"), "false");
  assert.notEqual(app.node("#meal-time-source").textContent, "");
  assert.equal(app.node("#meal-dialog").open, true);
});

test("the library picker opens an empty required time editor when EXIF is absent and ignores lastModified", async () => {
  const file = photoFile("gallery", { lastModified: Date.parse("1999-12-31T23:59:59Z") });
  const app = createApp(undefined, undefined, { exifr: { parse: async () => ({}) } });
  await app.ready;
  requirePhotoApi(app, "stagePhoto");

  const input = app.node("#library-photo");
  input.files = [file];
  await input.handlers.get("change")({ target: input });

  assert.equal(app.api.state.pendingPhotoTime, null);
  assert.equal(app.api.state.pendingPhotoTimeSource, null);
  assert.equal(app.node("#meal-datetime").value, "");
  assert.equal(app.node("#meal-datetime").required, true);
  assert.equal(app.node("#meal-time-editor").hidden, false);
  assert.equal(app.node("#meal-change-time").getAttribute("aria-expanded"), "true");
  assert.equal(app.node("#meal-dialog").open, true);
  assert.equal(app.api.state.preparingPhoto, false);
});

test("a camera photo without EXIF falls back to the current time, never lastModified", async () => {
  const file = photoFile("camera", { lastModified: Date.parse("1999-12-31T23:59:59Z") });
  const app = createApp(undefined, { now: start }, { exifr: { parse: async () => null } });
  await app.ready;
  requirePhotoApi(app, "stagePhoto");

  await app.api.stagePhoto(file, "camera");

  assert.equal(app.api.state.pendingPhotoTime, new Date(start).toISOString());
  assert.equal(app.api.state.pendingPhotoTimeSource, "camera");
  assert.equal(app.node("#meal-datetime").value, "2026-10-22T08:00");
  assert.notEqual(app.api.state.pendingPhotoTime, new Date(file.lastModified).toISOString());
  assert.equal(app.node("#meal-time-editor").hidden, true);
});

test("stagePhoto ignores a second request while metadata preparation is in flight", async () => {
  let finishMetadata;
  let parseCalls = 0;
  let compressionCalls = 0;
  const metadata = new Promise((resolve) => { finishMetadata = resolve; });
  const exifr = { parse: async () => { parseCalls += 1; return metadata; } };
  const app = createApp(undefined, undefined, { exifr, onImageDecode: () => { compressionCalls += 1; } });
  await app.ready;
  requirePhotoApi(app, "stagePhoto");
  const file = photoFile();

  const first = app.api.stagePhoto(file, "camera");
  const second = app.api.stagePhoto(file, "gallery");
  await Promise.resolve();
  assert.equal(app.api.state.preparingPhoto, true);
  assert.equal(parseCalls, 1);
  for (const trigger of app.context.document.querySelectorAll("[data-photo-trigger]")) assert.equal(trigger.disabled, true);

  finishMetadata({});
  await Promise.all([first, second]);
  assert.equal(compressionCalls, 1);
  assert.equal(app.api.state.preparingPhoto, false);
  for (const trigger of app.context.document.querySelectorAll("[data-photo-trigger]")) assert.equal(trigger.disabled, false);
});

test("stagePhoto always releases its preparation lock after a compression failure", async () => {
  const app = createApp(undefined, undefined, {
    exifr: { parse: async () => ({}) },
    imageDecodeError: new Error("decode failed"),
    console: { ...console, error() {} },
  });
  await app.ready;
  requirePhotoApi(app, "stagePhoto");

  await app.api.stagePhoto(photoFile(), "camera");

  assert.equal(app.api.state.preparingPhoto, false);
  assert.equal(app.node("#meal-dialog").open, false);
  assert.notEqual(app.node("#toast").textContent, "");
});

test("saveMeal refuses an empty or impossible manual time and leaves the form open", async () => {
  const app = createApp(undefined, undefined, { exifr: { parse: async () => ({}) } });
  await app.ready;
  requirePhotoApi(app, "stagePhoto", "saveMeal");
  await app.api.stagePhoto(photoFile(), "gallery");

  for (const value of ["", "2026-02-30T18:45"]) {
    app.node("#meal-datetime").value = value;
    await app.api.saveMeal(submitEvent(app));
    assert.equal((await app.api.getAll("meals")).length, 0);
    assert.equal(app.node("#meal-dialog").open, true);
    assert.equal(app.node("#meal-time-editor").hidden, false);
  }
});

test("saveMeal stores a valid manual local time instead of file.lastModified", async () => {
  const file = photoFile("gallery", { lastModified: Date.parse("2002-02-02T02:02:02Z") });
  const app = createApp(undefined, undefined, { exifr: { parse: async () => ({}) } });
  await app.ready;
  requirePhotoApi(app, "stagePhoto", "saveMeal");
  await app.api.stagePhoto(file, "gallery");
  app.node("#meal-name").value = "Večeře";
  app.node("#meal-datetime").value = "2026-01-15T18:45";

  await app.api.saveMeal(submitEvent(app));

  const meals = await app.api.getAll("meals");
  assert.equal(meals.length, 1);
  assert.equal(meals[0].createdAt, "2026-01-15T17:45:00.000Z");
  assert.notEqual(meals[0].createdAt, new Date(file.lastModified).toISOString());
  assert.equal(app.node("#meal-dialog").open, false);
});

test("saveMeal preserves EXIF seconds while an unchanged editor minute represents the same instant", async () => {
  const exifr = { parse: async () => ({ DateTimeOriginal: "2026:01:15 18:45:47" }) };
  const app = createApp(undefined, undefined, { exifr });
  await app.ready;
  requirePhotoApi(app, "stagePhoto", "saveMeal");
  await app.api.stagePhoto(photoFile(), "gallery");
  assert.equal(app.node("#meal-datetime").value, "2026-01-15T18:45");

  await app.api.saveMeal(submitEvent(app));

  const [meal] = await app.api.getAll("meals");
  assert.equal(meal.createdAt, "2026-01-15T17:45:47.000Z");
});

test("travel EXIF preserves its original wall time, calendar day, and offset from import through gallery rendering", async () => {
  const tags = { DateTimeOriginal: "2026:07:08 23:30:00", OffsetTimeOriginal: "-04:00" };
  const app = createApp(undefined, undefined, { exifr: { parse: async () => tags } });
  await app.ready;
  requirePhotoApi(
    app,
    "readPhotoCapture",
    "readPhotoTimestamp",
    "stagePhoto",
    "saveMeal",
    "mealDayKey",
    "formatMealTime",
    "formatMealDate",
    "formatMealDateTime",
    "renderGallery",
  );
  const file = photoFile();

  const capture = await app.api.readPhotoCapture(file);
  assert.equal(capture.timestamp, "2026-07-09T03:30:00.000Z");
  assert.equal(capture.localTime, "2026-07-08T23:30:00");
  assert.equal(capture.offset, "-04:00");
  assert.equal(await app.api.readPhotoTimestamp(file), capture.timestamp);

  await app.api.stagePhoto(file, "gallery");
  assert.equal(app.api.state.pendingPhotoTime, capture.timestamp);
  assert.equal(app.api.state.pendingPhotoLocalTime, capture.localTime);
  assert.equal(app.api.state.pendingPhotoOffset, capture.offset);
  assert.equal(app.node("#meal-datetime").value, "2026-07-08T23:30");

  app.node("#meal-name").value = "Večeře na cestách";
  await app.api.saveMeal(submitEvent(app));
  const [meal] = await app.api.getAll("meals");
  assert.equal(meal.createdAt, capture.timestamp);
  assert.equal(meal.photoLocalTime, capture.localTime);
  assert.equal(meal.photoOffset, capture.offset);
  assert.equal(app.api.mealDayKey(meal), "2026-07-08");
  assert.equal(app.api.formatMealTime(meal), "23:30");
  assert.match(app.api.formatMealDate(meal), /8\. července/);
  assert.match(app.api.formatMealDateTime(meal), /8\. července/);
  assert.match(app.api.formatMealDateTime(meal), /23:30/);

  app.api.renderGallery();
  assert.match(app.node("#gallery-grid").innerHTML, /8\. července/);
  assert.doesNotMatch(app.node("#gallery-grid").innerHTML, /9\. července/);
});

test("editing a travel photo time clears EXIF wall-time provenance and uses the device timezone", async () => {
  const tags = { DateTimeOriginal: "2026:07:08 23:30:00", OffsetTimeOriginal: "-04:00" };
  const app = createApp(undefined, undefined, { exifr: { parse: async () => tags } });
  await app.ready;
  requirePhotoApi(app, "stagePhoto", "saveMeal", "formatMealTime");
  await app.api.stagePhoto(photoFile(), "gallery");

  const input = app.node("#meal-datetime");
  input.value = "2026-07-08T22:15";
  await input.handlers.get("change")({ target: input, currentTarget: input });
  assert.equal(app.api.state.pendingPhotoTime, "2026-07-08T20:15:00.000Z");
  assert.equal(app.api.state.pendingPhotoLocalTime, null);
  assert.equal(app.api.state.pendingPhotoOffset, null);
  assert.equal(app.api.state.pendingPhotoTimeSource, "manual");

  await app.api.saveMeal(submitEvent(app));
  const [meal] = await app.api.getAll("meals");
  assert.equal(meal.createdAt, "2026-07-08T20:15:00.000Z");
  assert.equal(meal.photoLocalTime, null);
  assert.equal(meal.photoOffset, null);
  assert.equal(app.api.formatMealTime(meal), "22:15");
});

test("an IndexedDB abort without tx.error keeps the meal draft open and releases every save lock", { timeout: 2000 }, async () => {
  const app = createApp(undefined, undefined, {
    exifr: { parse: async () => null },
    console: { ...console, error() {} },
  });
  await app.ready;
  requirePhotoApi(app, "stagePhoto", "saveMeal");
  await app.api.stagePhoto(photoFile(), "camera");
  app.node("#meal-name").value = "Rozepsaná večeře";

  const db = await app.api.dbPromise;
  const originalTransaction = db.transaction.bind(db);
  let transactionStarted;
  const transactionWasStarted = new Promise((resolve) => { transactionStarted = resolve; });
  const abortedTransaction = {
    error: null,
    oncomplete: null,
    onerror: null,
    onabort: null,
    objectStore() { return { put() {} }; },
  };
  db.transaction = (storeName, mode) => {
    if (storeName === "meals" && mode === "readwrite") {
      db.transaction = originalTransaction;
      transactionStarted();
      return abortedTransaction;
    }
    return originalTransaction(storeName, mode);
  };

  const saving = app.api.saveMeal(submitEvent(app));
  await transactionWasStarted;
  assert.equal(app.api.state.savingMeal, true);
  const mealControls = app.context.document.querySelectorAll("#meal-form input, #meal-form textarea, #meal-form button");
  const photoTriggers = app.context.document.querySelectorAll("[data-photo-trigger]");
  for (const control of mealControls) assert.equal(control.disabled, true);
  for (const trigger of photoTriggers) assert.equal(trigger.disabled, true);

  const cancel = app.node("#meal-dialog").handlers.get("cancel");
  assert.equal(typeof cancel, "function");
  let cancelPrevented = false;
  cancel({ preventDefault() { cancelPrevented = true; } });
  assert.equal(cancelPrevented, true);

  assert.equal(abortedTransaction.error, null);
  assert.equal(typeof abortedTransaction.onabort, "function");
  abortedTransaction.onabort();
  await saving;

  assert.equal(app.api.state.savingMeal, false);
  assert.equal(app.node("#meal-form [type='submit']").disabled, false);
  for (const control of mealControls) assert.equal(control.disabled, false);
  for (const trigger of photoTriggers) assert.equal(trigger.disabled, false);
  assert.equal(app.node("#meal-dialog").open, true);
  assert.notEqual(app.api.state.pendingPhoto, null);
  assert.equal(app.node("#meal-name").value, "Rozepsaná večeře");
  assert.equal((await app.api.getAll("meals")).length, 0);
});
