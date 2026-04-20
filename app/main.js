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
const TILE_LAYER_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_LAYER_OPTIONS = {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  subdomains: "abcd",
  maxZoom: 19
};
const MARKER_STYLE = {
  radius: 6,
  fillColor: "#8b0000",
  fillOpacity: 0.85,
  color: "#fffff8",
  weight: 2,
  opacity: 1
};

const loadedState = loadAppState();
const state = {
  ...loadedState,
  filter: "all",
  sort: "recent",
  search: "",
  currentTripId: null,
  currentEntryId: null,
  composeEntryId: null,
  editingTripId: null,
  isChangingEntryLocation: false,
  entryLocationDraft: null,
  entryLocationQuery: "",
  entryLocationError: "",
  geolocationStatus: "checking",
  geolocationMessage: "checking location...",
  lastPosition: null
};

const $ = id => document.getElementById(id);
let toastTimer;
const overlayFocusStack = [];
let tripMap = null;
let entryMap = null;
let composeMap = null;

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

async function initGeolocation() {
  if (!("geolocation" in navigator)) {
    setGeolocationStatus("unavailable", "location unavailable in this browser");
    return;
  }

  setGeolocationStatus("checking", "checking location...");

  if (navigator.permissions?.query) {
    try {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      updatePermissionStatus(permission.state);
      permission.addEventListener("change", () => {
        updatePermissionStatus(permission.state);
        if (permission.state === "granted") {
          refreshCurrentPosition({ quiet: true });
        }
      });
    } catch {
      // Some browsers expose Permissions but not geolocation queries.
    }
  }

  refreshCurrentPosition();
}

function updatePermissionStatus(permissionState) {
  if (permissionState === "granted") {
    setGeolocationStatus("enabled", state.lastPosition ? "location enabled" : "location enabled; finding position...");
  } else if (permissionState === "denied") {
    setGeolocationStatus("denied", "location denied; entries will save without coordinates");
  } else if (permissionState === "prompt") {
    setGeolocationStatus("prompting", "allow location to geotag entries");
  }
}

function setGeolocationStatus(status, message) {
  state.geolocationStatus = status;
  state.geolocationMessage = message;
  renderLocationStatus();
}

function renderLocationStatus() {
  const el = $("location-status");
  if (!el) return;
  el.textContent = state.geolocationMessage || "";
}

function refreshCurrentPosition(options = {}) {
  if (!("geolocation" in navigator)) {
    setGeolocationStatus("unavailable", "location unavailable in this browser");
    return Promise.resolve(null);
  }

  if (!options.quiet) setGeolocationStatus("locating", "asking for location...");

  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(position => {
      const capturedAt = new Date().toISOString();
      state.lastPosition = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        capturedAt
      };
      setGeolocationStatus("enabled", `location enabled | +/- ${Math.round(position.coords.accuracy)}m`);
      requestAnimationFrame(renderComposeMap);
      resolve(state.lastPosition);
    }, error => {
      const status = error.code === error.PERMISSION_DENIED ? "denied" : "error";
      const message = error.code === error.PERMISSION_DENIED
        ? "location denied; entries will save without coordinates"
        : "location not available; entries will save without coordinates";
      setGeolocationStatus(status, message);
      requestAnimationFrame(renderComposeMap);
      resolve(null);
    }, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    });
  });
}

async function positionForNewEntry() {
  if (state.geolocationStatus === "denied") return null;
  if (state.lastPosition && Date.now() - new Date(state.lastPosition.capturedAt).getTime() < 300000) {
    return state.lastPosition;
  }
  return await refreshCurrentPosition({ quiet: true });
}

async function geocodeAddress(query) {
  const text = String(query || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("enter an address");

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", text);

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) throw new Error(`geocoder returned ${response.status}`);

  const results = await response.json();
  const result = Array.isArray(results) ? results[0] : null;
  const lat = Number(result?.lat);
  const lng = Number(result?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("location not found");
  }

  const address = result.address || {};
  return {
    lat,
    lng,
    locationQuery: text,
    locationDisplayName: String(result.display_name || text).trim(),
    locationCity: cityFromAddress(address),
    locationRegion: String(address.state || address.region || address.province || "").trim(),
    locationCountry: String(address.country || "").trim(),
    locationAccuracy: null,
    geotaggedAt: new Date().toISOString(),
    geotagStatus: "ready"
  };
}

