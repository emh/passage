import {
  applyMutations,
  applyMutation,
  compareHlc,
  createMutation,
  createJournalEntry,
  createTrip,
  daysBetween,
  ENTRY_FIELDS,
  entriesForTrip,
  fromDateTimeInputValue,
  isTripActive,
  isTripPast,
  normalizeCode,
  normalizeEntry,
  normalizeProfile,
  normalizeTrip,
  TRIP_FIELDS,
  toDateTimeInputValue,
  tripEntryCounts,
  visibleEntries,
  visibleTrips
} from "./model.js";
import { loadAppState, loadSettings, saveAppState } from "./storage.js";
import { createRemoteProfile, fetchRemoteProfile, PassageSync } from "./sync.js";

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
const settings = loadSettings();
const state = {
  ...loadedState,
  settings,
  syncStatus: settings.syncBaseUrl ? "unlinked" : "local",
  search: "",
  currentTripId: null,
  currentEntryId: null,
  composeEntryId: null,
  editingTripId: null,
  pendingDeleteEntryId: null,
  pendingDeleteTripId: null,
  pendingLinkCode: "",
  linkBusy: false,
  linkError: "",
  isChangingEntryLocation: false,
  entryLocationDraft: null,
  entryLocationQuery: "",
  entryLocationError: "",
  entryFormDraft: null,
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
let profileSync = null;

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function save() {
  saveAppState(state);
}

function syncQueue() {
  return state.profileSync?.mutationQueue || [];
}

function saveAndFlushSync() {
  save();
  profileSync?.flush();
}

function runAction(fn) {
  Promise.resolve(fn()).catch(error => {
    toast(error instanceof Error ? error.message : String(error));
  });
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

function syncIndicatorState() {
  const pendingCount = syncQueue().length;
  if (state.syncStatus === "syncing") return { tone: "syncing", label: "syncing" };
  if (state.syncStatus === "synced") return { tone: "synced", label: "synced" };
  if (state.syncStatus === "offline") return { tone: pendingCount ? "pending" : "ready", label: pendingCount ? `${plural(pendingCount, "change")} pending` : "offline" };
  if (pendingCount) return { tone: "pending", label: `${plural(pendingCount, "change")} pending` };
  if (!state.settings.syncBaseUrl) return { tone: "local", label: "local only" };
  if (state.profile?.code) return { tone: "ready", label: "linked" };
  return { tone: "ready", label: "ready to link" };
}

function renderSyncIndicator() {
  const dot = $("sync-dot");
  const link = $("link-device-btn");
  if (!dot || !link) return;

  const indicator = syncIndicatorState();
  dot.classList.toggle("synced", indicator.tone === "synced");
  dot.classList.toggle("pending", indicator.tone === "pending" || indicator.tone === "syncing");
  dot.classList.toggle("ready", indicator.tone === "ready");
  dot.classList.toggle("local", indicator.tone === "local");
  dot.setAttribute("aria-label", indicator.label);
  dot.title = indicator.label;
  link.title = indicator.label;
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
      refreshComposeLocationView();
      resolve(state.lastPosition);
    }, error => {
      const status = error.code === error.PERMISSION_DENIED ? "denied" : "error";
      const message = error.code === error.PERMISSION_DENIED
        ? "location denied; entries will save without coordinates"
        : "location not available; entries will save without coordinates";
      setGeolocationStatus(status, message);
      refreshComposeLocationView();
      resolve(null);
    }, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    });
  });
}

function refreshComposeLocationView() {
  if ($("compose-overlay")?.classList.contains("active")) {
    captureEntryFormDraft();
    renderCompose();
    return;
  }

  requestAnimationFrame(renderComposeMap);
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
  return uniqueLabels(entriesForTrip(state.entries, trip.id).map(entryRouteLabel).filter(Boolean));
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
  return "";
}

function entryMetaLine(entry, options = {}) {
  const parts = [];
  if (options.includeDate) parts.push(formatDate(entry.timestamp.slice(0, 10)));
  parts.push(formatTime(entry.timestamp));
  const location = options.shortLocation ? entryRouteLabel(entry) : entryLocationLabel(entry);
  if (location) parts.push(location);
  return parts.filter(Boolean).join(" | ");
}

function currentPositionLabel() {
  if (state.lastPosition) return `${state.lastPosition.lat.toFixed(5)}, ${state.lastPosition.lng.toFixed(5)}`;
  return state.geolocationMessage || "location status unknown";
}

