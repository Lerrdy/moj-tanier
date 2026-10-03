const DB_NAME = "moj-tanier-db";
const DB_VERSION = 1;
const STORES = { meals: "meals", checkins: "checkins", settings: "settings" };

const state = {
  meals: [],
  checkins: [],
  reminders: ["10:00", "15:00", "20:00"],
  calendarId: null,
  reminderSequence: 0,
  savingMeal: false,
  savingCheckin: false,
  pendingPhoto: null,
  pendingPhotoUrl: null,
  pendingPhotoTime: null,
  selected: null,
  objectUrls: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.meals)) {
        const store = db.createObjectStore(STORES.meals, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(STORES.checkins)) {
        const store = db.createObjectStore(STORES.checkins, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const dbPromise = openDatabase();

async function getAll(storeName) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function getOne(storeName, key) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putOne(storeName, value) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteOne(storeName, key) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearJournal() {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.meals, STORES.checkins], "readwrite");
    tx.objectStore(STORES.meals).clear();
    tx.objectStore(STORES.checkins).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function localDayKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isToday(value) {
  return localDayKey(value) === localDayKey(Date.now());
}

function formatTime(value) {
  return new Intl.DateTimeFormat("sk-SK", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDate(value, includeYear = false) {
  return new Intl.DateTimeFormat("sk-SK", {
    weekday: "long", day: "numeric", month: "long", ...(includeYear ? { year: "numeric" } : {}),
  }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function countLabel(count, singular, few, many) {
  if (count === 1) return `${count} ${singular}`;
  if (count >= 2 && count <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

function makeObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.objectUrls.push(url);
  return url;
}

function clearObjectUrls() {
  state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.objectUrls = [];
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("is-visible"), 2700);
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog?.open) dialog.close();
}

function showView(name) {
  let activeView = null;
  $$(".view").forEach((view) => {
    const active = view.dataset.view === name;
    view.hidden = !active;
    view.classList.toggle("is-active", active);
    if (active) activeView = view;
  });
  $$(".nav-item").forEach((item) => {
    const active = item.dataset.go === name;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
  activeView?.querySelector("h1")?.focus({ preventScroll: true });
}

function mealRow(meal) {
  const photoUrl = makeObjectUrl(meal.photo);
  const subtitle = [meal.amount, meal.note].filter(Boolean).join(" · ") || "Fotka jedla";
  return `
    <button class="entry-row" type="button" data-entry-kind="meals" data-entry-id="${escapeHtml(meal.id)}">
      <img src="${photoUrl}" alt="" />
      <span class="entry-row__copy"><strong>${escapeHtml(meal.name || "Jedlo")}</strong><small>${escapeHtml(subtitle)}</small></span>
      <time datetime="${escapeHtml(meal.createdAt)}">${formatTime(meal.createdAt)}</time>
    </button>`;
}

function checkinRow(checkin) {
  const kept = checkin.status === "kept";
  const title = kept ? "Vydržala som" : checkin.name || "Dala som si sladké";
  const subtitle = kept ? "Malý úspech zaznamenaný" : checkin.amount || "Bez uvedeného množstva";
  return `
    <button class="entry-row" type="button" data-entry-kind="checkins" data-entry-id="${escapeHtml(checkin.id)}">
      <span class="entry-row__icon ${kept ? "" : "is-treat"}" aria-hidden="true">${kept ? "✓" : "♡"}</span>
      <span class="entry-row__copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span>
      <time datetime="${escapeHtml(checkin.createdAt)}">${formatTime(checkin.createdAt)}</time>
    </button>`;
}

function renderToday() {
  const now = new Date();
  const hour = now.getHours();
  $("#today-title").textContent = hour < 11 ? "Dobré ráno." : hour < 18 ? "Ahoj, krásny deň." : "Pekný večer.";
  $("#today-date").textContent = formatDate(now);

  const entries = [
    ...state.meals.filter((item) => isToday(item.createdAt)).map((item) => ({ ...item, kind: "meals" })),
    ...state.checkins.filter((item) => isToday(item.createdAt)).map((item) => ({ ...item, kind: "checkins" })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  $("#today-count").textContent = countLabel(entries.length, "záznam", "záznamy", "záznamov");
  const todayCheckins = state.checkins.filter((item) => isToday(item.createdAt));
  $("#checkin-note").textContent = todayCheckins.length
    ? `Dnes už máš ${countLabel(todayCheckins.length, "check-in", "check-iny", "check-inov")}. Pokojne pridaj ďalší.`
    : "Bez výčitiek. Len si zaznač, ako sa dnes máš.";

  $("#today-items").innerHTML = entries.length
    ? entries.map((entry) => entry.kind === "meals" ? mealRow(entry) : checkinRow(entry)).join("")
    : `<div class="empty-mini"><span class="empty-mini__icon" aria-hidden="true">＋</span><p>Prvá fotka alebo odpoveď dňa sa objaví práve tu.</p></div>`;
}

function renderGallery() {
  const meals = [...state.meals].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  $("#gallery-count").textContent = meals.length;
  $("#gallery-empty").hidden = meals.length > 0;
  const grid = $("#gallery-grid");
  grid.hidden = meals.length === 0;
  grid.innerHTML = meals.map((meal) => {
    const photoUrl = makeObjectUrl(meal.photo);
    return `
      <button class="gallery-card" type="button" data-entry-kind="meals" data-entry-id="${escapeHtml(meal.id)}">
        <img src="${photoUrl}" alt="${escapeHtml(meal.name || "Fotka jedla")}" loading="lazy" />
        <span class="gallery-card__copy"><strong>${escapeHtml(meal.name || "Jedlo")}</strong><time datetime="${escapeHtml(meal.createdAt)}">${escapeHtml(formatDate(meal.createdAt))} · ${formatTime(meal.createdAt)}</time></span>
      </button>`;
  }).join("");
}

function renderOverview() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  const recentMeals = state.meals.filter((item) => new Date(item.createdAt) >= start);
  const recentCheckins = state.checkins.filter((item) => new Date(item.createdAt) >= start);
  const kept = recentCheckins.filter((item) => item.status === "kept");
  const treats = recentCheckins.filter((item) => item.status === "treat");
  const activeDays = new Set([...recentMeals, ...recentCheckins].map((item) => localDayKey(item.createdAt))).size;

  $("#week-score").textContent = `${activeDays}/7`;
  $("#meal-stat").textContent = recentMeals.length;
  $("#kept-stat").textContent = kept.length;
  $("#treat-stat").textContent = treats.length;

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = localDayKey(date);
    const dayMeals = recentMeals.filter((item) => localDayKey(item.createdAt) === key);
    const dayCheckins = recentCheckins.filter((item) => localDayKey(item.createdAt) === key);
    const hasTreat = dayCheckins.some((item) => item.status === "treat");
    const hasKept = dayCheckins.some((item) => item.status === "kept");
    const stateClass = hasTreat ? "has-treat" : hasKept ? "has-kept" : dayMeals.length ? "has-meal" : "";
    const symbol = hasTreat ? "♡" : hasKept ? "✓" : dayMeals.length ? "•" : "·";
    const label = new Intl.DateTimeFormat("sk-SK", { weekday: "short" }).format(date).replace(".", "");
    return `<span class="day-dot ${stateClass}" title="${escapeHtml(formatDate(date))}"><i>${symbol}</i>${escapeHtml(label)}</span>`;
  });
  $("#week-days").innerHTML = days.join("");

  const events = [
    ...state.meals.map((item) => ({ ...item, kind: "meals" })),
    ...state.checkins.map((item) => ({ ...item, kind: "checkins" })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  $("#timeline-count").textContent = countLabel(events.length, "udalosť", "udalosti", "udalostí");
  $("#timeline").innerHTML = events.length ? events.map((event) => {
    const isMeal = event.kind === "meals";
    const isTreat = event.status === "treat";
    const title = isMeal ? event.name || "Jedlo" : isTreat ? event.name || "Dala som si sladké" : "Vydržala som";
    const detail = [formatDate(event.createdAt), formatTime(event.createdAt), event.amount].filter(Boolean).join(" · ");
    const iconClass = isMeal ? "is-meal" : isTreat ? "is-treat" : "";
    const icon = isMeal ? "●" : isTreat ? "♡" : "✓";
    return `<button class="timeline-item" type="button" data-entry-kind="${event.kind}" data-entry-id="${escapeHtml(event.id)}"><span class="timeline-dot ${iconClass}">${icon}</span><span class="timeline-copy"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></span></button>`;
  }).join("") : `<div class="empty-mini"><span class="empty-mini__icon" aria-hidden="true">◔</span><p>Tvoj prehľad sa vytvorí z prvých záznamov.</p></div>`;
}

function renderSettings() {
  state.reminders.forEach((value, index) => {
    const input = document.getElementById(`reminder-${index + 1}`);
    if (input) input.value = value;
  });
  const installed = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  $("#install-status").textContent = installed ? "Nainštalovaná na ploche" : "Ešte nie je nainštalovaná";
  $("#install-status").classList.toggle("is-installed", installed);
  $("#install-copy").textContent = installed
    ? "Hotovo. Môj tanier sa otvára ako samostatná appka a pripravené údaje fungujú aj offline."
    : "V Safari ťukni na Zdieľať a potom na „Pridať na plochu“. Appka potom funguje aj offline.";
}

function renderAll() {
  clearObjectUrls();
  renderToday();
  renderGallery();
  renderOverview();
  renderSettings();
}

async function refreshData() {
  [state.meals, state.checkins] = await Promise.all([getAll(STORES.meals), getAll(STORES.checkins)]);
  renderAll();
}

async function compressPhoto(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("Vybraný súbor nie je fotografia.");
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = sourceUrl;
    await image.decode();
    const maxSide = 1600;
    const ratio = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", .84));
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function stagePhoto(file) {
  try {
    toast("Pripravujem fotku…");
    state.pendingPhoto = await compressPhoto(file);
    state.pendingPhotoTime = new Date().toISOString();
    if (state.pendingPhotoUrl) URL.revokeObjectURL(state.pendingPhotoUrl);
    state.pendingPhotoUrl = URL.createObjectURL(state.pendingPhoto);
    $("#meal-preview").src = state.pendingPhotoUrl;
    $("#meal-timestamp").textContent = formatDateTime(state.pendingPhotoTime);
    $("#meal-form").reset();
    openDialog("meal-dialog");
  } catch (error) {
    console.error(error);
    toast("Fotku sa nepodarilo načítať. Skús inú.");
  }
}

async function saveMeal(event) {
  event.preventDefault();
  if (!state.pendingPhoto || state.savingMeal) return;
  state.savingMeal = true;
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  submitButton.disabled = true;
  const meal = {
    id: uid(),
    createdAt: state.pendingPhotoTime || new Date().toISOString(),
    name: $("#meal-name").value.trim(),
    amount: $("#meal-amount").value.trim(),
    note: $("#meal-note").value.trim(),
    photo: state.pendingPhoto,
  };
  try {
    try {
      await putOne(STORES.meals, meal);
    } catch (error) {
      console.error(error);
      toast("Jedlo sa nepodarilo uložiť. Fotku ešte nechávam otvorenú.");
      return;
    }
    closeDialog("meal-dialog");
    state.pendingPhoto = null;
    if (state.pendingPhotoUrl) URL.revokeObjectURL(state.pendingPhotoUrl);
    state.pendingPhotoUrl = null;
    state.meals.push(meal);
    try {
      renderAll();
    } catch (error) {
      console.error(error);
      try { await refreshData(); } catch (refreshError) { console.error(refreshError); }
    }
    toast("Jedlo je uložené offline.");
  } finally {
    state.savingMeal = false;
    submitButton.disabled = false;
  }
}

async function saveCheckin(checkin) {
  if (state.savingCheckin) throw new Error("Ukladanie už prebieha.");
  state.savingCheckin = true;
  const controls = [$("#kept-button"), $("#treat-button"), $("#treat-form [type='submit']")].filter(Boolean);
  controls.forEach((control) => { control.disabled = true; });
  const record = { id: uid(), createdAt: new Date().toISOString(), ...checkin };
  try {
    await putOne(STORES.checkins, record);
    state.checkins.push(record);
    try {
      renderAll();
    } catch (error) {
      console.error(error);
      try { await refreshData(); } catch (refreshError) { console.error(refreshError); }
    }
    return record;
  } finally {
    state.savingCheckin = false;
    controls.forEach((control) => { control.disabled = false; });
  }
}

async function openEntry(kind, id) {
  const record = kind === STORES.meals
    ? state.meals.find((item) => item.id === id)
    : state.checkins.find((item) => item.id === id);
  if (!record) return;
  state.selected = { kind, id };
  const isMeal = kind === STORES.meals;
  const isTreat = record.status === "treat";
  $("#entry-kind").textContent = isMeal ? "Jedlo" : "Check-in";
  $("#entry-dialog-title").textContent = isMeal ? record.name || "Jedlo" : isTreat ? record.name || "Dala som si sladké" : "Vydržala som";
  const photo = isMeal ? `<img class="detail-photo" src="${makeObjectUrl(record.photo)}" alt="${escapeHtml(record.name || "Fotka jedla")}" />` : "";
  const lines = [
    `<p><strong>Kedy:</strong> ${escapeHtml(formatDateTime(record.createdAt))}</p>`,
    record.amount ? `<p><strong>Množstvo:</strong> ${escapeHtml(record.amount)}</p>` : "",
    record.note ? `<p><strong>Poznámka:</strong> ${escapeHtml(record.note)}</p>` : "",
    !isMeal && !isTreat ? `<p>Malý úspech je bezpečne zaznamenaný.</p>` : "",
  ].filter(Boolean).join("");
  $("#entry-detail").innerHTML = `${photo}<div class="detail-meta">${lines}</div>`;
  openDialog("entry-dialog");
}

async function loadSettings() {
  const [reminders, calendarId, reminderSequence] = await Promise.all([
    getOne(STORES.settings, "reminders"),
    getOne(STORES.settings, "calendarId"),
    getOne(STORES.settings, "reminderSequence"),
  ]);
  if (Array.isArray(reminders?.value) && reminders.value.length === 3) state.reminders = reminders.value;
  state.calendarId = typeof calendarId?.value === "string" ? calendarId.value : uid();
  state.reminderSequence = Number.isInteger(reminderSequence?.value) ? Math.max(0, reminderSequence.value) : 0;
  if (!calendarId?.value) await putOne(STORES.settings, { key: "calendarId", value: state.calendarId });
}

async function saveReminderSettings() {
  const nextReminders = [1, 2, 3].map((index) => document.getElementById(`reminder-${index}`).value || state.reminders[index - 1]);
  if (nextReminders.some((time, index) => time !== state.reminders[index])) state.reminderSequence += 1;
  state.reminders = nextReminders;
  await Promise.all([
    putOne(STORES.settings, { key: "reminders", value: state.reminders }),
    putOne(STORES.settings, { key: "reminderSequence", value: state.reminderSequence }),
  ]);
  toast("Časy sú uložené.");
}

function icsDate(date, time) {
  const [hours, minutes] = time.split(":").map(Number);
  const local = new Date(date);
  local.setHours(hours, minutes, 0, 0);
  return `${local.getFullYear()}${String(local.getMonth() + 1).padStart(2, "0")}${String(local.getDate()).padStart(2, "0")}T${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}00`;
}

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function nextOccurrence(time) {
  const [hours, minutes] = time.split(":").map(Number);
  const next = new Date();
  next.setHours(hours, minutes, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  return next;
}

function downloadCalendar() {
  const appUrl = `${location.origin}${location.pathname}?checkin=1`;
  const events = state.reminders.map((time, index) => [
    "BEGIN:VEVENT",
    `UID:moj-tanier-${state.calendarId}-${index + 1}@${location.hostname || "offline"}`,
    `DTSTAMP:${utcStamp()}`,
    `DTSTART:${icsDate(nextOccurrence(time), time)}`,
    `SEQUENCE:${state.reminderSequence}`,
    "RRULE:FREQ=DAILY",
    "SUMMARY:Ako to ide so sladkým?",
    "DESCRIPTION:Bez výčitiek. Otvor Môj tanier a sprav si krátky check-in.",
    `URL:${appUrl}`,
    "BEGIN:VALARM",
    "TRIGGER:PT0S",
    "ACTION:DISPLAY",
    "DESCRIPTION:Ako to ide so sladkým?",
    "END:VALARM",
    "END:VEVENT",
  ].join("\r\n")).join("\r\n");
  const content = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Moj tanier//Offline reminders//SK", "CALSCALE:GREGORIAN", events, "END:VCALENDAR"].join("\r\n");
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "moj-tanier-pripomienky.ics";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  openDialog("reminder-dialog");
  toast("Pripomienky sú pripravené.");
}

function updateConnectivity() {
  $("#offline-pill").hidden = navigator.onLine;
}

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const photoTrigger = event.target.closest("[data-photo-trigger]");
    if (photoTrigger) document.getElementById(photoTrigger.dataset.photoTrigger)?.click();

    const go = event.target.closest("[data-go]");
    if (go) showView(go.dataset.go);

    const close = event.target.closest("[data-close]");
    if (close) closeDialog(close.dataset.close);

    const entry = event.target.closest("[data-entry-kind][data-entry-id]");
    if (entry) await openEntry(entry.dataset.entryKind, entry.dataset.entryId);
  });

  ["meal-photo", "gallery-photo"].forEach((id) => {
    document.getElementById(id).addEventListener("change", async (event) => {
      const [file] = event.target.files || [];
      event.target.value = "";
      if (file) await stagePhoto(file);
    });
  });

  $("#meal-form").addEventListener("submit", saveMeal);
  $("#kept-button").addEventListener("click", async () => {
    try {
      await saveCheckin({ status: "kept" });
      toast("Zapísané. Toto je tvoje malé víťazstvo.");
    } catch (error) {
      console.error(error);
      toast("Odpoveď sa nepodarilo uložiť.");
    }
  });
  $("#treat-button").addEventListener("click", () => openDialog("treat-dialog"));
  $("#treat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await saveCheckin({ status: "treat", name: $("#treat-name").value.trim(), amount: $("#treat-amount").value.trim() });
      form.reset();
      closeDialog("treat-dialog");
      toast("Zapísané. Jeden moment neurčuje celý deň.");
    } catch (error) {
      console.error(error);
      toast("Odpoveď sa nepodarilo uložiť.");
    }
  });

  $("#delete-entry-button").addEventListener("click", async () => {
    if (!state.selected) return;
    await deleteOne(state.selected.kind, state.selected.id);
    state.selected = null;
    closeDialog("entry-dialog");
    await refreshData();
    toast("Záznam je vymazaný.");
  });

  [1, 2, 3].forEach((index) => document.getElementById(`reminder-${index}`).addEventListener("change", saveReminderSettings));
  $("#calendar-button").addEventListener("click", downloadCalendar);
  $("#shortcut-help-button").addEventListener("click", () => openDialog("reminder-dialog"));
  $("#clear-data-button").addEventListener("click", () => openDialog("clear-dialog"));
  $("#confirm-clear-button").addEventListener("click", async () => {
    await clearJournal();
    closeDialog("clear-dialog");
    await refreshData();
    toast("Denník je prázdny.");
  });

  window.addEventListener("online", updateConnectivity);
  window.addEventListener("offline", updateConnectivity);
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = (tool) => {
    try { void Promise.resolve(context.registerTool(tool)).catch(console.error); } catch (error) { console.error(error); }
  };
  register({
    name: "record_food_check_in",
    title: "Zapísať check-in",
    description: "Zapíše dnešnú odpoveď, či používateľka vydržala bez sladkého alebo si niečo dala, a obnoví viditeľný denník.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["kept", "treat"] },
        name: { type: "string", maxLength: 90 },
        amount: { type: "string", maxLength: 70 },
      },
      required: ["status"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!input || !["kept", "treat"].includes(input.status)) throw new Error("status musí byť kept alebo treat");
      if (input.status === "treat" && !String(input.name || "").trim()) throw new Error("Pri treat je potrebné uviesť, čo si používateľka dala");
      const record = { status: input.status, name: String(input.name || "").slice(0, 90), amount: String(input.amount || "").slice(0, 70) };
      await saveCheckin(record);
      return { saved: true, status: record.status, createdAt: new Date().toISOString() };
    },
  });
  register({
    name: "read_today_food_diary",
    title: "Prečítať dnešný denník",
    description: "Vráti stručné počty dnešných jedál a check-inov bez fotografií.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() {
      const meals = state.meals.filter((item) => isToday(item.createdAt)).length;
      const today = state.checkins.filter((item) => isToday(item.createdAt));
      return { date: localDayKey(Date.now()), meals, kept: today.filter((item) => item.status === "kept").length, treats: today.filter((item) => item.status === "treat").length };
    },
  });
}

async function init() {
  bindEvents();
  updateConnectivity();
  try {
    await loadSettings();
    await refreshData();
  } catch (error) {
    console.error(error);
    toast("Denník sa nepodarilo otvoriť. Skús stránku načítať znova.");
  }
  registerWebMcpTools();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.error("Service worker:", error));
  }
  if (new URLSearchParams(location.search).has("checkin")) {
    showView("today");
    setTimeout(() => $("#checkin-card").scrollIntoView({ block: "center", behavior: "smooth" }), 250);
  }
}

init();
