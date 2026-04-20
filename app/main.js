import {
  citiesToInput,
  createJournalEntry,
  createTrip,
  daysBetween,
  entriesForTrip,
  fromDateTimeInputValue,
  isTripActive,
  isTripPast,
  normalizeEntry,
  normalizeTrip,
  parseCitiesInput,
  toDateTimeInputValue,
  tripEntryCounts,
  visibleEntries,
  visibleTrips
} from "./model.js";
import { loadAppState, saveAppState } from "./storage.js";

const SORT_MODES = ["recent", "oldest", "duration"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const loadedState = loadAppState();
const state = {
  ...loadedState,
  filter: "all",
  sort: "recent",
  search: "",
  currentTripId: null,
  currentEntryId: null,
  composeEntryId: null,
  editingTripId: null
};

const $ = id => document.getElementById(id);
let toastTimer;

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function save() {
  saveAppState(state);
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2000);
}

function getTrip(id) {
  return visibleTrips(state.trips).find(trip => trip.id === String(id)) || null;
}

function getEntry(id) {
  return visibleEntries(state.entries).find(entry => entry.id === String(id)) || null;
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function formatDate(iso) {
  if (!iso) return "undated";
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "undated";
  const now = new Date();
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label}, ${date.getFullYear()}`;
}

function formatDateRange(startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00`);
  const end = new Date(`${endIso}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "undated";

  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${MONTHS[start.getMonth()].toUpperCase()} ${start.getDate()} - ${end.getDate()}`;
  }

  return `${MONTHS[start.getMonth()].toUpperCase()} ${start.getDate()} - ${MONTHS[end.getMonth()].toUpperCase()} ${end.getDate()}`;
}

function formatDayLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "UNDATED";
  return `${DAYS[date.getDay()].toUpperCase()} | ${MONTHS[date.getMonth()].toUpperCase()} ${date.getDate()}`;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  let hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, "0");
  const suffix = hour >= 12 ? "pm" : "am";
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute}${suffix}`;
}

function dayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "undated";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function routeLabel(trip) {
  return trip.cities.length ? trip.cities.join(" - ") : "no cities yet";
}

function statusLabel(trip) {
  if (isTripActive(trip)) return "NOW";
  if (isTripPast(trip)) return "PAST";
  return "PLANNED";
}

function filteredTrips() {
  const query = state.search.trim().toLowerCase();
  const list = visibleTrips(state.trips).filter(trip => {
    if (state.filter === "active" && !isTripActive(trip)) return false;
    if (state.filter === "past" && !isTripPast(trip)) return false;
    if (!query) return true;
    const haystack = `${trip.title} ${trip.cities.join(" ")}`.toLowerCase();
    return haystack.includes(query);
  });

  if (state.sort === "recent") {
    list.sort((left, right) => new Date(`${right.startIso}T00:00:00`) - new Date(`${left.startIso}T00:00:00`));
  } else if (state.sort === "oldest") {
    list.sort((left, right) => new Date(`${left.startIso}T00:00:00`) - new Date(`${right.startIso}T00:00:00`));
  } else if (state.sort === "duration") {
    list.sort((left, right) => daysBetween(right.startIso, right.endIso) - daysBetween(left.startIso, left.endIso));
  }

  return list;
}

function renderStats() {
  const trips = visibleTrips(state.trips);
  const entries = visibleEntries(state.entries).filter(entry => trips.some(trip => trip.id === entry.tripId));
  const cities = new Set();
  for (const trip of trips) {
    for (const city of trip.cities) cities.add(city);
  }

  $("stats").textContent = `${plural(trips.length, "trip")} | ${plural(entries.length, "entry", "entries")} | ${plural(cities.size, "city", "cities")}`;
}

function renderNav() {
  $("nav").querySelectorAll(".nav-item").forEach(item => {
    item.classList.toggle("active", item.dataset.filter === state.filter);
  });
}

function renderSort() {
  $("sort-control").textContent = state.sort;
}

function renderList() {
  const list = filteredTrips();
  const container = $("trip-list");
  const empty = $("empty-state");

  if (!list.length) {
    container.innerHTML = "";
    empty.hidden = false;
    empty.textContent = state.search ? "no matches." : "no trips yet - write one above.";
    return;
  }

  empty.hidden = true;
  container.innerHTML = list.map(trip => {
    const counts = tripEntryCounts(state.entries, trip.id);
    const active = isTripActive(trip);
    const past = isTripPast(trip);
    const days = daysBetween(trip.startIso, trip.endIso);

    return `
      <article class="trip-item ${past ? "past" : ""}" data-trip-id="${esc(trip.id)}">
        <div class="trip-meta">
          <span>${esc(formatDateRange(trip.startIso, trip.endIso))} | ${plural(days, "day").toUpperCase()}</span>
          <span class="right">${esc(active ? "NOW" : statusLabel(trip))}</span>
        </div>
        <h2 class="trip-title">${esc(trip.title)}</h2>
        <div class="trip-route">${esc(routeLabel(trip))}</div>
        <div class="trip-counts">${esc(plural(counts.total, "entry", "entries"))}</div>
      </article>
    `;
  }).join("");
}

function renderAll() {
  renderStats();
  renderNav();
  renderSort();
  renderList();
}

function showTrip(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  state.currentTripId = trip.id;
  renderTrip();
  openOverlay("trip-overlay");
}

function closeTrip() {
  closeOverlay("trip-overlay");
  state.currentTripId = null;
  renderAll();
}

function renderTrip() {
  const trip = getTrip(state.currentTripId);
  if (!trip) return;

  const entries = entriesForTrip(state.entries, trip.id);
  const days = daysBetween(trip.startIso, trip.endIso);
  const counts = tripEntryCounts(state.entries, trip.id);

  $("trip-body").innerHTML = `
    <button class="back-btn" data-action="trip-back" type="button">Back to trips</button>
    <div class="trip-head-dates">
      <span>${esc(formatDateRange(trip.startIso, trip.endIso).toUpperCase())} | ${plural(days, "day").toUpperCase()}</span>
      <span>${esc(statusLabel(trip))}</span>
    </div>
    <h2 class="trip-head-title">${esc(trip.title)}</h2>
    <div class="trip-head-route">${esc(routeLabel(trip))}</div>

    <div class="action-row">
      <button class="action-link" data-action="compose-journal" type="button">+ Journal</button>
      <button class="action-link muted" data-action="edit-trip" type="button">Edit trip</button>
    </div>

    <hr class="detail-rule">
    <div class="section-label">Timeline | ${esc(plural(counts.total, "entry", "entries"))}</div>
    <div id="timeline">${entries.length ? renderTimeline(entries) : '<div class="empty-state">no entries yet.</div>'}</div>
  `;
}

function renderTimeline(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = dayKey(entry.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  return Array.from(groups.values()).map(dayEntries => {
    const first = dayEntries[0];
    const places = Array.from(new Set(dayEntries.map(entry => entry.locationName).filter(Boolean)));
    return `
      <section class="day-group">
        <div class="day-header">
          <span class="day-label">${esc(formatDayLabel(first.timestamp))}</span>
          <span class="day-places">${esc(places.join(" | "))}</span>
        </div>
        ${dayEntries.map(renderEntryItem).join("")}
      </section>
    `;
  }).join("");
}

function renderEntryItem(entry) {
  const paragraphs = bodyParagraphs(entry.body);
  const location = entry.locationName || "no location";
  return `
    <article class="entry" data-entry-id="${esc(entry.id)}">
      <div class="entry-meta">
        <span><span class="type">JOURNAL</span> | ${esc(formatTime(entry.timestamp))} | ${esc(location)}</span>
        <span>you</span>
      </div>
      <div class="entry-body">
        ${entry.title ? `<p class="entry-summary-title">${esc(entry.title)}</p>` : ""}
        ${paragraphs}
      </div>
    </article>
  `;
}

function bodyParagraphs(value) {
  const paragraphs = String(value || "")
    .split("\n")
    .map(part => part.trim())
    .filter(Boolean);

  return paragraphs.length
    ? paragraphs.map(part => `<p>${esc(part)}</p>`).join("")
    : "<p></p>";
}

function openEntry(entryId) {
  const entry = getEntry(entryId);
  if (!entry) return;
  state.currentEntryId = entry.id;
  renderEntry();
  openOverlay("entry-overlay");
}

function closeEntry() {
  closeOverlay("entry-overlay");
  state.currentEntryId = null;
}

function renderEntry() {
  const entry = getEntry(state.currentEntryId);
  if (!entry) return;
  const trip = getTrip(entry.tripId);

  $("entry-body").innerHTML = `
    <button class="back-btn" data-action="entry-back" type="button">Back to ${esc(trip?.title || "trip")}</button>
    <div class="entry-meta">
      <span>JOURNAL | ${esc(formatDate(entry.timestamp.slice(0, 10)))} | ${esc(formatTime(entry.timestamp))}</span>
      <span>you</span>
    </div>
    <div class="entry-location">${esc(entry.locationName || "no location")}</div>
    ${entry.title ? `<h2 class="entry-detail-title">${esc(entry.title)}</h2>` : ""}
    <div class="entry-detail-content">${bodyParagraphs(entry.body)}</div>
    <hr class="detail-rule">
    <div class="action-row">
      <button class="action-link" data-action="edit-entry" type="button">Edit</button>
      <button class="action-link muted" data-action="delete-entry" type="button">Delete</button>
    </div>
  `;
}

function openCompose(entryId = "") {
  const trip = getTrip(state.currentTripId);
  if (!trip) return;
  state.composeEntryId = entryId;
  renderCompose();
  openOverlay("compose-overlay");
  requestAnimationFrame(() => $("entry-body-input")?.focus());
}

function closeCompose() {
  closeOverlay("compose-overlay");
  state.composeEntryId = null;
}

function renderCompose() {
  const trip = getTrip(state.currentTripId);
  const entry = state.composeEntryId ? getEntry(state.composeEntryId) : null;
  const title = entry ? "Edit journal entry" : "New journal entry";

  $("compose-body").innerHTML = `
    <button class="back-btn" data-action="compose-back" type="button">Back</button>
    <h2 class="screen-title">${esc(title)}</h2>
    <div class="trip-route" style="margin-bottom:20px;">in <em>${esc(trip?.title || "")}</em></div>

    <label class="field">
      <span class="field-label">Title optional</span>
      <input class="field-input" id="entry-title-input" value="${esc(entry?.title || "")}" placeholder="a thought, a place, a moment" autocomplete="off">
    </label>

    <label class="field">
      <span class="field-label">Body</span>
      <textarea class="field-textarea" id="entry-body-input" placeholder="write...">${esc(entry?.body || "")}</textarea>
    </label>

    <label class="field">
      <span class="field-label">When</span>
      <input class="field-input" id="entry-time-input" type="datetime-local" value="${esc(toDateTimeInputValue(entry?.timestamp || new Date().toISOString()))}">
    </label>

    <label class="field">
      <span class="field-label">Location optional</span>
      <input class="field-input" id="entry-location-input" value="${esc(entry?.locationName || "")}" placeholder="city, station, cafe, trailhead" autocomplete="off">
      <span class="field-helper">Stage 1 stores this as text. Coordinates come later.</span>
    </label>

    <div class="action-row">
      <button class="action-link" data-action="save-entry" type="button">Save</button>
      <button class="action-link muted" data-action="compose-back" type="button">Cancel</button>
    </div>
  `;
}

function saveEntryFromForm() {
  const trip = getTrip(state.currentTripId);
  if (!trip) return;

  const body = $("entry-body-input")?.value.trim() || "";
  if (!body) {
    toast("write something first");
    return;
  }

  const fields = {
    title: $("entry-title-input")?.value || "",
    body,
    timestamp: fromDateTimeInputValue($("entry-time-input")?.value || ""),
    locationName: $("entry-location-input")?.value || "",
    dateUpdated: new Date().toISOString()
  };

  if (state.composeEntryId) {
    const index = state.entries.findIndex(entry => entry.id === state.composeEntryId);
    if (index < 0) return;
    state.entries[index] = normalizeEntry({
      ...state.entries[index],
      ...fields
    });
    toast("entry updated");
  } else {
    state.entries.push(createJournalEntry(trip.id, fields));
    toast("entry saved");
  }

  save();
  closeCompose();
  renderTrip();
  renderAll();
}

function deleteCurrentEntry() {
  const entry = getEntry(state.currentEntryId);
  if (!entry) return;
  if (!globalThis.confirm("Delete this entry?")) return;

  const index = state.entries.findIndex(candidate => candidate.id === entry.id);
  if (index >= 0) {
    state.entries[index] = normalizeEntry({
      ...state.entries[index],
      deleted: true,
      dateUpdated: new Date().toISOString()
    });
  }

  save();
  closeEntry();
  renderTrip();
  renderAll();
  toast("entry deleted");
}

function openTripForm() {
  const trip = getTrip(state.currentTripId);
  if (!trip) return;
  state.editingTripId = trip.id;
  renderTripForm();
  openOverlay("trip-form-overlay");
  requestAnimationFrame(() => $("trip-title-input")?.focus());
}

function closeTripForm() {
  closeOverlay("trip-form-overlay");
  state.editingTripId = null;
}

function renderTripForm() {
  const trip = getTrip(state.editingTripId);
  if (!trip) return;

  $("trip-form-body").innerHTML = `
    <button class="back-btn" data-action="trip-form-back" type="button">Back</button>
    <h2 class="screen-title">Edit trip</h2>

    <label class="field">
      <span class="field-label">Title</span>
      <input class="field-input" id="trip-title-input" value="${esc(trip.title)}" autocomplete="off">
    </label>

    <div class="field-row">
      <label class="field">
        <span class="field-label">Start</span>
        <input class="field-input" id="trip-start-input" type="date" value="${esc(trip.startIso)}">
      </label>
      <label class="field">
        <span class="field-label">End</span>
        <input class="field-input" id="trip-end-input" type="date" value="${esc(trip.endIso)}">
      </label>
    </div>

    <label class="field">
      <span class="field-label">Cities</span>
      <input class="field-input" id="trip-cities-input" value="${esc(citiesToInput(trip.cities))}" placeholder="Venice, Split, Dubrovnik" autocomplete="off">
      <span class="field-helper">Separate cities with commas.</span>
    </label>

    <div class="action-row">
      <button class="action-link" data-action="save-trip" type="button">Save</button>
      <button class="action-link muted" data-action="delete-trip" type="button">Delete trip</button>
      <button class="action-link muted" data-action="trip-form-back" type="button">Cancel</button>
    </div>
  `;
}

function saveTripFromForm() {
  const trip = getTrip(state.editingTripId);
  if (!trip) return;

  const title = $("trip-title-input")?.value.trim() || "";
  if (!title) {
    toast("title required");
    return;
  }

  const index = state.trips.findIndex(candidate => candidate.id === trip.id);
  if (index < 0) return;

  state.trips[index] = normalizeTrip({
    ...state.trips[index],
    title,
    startIso: $("trip-start-input")?.value || trip.startIso,
    endIso: $("trip-end-input")?.value || trip.endIso,
    cities: parseCitiesInput($("trip-cities-input")?.value || ""),
    dateUpdated: new Date().toISOString()
  });

  save();
  closeTripForm();
  renderTrip();
  renderAll();
  toast("trip updated");
}

function deleteCurrentTrip() {
  const trip = getTrip(state.editingTripId);
  if (!trip) return;
  if (!globalThis.confirm("Delete this trip and its entries?")) return;

  const now = new Date().toISOString();
  state.trips = state.trips.map(candidate => candidate.id === trip.id
    ? normalizeTrip({ ...candidate, deleted: true, dateUpdated: now })
    : candidate);
  state.entries = state.entries.map(entry => entry.tripId === trip.id
    ? normalizeEntry({ ...entry, deleted: true, dateUpdated: now })
    : entry);

  save();
  closeTripForm();
  closeTrip();
  renderAll();
  toast("trip deleted");
}

function createTripFromInput(value) {
  const title = value.trim();
  if (!title) return;

  const trip = createTrip(title);
  state.trips.unshift(trip);
  save();

  const input = $("main-input");
  input.value = "";
  state.search = "";
  $("input-status").textContent = "";
  renderAll();
  showTrip(trip.id);
  toast("trip created");
}

function openOverlay(id) {
  const overlay = $(id);
  overlay.classList.add("active");
  overlay.setAttribute("aria-hidden", "false");
  overlay.scrollTop = 0;
  syncBodyScroll();
}

function closeOverlay(id) {
  const overlay = $(id);
  overlay.classList.remove("active");
  overlay.setAttribute("aria-hidden", "true");
  syncBodyScroll();
}

function syncBodyScroll() {
  const anyOpen = Array.from(document.querySelectorAll(".overlay")).some(overlay => overlay.classList.contains("active"));
  document.body.classList.toggle("no-scroll", anyOpen);
}

function closeTopOverlay() {
  if ($("trip-form-overlay").classList.contains("active")) return closeTripForm();
  if ($("compose-overlay").classList.contains("active")) return closeCompose();
  if ($("entry-overlay").classList.contains("active")) return closeEntry();
  if ($("trip-overlay").classList.contains("active")) return closeTrip();
}

function bindEvents() {
  const input = $("main-input");
  const status = $("input-status");

  input.addEventListener("input", () => {
    const value = input.value.trim();
    state.search = value;
    status.textContent = value ? "press enter to create a trip, or keep typing to search" : "";
    renderList();
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      createTripFromInput(input.value);
    }

    if (event.key === "Escape") {
      input.value = "";
      state.search = "";
      status.textContent = "";
      renderList();
      input.blur();
    }
  });

  $("nav").addEventListener("click", event => {
    const item = event.target.closest(".nav-item");
    if (!item) return;
    state.filter = item.dataset.filter;
    renderAll();
  });

  $("sort-control").addEventListener("click", () => {
    const index = SORT_MODES.indexOf(state.sort);
    state.sort = SORT_MODES[(index + 1) % SORT_MODES.length];
    renderAll();
  });

  $("trip-list").addEventListener("click", event => {
    const item = event.target.closest(".trip-item");
    if (item) showTrip(item.dataset.tripId);
  });

  $("trip-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "trip-back") return closeTrip();
      if (action.dataset.action === "compose-journal") return openCompose();
      if (action.dataset.action === "edit-trip") return openTripForm();
    }

    const entry = event.target.closest(".entry");
    if (entry) openEntry(entry.dataset.entryId);
  });

  $("entry-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "entry-back") return closeEntry();
    if (action.dataset.action === "edit-entry") {
      const entry = getEntry(state.currentEntryId);
      if (!entry) return;
      state.currentTripId = entry.tripId;
      return openCompose(entry.id);
    }
    if (action.dataset.action === "delete-entry") return deleteCurrentEntry();
  });

  $("compose-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "compose-back") return closeCompose();
    if (action.dataset.action === "save-entry") return saveEntryFromForm();
  });

  $("trip-form-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "trip-form-back") return closeTripForm();
    if (action.dataset.action === "save-trip") return saveTripFromForm();
    if (action.dataset.action === "delete-trip") return deleteCurrentTrip();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeTopOverlay();
  });
}

function init() {
  bindEvents();
  renderAll();
}

init();