function queueLocalMutation(entityType, entityId, field, value) {
  const mutation = createMutation(state, entityType, entityId, field, value);
  if (applyMutation(state, mutation)) {
    syncQueue().push(mutation);
  }
  return mutation;
}

function queueEntityCreate(entityType, record) {
  return queueLocalMutation(entityType, record.id, "_create", record);
}

function queueEntityPatch(entityType, currentRecord, nextRecord, fields) {
  let changed = 0;
  for (const field of fields) {
    if (field === "id") continue;
    if (valuesEqual(currentRecord[field], nextRecord[field])) continue;
    queueLocalMutation(entityType, currentRecord.id, field, nextRecord[field]);
    changed += 1;
  }
  return changed;
}

function valuesEqual(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
  return left === right;
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
    if (!query) return true;
    const haystack = `${trip.title} ${routeCities(trip).join(" ")}`.toLowerCase();
    return haystack.includes(query);
  });

  return list.sort((left, right) => new Date(`${right.startIso}T00:00:00`) - new Date(`${left.startIso}T00:00:00`));
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
          <span>${esc(formatDateRange(trip.startIso, trip.endIso))} | ${plural(days, "day").toUpperCase()} | ${esc(plural(counts.total, "entry", "entries").toUpperCase())}</span>
          <span class="right">${esc(active ? "NOW" : statusLabel(trip))}</span>
        </div>
        <h2 class="trip-title">${esc(trip.title)}</h2>
        <div class="trip-route">${esc(routeLabel(trip))}</div>
      </article>
    `;
  }).join("");
}

function renderAll() {
  renderLocationStatus();
  renderSyncIndicator();
  renderStats();
  renderList();
}

function hasLocalContent() {
  return Boolean(visibleTrips(state.trips).length || visibleEntries(state.entries).length || syncQueue().length);
}

function applyRemotePayload(payload, options = {}) {
  if (options.replaceLocal) {
    state.trips = [];
    state.entries = [];
    state.tripClocks = {};
    state.entryClocks = {};
    state.profileSync.mutationQueue = [];
    state.profileSync.lastSyncTimestamp = "";
  }

  if (Array.isArray(payload?.mutations)) {
    applyMutations(state, payload.mutations);
  }

  const incomingProfile = normalizeProfile(payload?.profile) || normalizeProfile(payload?.room?.profile);
  if (incomingProfile) {
    state.profile = {
      ...incomingProfile,
      code: payload?.code || payload?.room?.code || incomingProfile.code || ""
    };
  } else if (payload?.code && state.profile) {
    state.profile.code = payload.code;
  }

  if (Array.isArray(payload?.confirmedIds)) {
    const confirmed = new Set(payload.confirmedIds);
    state.profileSync.mutationQueue = syncQueue().filter(mutation => !confirmed.has(mutation.id));
  }

  if (payload?.highWatermark && compareHlc(payload.highWatermark, state.profileSync.lastSyncTimestamp) > 0) {
    state.profileSync.lastSyncTimestamp = payload.highWatermark;
  }
}

async function ensureProfileCode() {
  if (!state.settings.syncBaseUrl) throw new Error("Linking is not available here yet.");
  if (state.profile?.code) return state.profile.code;

  const payload = await createRemoteProfile({
    profile: state.profile,
    mutations: syncQueue()
  }, state.settings);

  applyRemotePayload(payload);
  save();
  configureSync();
  return state.profile?.code || "";
}

async function linkDevice(code, options = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Link is invalid.");
  if (!state.settings.syncBaseUrl) throw new Error("Linking is not available here yet.");

  state.linkBusy = true;
  state.linkError = "";
  renderLinkScreen();

  try {
    const payload = await fetchRemoteProfile(normalized, state.settings);
    applyRemotePayload(payload, { replaceLocal: options.replaceLocal !== false });
    state.pendingLinkCode = "";
    stripLinkQuery();
    save();
    configureSync();
    closeLinkScreen();
    renderAll();
    syncOpenViews();
    toast("Device linked");
  } catch (error) {
    state.linkError = error instanceof Error ? error.message : "Device could not be linked.";
    renderLinkScreen();
    throw error;
  } finally {
    state.linkBusy = false;
    if ($("link-overlay").classList.contains("active")) renderLinkScreen();
  }
}

function deviceLinkUrl() {
  if (!state.settings.syncBaseUrl || !state.profile?.code) return "";
  const url = new URL(globalThis.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("link", state.profile.code);
  return url.toString();
}

function renderLinkScreen() {
  const pendingCount = syncQueue().length;
  const status = syncIndicatorState();
  const linkUrl = deviceLinkUrl();
  const incomingCode = normalizeCode(state.pendingLinkCode);
  const linkCopy = state.linkBusy
    ? "Preparing link..."
    : linkUrl || (
      state.settings.syncBaseUrl
        ? "Open LINK to create a device URL."
        : "Linking is not available here yet."
    );

  if (incomingCode) {
    const counts = `${plural(visibleTrips(state.trips).length, "trip")} | ${plural(visibleEntries(state.entries).length, "entry", "entries")}`;
    $("link-body").innerHTML = `
      <button class="back-btn" data-action="cancel-link-device" type="button">BACK</button>
      <h2 class="screen-title">Link this device</h2>
      <div class="trip-route" style="margin-bottom:20px;">This will replace local data on this device.</div>

      <div class="field">
        <span class="field-label">Incoming link</span>
        <span class="field-helper">${esc(incomingCode)}</span>
      </div>

      <div class="field">
        <span class="field-label">On this device</span>
        <span class="field-helper">${esc(counts)}</span>
      </div>

      ${state.linkError ? `
        <div class="field">
          <span class="field-helper accent">${esc(state.linkError)}</span>
        </div>
      ` : ""}

      <div class="action-row">
        <button class="action-link" data-action="confirm-link-device" type="button">${state.linkBusy ? "LINKING..." : "LINK DEVICE"}</button>
        <button class="action-link secondary" data-action="cancel-link-device" type="button">CANCEL</button>
      </div>
    `;
    return;
  }

  $("link-body").innerHTML = `
    <button class="back-btn" data-action="link-back" type="button">BACK</button>
    <h2 class="screen-title">Link device</h2>
    <div class="trip-route" style="margin-bottom:20px;">${esc(status.label)}</div>

    <div class="field">
      <span class="field-label">Pending</span>
      <span class="field-helper">${esc(pendingCount ? plural(pendingCount, "change") : "no pending changes")}</span>
    </div>

    <div class="field">
      <span class="field-label">Link</span>
      <span class="field-helper break-anywhere">${esc(linkCopy)}</span>
    </div>

    ${state.linkError ? `
      <div class="field">
        <span class="field-helper accent">${esc(state.linkError)}</span>
      </div>
    ` : ""}

    ${linkUrl ? `
      <div class="action-row">
        <button class="action-link" data-action="copy-link" type="button">COPY</button>
      </div>
    ` : ""}
  `;
}

async function openLinkScreen() {
  state.linkError = "";
  renderLinkScreen();
  openOverlay("link-overlay");
  requestAnimationFrame(() => $("link-body")?.focus());

  if (!state.pendingLinkCode && state.settings.syncBaseUrl && !state.profile?.code && !state.linkBusy) {
    state.linkBusy = true;
    renderLinkScreen();
    try {
      await ensureProfileCode();
    } catch (error) {
      state.linkError = error instanceof Error ? error.message : "Link could not be prepared.";
    } finally {
      state.linkBusy = false;
      renderLinkScreen();
    }
  }
}

function closeLinkScreen() {
  state.linkBusy = false;
  closeOverlay("link-overlay");
}

function stripLinkQuery() {
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has("link")) return;
  url.searchParams.delete("link");
  globalThis.history?.replaceState?.({}, "", url);
}

function handleLinkQuery() {
  const params = new URLSearchParams(globalThis.location.search);
  const code = normalizeCode(params.get("link"));
  if (!code) return;

  if (state.profile?.code === code) {
    stripLinkQuery();
    return;
  }

  if (!hasLocalContent()) {
    runAction(() => linkDevice(code, { replaceLocal: true }));
    return;
  }

  state.pendingLinkCode = code;
  state.linkError = "";
  openLinkScreen();
}

async function copyDeviceLink() {
  const url = deviceLinkUrl();
  if (!url) throw new Error("Link is not ready yet.");
  await navigator.clipboard.writeText(url);
  toast("Link copied");
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
    <button class="back-btn" data-action="trip-back" type="button">BACK</button>
    <div class="trip-head-dates">
      <span>${esc(formatDateRange(trip.startIso, trip.endIso).toUpperCase())} | ${plural(days, "day").toUpperCase()} | ${esc(plural(counts.total, "entry", "entries").toUpperCase())}</span>
      <span>${esc(statusLabel(trip))}</span>
    </div>
    <div class="trip-title-row">
      <h2 class="trip-head-title">${esc(trip.title)}</h2>
      <button class="action-link title-action" data-action="edit-trip" type="button">EDIT</button>
    </div>
    <div class="trip-head-route">${esc(routeLabel(trip))}</div>

    <div class="action-row journal-action-row">
      <button class="action-link" data-action="compose-journal" type="button">+ JOURNAL</button>
    </div>

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
    const places = uniqueLabels(dayEntries.map(entryRouteLabel).filter(Boolean));
    return `
      <section class="day-group">
        <div class="day-header">
          <span class="day-label">${esc(formatDayLabel(first.timestamp))}</span>
          ${places.length ? `<span class="day-places">${esc(places.join(" | "))}</span>` : ""}
        </div>
        ${dayEntries.map(renderEntryItem).join("")}
      </section>
    `;
  }).join("");
}

function renderEntryItem(entry) {
  const paragraphs = bodyParagraphs(entry.body);
  return `
    <article class="entry" data-entry-id="${esc(entry.id)}">
      <div class="entry-meta">
        <span>${esc(entryMetaLine(entry, { shortLocation: true }))}</span>
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
  state.pendingDeleteEntryId = null;
}

