export const TRIP_FIELDS = [
  "title",
  "startIso",
  "endIso",
  "cities",
  "dateCreated",
  "dateUpdated",
  "deleted"
];

export const ENTRY_FIELDS = [
  "tripId",
  "type",
  "title",
  "body",
  "timestamp",
  "lat",
  "lng",
  "locationQuery",
  "locationDisplayName",
  "locationCity",
  "locationRegion",
  "locationCountry",
  "locationAccuracy",
  "geotaggedAt",
  "geotagStatus",
  "dateCreated",
  "dateUpdated",
  "deleted"
];

export function createId(prefix = "id") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(iso, days) {
  const date = parseDateOnly(iso);
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
}

export function normalizeTrip(input = {}) {
  const now = new Date().toISOString();
  const startIso = validDateOnly(input.startIso) || todayIso();
  const endIso = validDateOnly(input.endIso) || startIso;
  const normalizedEnd = parseDateOnly(endIso) < parseDateOnly(startIso) ? startIso : endIso;

  return {
    id: String(input.id || createId("trip")),
    title: cleanSingleLine(input.title) || "Untitled trip",
    startIso,
    endIso: normalizedEnd,
    cities: normalizeCities(input.cities),
    dateCreated: typeof input.dateCreated === "string" && input.dateCreated ? input.dateCreated : now,
    dateUpdated: typeof input.dateUpdated === "string" ? input.dateUpdated : "",
    deleted: Boolean(input.deleted)
  };
}

export function createTrip(title) {
  const startIso = todayIso();
  return normalizeTrip({
    id: createId("trip"),
    title,
    startIso,
    endIso: addDaysIso(startIso, 7),
    dateCreated: new Date().toISOString()
  });
}

export function normalizeEntry(input = {}) {
  const now = new Date().toISOString();
  return {
    id: String(input.id || createId("entry")),
    tripId: String(input.tripId || ""),
    type: "journal",
    title: cleanSingleLine(input.title),
    body: cleanText(input.body),
    timestamp: validDateTime(input.timestamp) || now,
    lat: geoNumberOrNull(input.lat),
    lng: geoNumberOrNull(input.lng),
    locationQuery: cleanSingleLine(input.locationQuery),
    locationDisplayName: cleanSingleLine(input.locationDisplayName),
    locationCity: cleanSingleLine(input.locationCity),
    locationRegion: cleanSingleLine(input.locationRegion),
    locationCountry: cleanSingleLine(input.locationCountry),
    locationAccuracy: geoNumberOrNull(input.locationAccuracy),
    geotaggedAt: validDateTime(input.geotaggedAt),
    geotagStatus: normalizeGeotagStatus(input.geotagStatus),
    dateCreated: typeof input.dateCreated === "string" && input.dateCreated ? input.dateCreated : now,
    dateUpdated: typeof input.dateUpdated === "string" ? input.dateUpdated : "",
    deleted: Boolean(input.deleted)
  };
}

export function createJournalEntry(tripId, fields = {}) {
  return normalizeEntry({
    ...fields,
    id: createId("entry"),
    tripId,
    type: "journal",
    timestamp: fields.timestamp || new Date().toISOString(),
    dateCreated: new Date().toISOString()
  });
}

export function visibleTrips(trips = []) {
  return trips.filter(trip => !trip.deleted);
}

export function visibleEntries(entries = []) {
  return entries.filter(entry => !entry.deleted);
}

export function entriesForTrip(entries, tripId) {
  return visibleEntries(entries)
    .filter(entry => entry.tripId === String(tripId))
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
}

export function tripEntryCounts(entries, tripId) {
  const count = entriesForTrip(entries, tripId).length;
  return {
    total: count,
    journals: count
  };
}

export function daysBetween(startIso, endIso) {
  const start = parseDateOnly(startIso);
  const end = parseDateOnly(endIso);
  const days = Math.round((end - start) / 86400000) + 1;
  return Math.max(1, days);
}

export function isTripActive(trip, now = new Date()) {
  const today = parseDateOnly(toDateInputValue(now));
  return parseDateOnly(trip.startIso) <= today && parseDateOnly(trip.endIso) >= today;
}

export function isTripPast(trip, now = new Date()) {
  const today = parseDateOnly(toDateInputValue(now));
  return parseDateOnly(trip.endIso) < today;
}

export function parseCitiesInput(value) {
  return normalizeCities(String(value || "").split(","));
}

export function citiesToInput(cities = []) {
  return normalizeCities(cities).join(", ");
}

export function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toDateTimeInputValue(iso) {
  const date = new Date(iso || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function fromDateTimeInputValue(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function parseDateOnly(iso) {
  const value = validDateOnly(iso) || todayIso();
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function normalizeCities(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(raw
    .map(city => cleanSingleLine(city))
    .filter(Boolean)));
}

function validDateOnly(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? "" : text;
}

function validDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function cleanSingleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function geoNumberOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeGeotagStatus(value) {
  const status = String(value || "").trim();
  return ["ready", "denied", "unavailable", "error", "skipped"].includes(status) ? status : "";
}