function cityFromAddress(address = {}) {
  return String(
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    address.municipality ||
    address.county ||
    ""
  ).trim();
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

function routeCities(trip) {
  return uniqueLabels([
    ...trip.cities,
    ...entriesForTrip(state.entries, trip.id).map(entryRouteLabel).filter(Boolean)
  ]);
}

function routeLabel(trip) {
  const cities = routeCities(trip);
  return cities.length ? cities.join(" - ") : "no cities yet";
}

function entryRouteLabel(entry) {
  return entry.locationCity ||
    entry.locationQuery ||
    firstDisplayNamePart(entry.locationDisplayName);
}

function firstDisplayNamePart(value) {
  return String(value || "").split(",")[0]?.trim() || "";
}

function uniqueLabels(labels) {
  const seen = new Set();
  const result = [];
  for (const label of labels) {
    const clean = String(label || "").replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function statusLabel(trip) {
  if (isTripActive(trip)) return "NOW";
  if (isTripPast(trip)) return "PAST";
  return "PLANNED";
}

function hasGeotag(entry) {
  return Number.isFinite(entry.lat) && Number.isFinite(entry.lng);
}

function entryLocationLabel(entry) {
  if (entry.locationQuery) return entry.locationQuery;
  if (entry.locationDisplayName) return entry.locationDisplayName;
  if (hasGeotag(entry)) return `${entry.lat.toFixed(5)}, ${entry.lng.toFixed(5)}`;
  if (entry.geotagStatus === "denied") return "location denied";
  if (entry.geotagStatus === "unavailable" || entry.geotagStatus === "error") return "location unavailable";
  return "no location";
}

function currentPositionLabel() {
  if (state.lastPosition) return `${state.lastPosition.lat.toFixed(5)}, ${state.lastPosition.lng.toFixed(5)}`;
  return state.geolocationMessage || "location status unknown";
}

function geotaggedEntriesForTrip(tripId) {
  return entriesForTrip(state.entries, tripId).filter(hasGeotag);
}

function leaflet() {
  return globalThis.L || null;
}

function destroyMap(map) {
  if (map) map.remove();
  return null;
}

function renderMapUnavailable(container, message = "map unavailable") {
  if (!container) return;
  container.innerHTML = `<div class="map-empty">${esc(message)}</div>`;
}

function createBaseMap(container, options = {}) {
  const Leaflet = leaflet();
  if (!Leaflet || !container) return null;

  container.innerHTML = "";
  const map = Leaflet.map(container, {
    zoomControl: Boolean(options.zoomControl),
    attributionControl: true
  });

  Leaflet.tileLayer(TILE_LAYER_URL, TILE_LAYER_OPTIONS).addTo(map);
  return map;
}

function fitMapToPoints(map, points, maxZoom = 15) {
  const Leaflet = leaflet();
  if (!Leaflet || !map || !points.length) return;

  requestAnimationFrame(() => {
    map.invalidateSize();
    if (points.length === 1) {
      map.setView(points[0], maxZoom);
      return;
    }

    map.fitBounds(Leaflet.latLngBounds(points), {
      padding: [28, 28],
      maxZoom
    });
  });
}

function renderSinglePointMap({ container, point, label, accuracy, zoom = 15 }) {
  const Leaflet = leaflet();
  if (!Leaflet) {
    renderMapUnavailable(container);
    return null;
  }

  const map = createBaseMap(container);
  if (!map) return null;

  Leaflet.circleMarker(point, MARKER_STYLE)
    .bindTooltip(esc(label), {
      className: "entry-tooltip",
      direction: "top",
      offset: [0, -6]
    })
    .addTo(map);

  if (Number.isFinite(accuracy) && accuracy > 0) {
    Leaflet.circle(point, {
      radius: accuracy,
      color: "#8b0000",
      weight: 1,
      opacity: 0.25,
      fillColor: "#8b0000",
      fillOpacity: 0.05
    }).addTo(map);
  }

  fitMapToPoints(map, [point], zoom);
  return map;
}

function renderTripMap(tripId) {
  const container = $("trip-map");
  if (!container) return;

  tripMap = destroyMap(tripMap);
  const Leaflet = leaflet();
  if (!Leaflet) {
    renderMapUnavailable(container);
    return;
  }

  const entries = geotaggedEntriesForTrip(tripId);
  if (!entries.length) {
    renderMapUnavailable(container, "no located entries yet");
    return;
  }

  tripMap = createBaseMap(container);
  if (!tripMap) return;

  const points = entries.map(entry => [entry.lat, entry.lng]);
  if (points.length > 1) {
    Leaflet.polyline(points, {
      color: "#8b0000",
      weight: 1.2,
      opacity: 0.55,
      dashArray: "3,4"
    }).addTo(tripMap);
  }

  for (const entry of entries) {
    const point = [entry.lat, entry.lng];
    const title = entry.title || formatDayLabel(entry.timestamp);
    const marker = Leaflet.circleMarker(point, MARKER_STYLE);
    marker.bindTooltip(
      `<strong>${esc(title)}</strong><br><span style="color:#999;font-family:var(--mono);font-size:10.5px;">${esc(formatTime(entry.timestamp))}</span>`,
      {
        className: "entry-tooltip",
        direction: "top",
        offset: [0, -6]
      }
    );
    marker.on("click", () => openEntry(entry.id));
    marker.addTo(tripMap);
  }

  fitMapToPoints(tripMap, points, 10);
}

function renderEntryMap(entryId) {
  const container = $("entry-map");
  entryMap = destroyMap(entryMap);
  if (!container) return;

  const entry = getEntry(entryId);
  if (!entry || !hasGeotag(entry)) return;

  entryMap = renderSinglePointMap({
    container,
    point: [entry.lat, entry.lng],
    label: entry.title || "journal entry",
    accuracy: entry.locationAccuracy,
    zoom: 15
  });
}

function renderComposeMap() {
  const container = $("compose-location-map");
  composeMap = destroyMap(composeMap);
  if (!container) return;

  const entry = state.composeEntryId ? getEntry(state.composeEntryId) : null;
  if (state.entryLocationDraft && hasGeotag(state.entryLocationDraft)) {
    composeMap = renderSinglePointMap({
      container,
      point: [state.entryLocationDraft.lat, state.entryLocationDraft.lng],
      label: state.entryLocationDraft.locationQuery || "new location",
      accuracy: state.entryLocationDraft.locationAccuracy,
      zoom: 15
    });
    return;
  }

  if (entry && hasGeotag(entry)) {
    composeMap = renderSinglePointMap({
      container,
      point: [entry.lat, entry.lng],
      label: entry.title || "saved location",
      accuracy: entry.locationAccuracy,
      zoom: 15
    });
    return;
  }

  if (state.lastPosition) {
    composeMap = renderSinglePointMap({
      container,
      point: [state.lastPosition.lat, state.lastPosition.lng],
      label: "current location",
      accuracy: state.lastPosition.accuracy,
      zoom: 15
    });
    return;
  }

  renderMapUnavailable(container, state.geolocationMessage || "waiting for current location");
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
    for (const city of routeCities(trip)) cities.add(city);
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
  renderLocationStatus();
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
  tripMap = destroyMap(tripMap);
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
    <div class="map-panel"><div class="map-canvas" id="trip-map"></div></div>
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

  requestAnimationFrame(() => renderTripMap(trip.id));
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
    const places = Array.from(new Set(dayEntries.filter(hasGeotag).map(entry => entryLocationLabel(entry))));
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
  const location = entryLocationLabel(entry);
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
  entryMap = destroyMap(entryMap);
  closeOverlay("entry-overlay");
  state.currentEntryId = null;
}

function renderEntry() {
  const entry = getEntry(state.currentEntryId);
  if (!entry) return;
  const trip = getTrip(entry.tripId);

  $("entry-body").innerHTML = `
    ${hasGeotag(entry) ? '<div class="map-panel compact"><div class="map-canvas" id="entry-map"></div></div>' : ""}
    <button class="back-btn" data-action="entry-back" type="button">Back to ${esc(trip?.title || "trip")}</button>
    <div class="entry-meta">
      <span>JOURNAL | ${esc(formatDate(entry.timestamp.slice(0, 10)))} | ${esc(formatTime(entry.timestamp))}</span>
      <span>you</span>
    </div>
    <div class="entry-location">${esc(entryLocationLabel(entry))}${entry.locationAccuracy ? ` | +/- ${esc(Math.round(entry.locationAccuracy))}m` : ""}</div>
    ${entry.title ? `<h2 class="entry-detail-title">${esc(entry.title)}</h2>` : ""}
    <div class="entry-detail-content">${bodyParagraphs(entry.body)}</div>
    <hr class="detail-rule">
    <div class="action-row">
      <button class="action-link" data-action="edit-entry" type="button">Edit</button>
      <button class="action-link muted" data-action="delete-entry" type="button">Delete</button>
    </div>
  `;

  requestAnimationFrame(() => renderEntryMap(entry.id));
}

function openCompose(entryId = "") {
  const trip = getTrip(state.currentTripId);
  if (!trip) return;
  state.composeEntryId = entryId;
  state.isChangingEntryLocation = false;
  state.entryLocationDraft = null;
  state.entryLocationQuery = "";
  state.entryLocationError = "";
  renderCompose();
  openOverlay("compose-overlay");
  requestAnimationFrame(() => $("entry-body-input")?.focus());
}

function closeCompose() {
  composeMap = destroyMap(composeMap);
  closeOverlay("compose-overlay");
  state.composeEntryId = null;
  state.isChangingEntryLocation = false;
  state.entryLocationDraft = null;
  state.entryLocationQuery = "";
  state.entryLocationError = "";
}

function renderLocationField(entry, label) {
  const canChange = true;
  const changing = canChange && state.isChangingEntryLocation;
  const draft = state.entryLocationDraft;
  const displayLabel = draft ? entryLocationLabel(draft) : label;
  const query = state.entryLocationQuery || draft?.locationQuery || entry?.locationQuery || entry?.locationDisplayName || "";
  const helper = state.entryLocationError || displayLabel;

  return `
    <div class="field">
      <div class="field-label-row">
        <span class="field-label">Location</span>
        ${canChange && !changing ? '<button class="inline-link" data-action="change-entry-location" type="button">change</button>' : ""}
      </div>
      <span class="field-helper ${state.entryLocationError ? "accent" : ""}">${esc(helper)}</span>
      ${changing ? `
        <div class="location-edit-form">
          <input class="field-input" id="location-query-input" value="${esc(query)}" placeholder="address, place, or city" autocomplete="street-address">
          <div class="action-row compact">
            <button class="action-link" data-action="geocode-entry-location" type="button">Find</button>
            <button class="action-link muted" data-action="cancel-location-change" type="button">Cancel</button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

function renderCompose() {
  const trip = getTrip(state.currentTripId);
  const entry = state.composeEntryId ? getEntry(state.composeEntryId) : null;
  const title = entry ? "Edit journal entry" : "New journal entry";
  const locationLabel = entry
    ? entryLocationLabel(entry)
    : currentPositionLabel();

  $("compose-body").innerHTML = `
    <div class="map-panel compact"><div class="map-canvas" id="compose-location-map"></div></div>
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

    ${renderLocationField(entry, locationLabel)}

    <div class="action-row">
      <button class="action-link" data-action="save-entry" type="button">Save</button>
      <button class="action-link muted" data-action="compose-back" type="button">Cancel</button>
    </div>
  `;

  requestAnimationFrame(renderComposeMap);
}

async function geocodeEntryLocationFromForm() {
  const input = $("location-query-input");
  const query = input?.value || "";
  state.entryLocationQuery = query;
  state.entryLocationError = "";

  try {
    const geocode = await geocodeAddress(query);
    state.entryLocationDraft = geocode;
    state.entryLocationQuery = geocode.locationQuery;
    state.isChangingEntryLocation = false;
    renderCompose();
    toast("location found");
  } catch (error) {
    state.entryLocationError = error instanceof Error ? error.message : "location not found";
    renderCompose();
    requestAnimationFrame(() => $("location-query-input")?.focus());
  }
}

async function saveEntryFromForm() {
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
    dateUpdated: new Date().toISOString()
  };

  if (state.entryLocationDraft) {
    Object.assign(fields, {
      lat: state.entryLocationDraft.lat,
      lng: state.entryLocationDraft.lng,
      locationQuery: state.entryLocationDraft.locationQuery,
      locationDisplayName: state.entryLocationDraft.locationDisplayName,
      locationCity: state.entryLocationDraft.locationCity,
      locationRegion: state.entryLocationDraft.locationRegion,
      locationCountry: state.entryLocationDraft.locationCountry,
      locationAccuracy: state.entryLocationDraft.locationAccuracy,
      geotaggedAt: state.entryLocationDraft.geotaggedAt,
      geotagStatus: state.entryLocationDraft.geotagStatus
    });
  }

  if (state.composeEntryId) {
    const index = state.entries.findIndex(entry => entry.id === state.composeEntryId);
    if (index < 0) return;
    state.entries[index] = normalizeEntry({
      ...state.entries[index],
      ...fields
    });
    toast("entry updated");
  } else {
    const position = state.entryLocationDraft ? null : await positionForNewEntry();
    if (position && !state.entryLocationDraft) {
      fields.lat = position.lat;
      fields.lng = position.lng;
      fields.locationAccuracy = position.accuracy;
      fields.geotaggedAt = position.capturedAt;
      fields.geotagStatus = "ready";
      fields.locationCity = "";
      fields.locationRegion = "";
      fields.locationCountry = "";
    } else {
      fields.geotagStatus = state.geolocationStatus === "denied" ? "denied" : "unavailable";
    }
    state.entries.push(createJournalEntry(trip.id, fields));
    toast("entry saved");
  }

  save();
  closeCompose();
  if (state.currentEntryId) renderEntry();
  if (state.currentTripId) renderTrip();
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
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlayFocusStack.push({ id, previousFocus });
  overlay.inert = false;
  overlay.classList.add("active");
  overlay.setAttribute("aria-hidden", "false");
  overlay.scrollTop = 0;
  syncBodyScroll();
}

function closeOverlay(id) {
  const overlay = $(id);
  moveFocusBeforeHiding(overlay, id);
  forceFocusOutside(overlay);
  overlay.classList.remove("active");
  overlay.setAttribute("aria-hidden", "true");
  overlay.inert = true;
  syncBodyScroll();
}

function moveFocusBeforeHiding(overlay, id) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !overlay.contains(active)) return;

  const previousFocus = previousFocusForOverlay(id);
  const target = isVisibleFocusTarget(previousFocus, overlay)
    ? previousFocus
    : safeFocusTargetAfterClose(overlay);

  focusElement(target);
}

function forceFocusOutside(overlay) {
  if (!overlay.contains(document.activeElement)) return;

  focusElement(safeFocusTargetAfterClose(overlay));
  if (overlay.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

function previousFocusForOverlay(id) {
  for (let index = overlayFocusStack.length - 1; index >= 0; index -= 1) {
    const item = overlayFocusStack[index];
    overlayFocusStack.splice(index, 1);
    if (item.id === id) return item.previousFocus;
  }
  return null;
}

function isVisibleFocusTarget(element, closingOverlay) {
  if (!(element instanceof HTMLElement) || !element.isConnected || closingOverlay.contains(element)) return false;
  if (element.closest("[aria-hidden='true']")) return false;
  if (element.closest("[inert]")) return false;
  return true;
}

function safeFocusTargetAfterClose(closingOverlay) {
  const activeOverlays = Array.from(document.querySelectorAll(".overlay.active"))
    .filter(overlay => overlay !== closingOverlay && !overlay.inert && overlay.getAttribute("aria-hidden") !== "true");
  const parentOverlay = activeOverlays[activeOverlays.length - 1];

  if (parentOverlay) {
    return parentOverlay.querySelector(".back-btn") ||
      firstVisibleFocusTarget(parentOverlay, closingOverlay) ||
      parentOverlay.querySelector(".overlay-body");
  }

  return $("main-input") || $("app");
}

function firstVisibleFocusTarget(root, closingOverlay) {
  const selector = "button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])";
  return Array.from(root.querySelectorAll(selector))
    .find(element => isVisibleFocusTarget(element, closingOverlay)) || null;
}

function focusElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element;
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
    if (action.dataset.action === "change-entry-location") {
      state.isChangingEntryLocation = true;
      state.entryLocationError = "";
      renderCompose();
      requestAnimationFrame(() => $("location-query-input")?.focus());
      return;
    }
    if (action.dataset.action === "cancel-location-change") {
      state.isChangingEntryLocation = false;
      state.entryLocationError = "";
      renderCompose();
      return;
    }
    if (action.dataset.action === "geocode-entry-location") {
      geocodeEntryLocationFromForm().catch(error => {
        state.entryLocationError = error instanceof Error ? error.message : "location not found";
        renderCompose();
      });
      return;
    }
    if (action.dataset.action === "save-entry") {
      saveEntryFromForm().catch(error => {
        toast(error instanceof Error ? error.message : "entry could not be saved");
      });
    }
  });

  $("compose-overlay").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.target?.id !== "location-query-input") return;
    event.preventDefault();
    geocodeEntryLocationFromForm().catch(error => {
      state.entryLocationError = error instanceof Error ? error.message : "location not found";
      renderCompose();
    });
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
  document.querySelectorAll(".overlay").forEach(overlay => {
    overlay.inert = true;
  });
  bindEvents();
  renderAll();
  initGeolocation();
}

init();