function renderEntry() {
  const entry = getEntry(state.currentEntryId);
  if (!entry) return;
  const trip = getTrip(entry.tripId);

  $("entry-body").innerHTML = `
    ${hasGeotag(entry) ? '<div class="map-panel compact"><div class="map-canvas" id="entry-map"></div></div>' : ""}
    <button class="back-btn" data-action="entry-back" type="button">BACK</button>
    <div class="entry-meta">
      <span>${esc(entryMetaLine(entry, { includeDate: true }))}</span>
    </div>
    ${entryLocationLabel(entry) ? `<div class="entry-location">${esc(entryLocationLabel(entry))}${entry.locationAccuracy ? ` | +/- ${esc(Math.round(entry.locationAccuracy))}m` : ""}</div>` : ""}
    ${entry.title ? `<h2 class="entry-detail-title">${esc(entry.title)}</h2>` : ""}
    <div class="entry-detail-content">${bodyParagraphs(entry.body)}</div>
    <hr class="detail-rule">
    <div class="action-row delete-action-row">
      <button class="action-link" data-action="edit-entry" type="button">EDIT</button>
      <div class="delete-action-cluster">
        <button class="action-link destructive" data-action="delete-entry" type="button">DELETE</button>
        ${state.pendingDeleteEntryId === entry.id ? `
          <div class="delete-confirm-row">
            <button class="action-link destructive" data-action="confirm-delete-entry" type="button">OK</button>
            <button class="action-link secondary" data-action="cancel-delete-entry" type="button">CANCEL</button>
          </div>
        ` : ""}
      </div>
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
  state.entryFormDraft = null;
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
  state.entryFormDraft = null;
}

function captureEntryFormDraft() {
  const titleInput = $("entry-title-input");
  const bodyInput = $("entry-body-input");
  const timeInput = $("entry-time-input");
  if (!titleInput && !bodyInput && !timeInput) return;

  state.entryFormDraft = {
    title: titleInput?.value || "",
    body: bodyInput?.value || "",
    timestampInput: timeInput?.value || ""
  };
}

function entryFormValue(entry, field, fallback = "") {
  if (state.entryFormDraft && Object.hasOwn(state.entryFormDraft, field)) {
    return state.entryFormDraft[field];
  }
  return fallback;
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
        ${canChange && !changing ? '<button class="inline-link" data-action="change-entry-location" type="button">CHANGE</button>' : ""}
      </div>
      <span class="field-helper ${state.entryLocationError ? "accent" : ""}">${esc(helper)}</span>
      ${changing ? `
        <div class="location-edit-form">
          <input class="field-input" id="location-query-input" value="${esc(query)}" placeholder="address, place, or city" autocomplete="street-address">
          <div class="action-row compact">
            <button class="action-link" data-action="geocode-entry-location" type="button">FIND</button>
            <button class="action-link secondary" data-action="cancel-location-change" type="button">CANCEL</button>
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
    <button class="back-btn" data-action="compose-back" type="button">BACK</button>
    <h2 class="screen-title">${esc(title)}</h2>
    <div class="trip-route" style="margin-bottom:20px;">in <em>${esc(trip?.title || "")}</em></div>

    <label class="field">
      <span class="field-label">Title optional</span>
      <input class="field-input" id="entry-title-input" value="${esc(entryFormValue(entry, "title", entry?.title || ""))}" placeholder="a thought, a place, a moment" autocomplete="off">
    </label>

    <label class="field">
      <span class="field-label">Body</span>
      <textarea class="field-textarea" id="entry-body-input" placeholder="write...">${esc(entryFormValue(entry, "body", entry?.body || ""))}</textarea>
    </label>

    <label class="field">
      <span class="field-label">When</span>
      <input class="field-input" id="entry-time-input" type="datetime-local" value="${esc(entryFormValue(entry, "timestampInput", toDateTimeInputValue(entry?.timestamp || new Date().toISOString())))}">
    </label>

    ${renderLocationField(entry, locationLabel)}

    <div class="action-row">
      <button class="action-link" data-action="save-entry" type="button">SAVE</button>
      <button class="action-link secondary" data-action="compose-back" type="button">CANCEL</button>
    </div>
  `;

  requestAnimationFrame(renderComposeMap);
}

async function geocodeEntryLocationFromForm() {
  captureEntryFormDraft();
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
    const currentEntry = state.entries[index];
    const nextEntry = normalizeEntry({
      ...state.entries[index],
      ...fields
    });
    queueEntityPatch("entry", currentEntry, nextEntry, ENTRY_FIELDS);
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
    const entry = createJournalEntry(trip.id, fields);
    queueEntityCreate("entry", entry);
    toast("entry saved");
  }

  saveAndFlushSync();
  closeCompose();
  if (state.currentEntryId) renderEntry();
  if (state.currentTripId) renderTrip();
  renderAll();
}

function deleteCurrentEntry() {
  const entry = getEntry(state.currentEntryId);
  if (!entry) return;

  queueLocalMutation("entry", entry.id, "_delete", true);

  saveAndFlushSync();
  state.pendingDeleteEntryId = null;
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
  state.pendingDeleteTripId = null;
}

function renderTripForm() {
  const trip = getTrip(state.editingTripId);
  if (!trip) return;

  $("trip-form-body").innerHTML = `
    <button class="back-btn" data-action="trip-form-back" type="button">BACK</button>
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

    <div class="action-row delete-action-row">
      <button class="action-link" data-action="save-trip" type="button">SAVE</button>
      <div class="delete-action-cluster">
        <button class="action-link destructive" data-action="delete-trip" type="button">DELETE</button>
        ${state.pendingDeleteTripId === trip.id ? `
          <div class="delete-confirm-row">
            <button class="action-link destructive" data-action="confirm-delete-trip" type="button">OK</button>
            <button class="action-link secondary" data-action="cancel-delete-trip" type="button">CANCEL</button>
          </div>
        ` : ""}
      </div>
      <button class="action-link secondary" data-action="trip-form-back" type="button">CANCEL</button>
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

  const currentTrip = state.trips[index];
  const nextTrip = normalizeTrip({
    ...state.trips[index],
    title,
    startIso: $("trip-start-input")?.value || trip.startIso,
    endIso: $("trip-end-input")?.value || trip.endIso,
    dateUpdated: new Date().toISOString()
  });
  queueEntityPatch("trip", currentTrip, nextTrip, TRIP_FIELDS);

  saveAndFlushSync();
  closeTripForm();
  renderTrip();
  renderAll();
  toast("trip updated");
}

function deleteCurrentTrip() {
  const trip = getTrip(state.editingTripId);
  if (!trip) return;

  for (const entry of entriesForTrip(state.entries, trip.id)) {
    queueLocalMutation("entry", entry.id, "_delete", true);
  }
  queueLocalMutation("trip", trip.id, "_delete", true);

  saveAndFlushSync();
  state.pendingDeleteTripId = null;
  closeTripForm();
  closeTrip();
  renderAll();
  toast("trip deleted");
}

function createTripFromInput(value) {
  const title = value.trim();
  if (!title) return;

  const trip = createTrip(title);
  queueEntityCreate("trip", trip);
  saveAndFlushSync();

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
  if ($("link-overlay").classList.contains("active")) return closeLinkScreen();
  if ($("trip-form-overlay").classList.contains("active")) return closeTripForm();
  if ($("compose-overlay").classList.contains("active")) return closeCompose();
  if ($("entry-overlay").classList.contains("active")) return closeEntry();
  if ($("trip-overlay").classList.contains("active")) return closeTrip();
}

function syncOpenViews() {
  if (state.currentEntryId && !getEntry(state.currentEntryId)) {
    closeEntry();
  }

  if (state.editingTripId && !getTrip(state.editingTripId)) {
    closeTripForm();
  }

  if (state.currentTripId && !getTrip(state.currentTripId)) {
    closeTrip();
  }

  if ($("trip-overlay").classList.contains("active") && state.currentTripId) {
    renderTrip();
  }

  if ($("entry-overlay").classList.contains("active") && state.currentEntryId) {
    renderEntry();
  }

  if ($("trip-form-overlay").classList.contains("active") && state.editingTripId) {
    renderTripForm();
  }

  if ($("link-overlay").classList.contains("active")) {
    renderLinkScreen();
  }
}

function configureSync() {
  if (!state.settings.syncBaseUrl) {
    profileSync?.stop();
    profileSync = null;
    state.syncStatus = "local";
    renderSyncIndicator();
    return;
  }

  if (state.profile?.code) {
    if (!profileSync || profileSync.code !== state.profile.code) {
      profileSync?.stop();
      profileSync = new PassageSync({
        code: state.profile.code,
        state,
        save,
        onStatus(status) {
          state.syncStatus = status;
          renderSyncIndicator();
          if ($("link-overlay").classList.contains("active")) renderLinkScreen();
        },
        onChange() {
          save();
          renderAll();
          syncOpenViews();
        },
        onRoom(room) {
          const profile = normalizeProfile(room?.profile);
          if (profile) {
            state.profile = { ...profile, code: room.code || profile.code || "" };
            save();
          } else if (room?.code && state.profile) {
            state.profile.code = room.code;
            save();
          }
          renderSyncIndicator();
        }
      });
      profileSync.start();
      return;
    }
    return;
  }

  profileSync?.stop();
  profileSync = null;
  state.syncStatus = "unlinked";
  renderSyncIndicator();
}

function bindEvents() {
  const input = $("main-input");
  const status = $("input-status");
  const linkDeviceButton = $("link-device-btn");

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

  $("trip-list").addEventListener("click", event => {
    const item = event.target.closest(".trip-item");
    if (item) showTrip(item.dataset.tripId);
  });

  linkDeviceButton?.addEventListener("click", () => {
    runAction(openLinkScreen);
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
    if (action.dataset.action === "delete-entry") {
      state.pendingDeleteEntryId = state.currentEntryId;
      return renderEntry();
    }
    if (action.dataset.action === "cancel-delete-entry") {
      state.pendingDeleteEntryId = null;
      return renderEntry();
    }
    if (action.dataset.action === "confirm-delete-entry") return deleteCurrentEntry();
  });

  $("compose-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "compose-back") return closeCompose();
    if (action.dataset.action === "change-entry-location") {
      captureEntryFormDraft();
      state.isChangingEntryLocation = true;
      state.entryLocationError = "";
      renderCompose();
      requestAnimationFrame(() => $("location-query-input")?.focus());
      return;
    }
    if (action.dataset.action === "cancel-location-change") {
      captureEntryFormDraft();
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
    if (action.dataset.action === "delete-trip") {
      state.pendingDeleteTripId = state.editingTripId;
      return renderTripForm();
    }
    if (action.dataset.action === "cancel-delete-trip") {
      state.pendingDeleteTripId = null;
      return renderTripForm();
    }
    if (action.dataset.action === "confirm-delete-trip") return deleteCurrentTrip();
  });

  $("link-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "link-back") return closeLinkScreen();
    if (action.dataset.action === "copy-link") return runAction(copyDeviceLink);
    if (action.dataset.action === "confirm-link-device") return runAction(() => linkDevice(state.pendingLinkCode, { replaceLocal: true }));
    if (action.dataset.action === "cancel-link-device") {
      state.pendingLinkCode = "";
      state.linkError = "";
      stripLinkQuery();
      closeLinkScreen();
      renderAll();
    }
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
  configureSync();
  handleLinkQuery();
  initGeolocation();
}

init();
