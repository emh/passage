import {
  applyMutation,
  createDeviceId,
  createMutation,
  createProfile,
  normalizeEntry,
  normalizeProfile,
  normalizeTrip
} from "./model.js";

export const STATE_STORAGE_KEY = "passage_v1";
export const SCHEMA_VERSION = 2;

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: createDeviceId(),
    profile: createProfile(),
    hlc: { wallTime: 0, counter: 0 },
    trips: [],
    entries: [],
    tripClocks: {},
    entryClocks: {},
    profileSync: createSyncState()
  };
}

export function loadAppState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (!raw) return createInitialState();

    const data = JSON.parse(raw);
    if (data?.schemaVersion === SCHEMA_VERSION) {
      return normalizeStoredState(data);
    }

    const migrated = migrateLegacyState(data);
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(serializeState(migrated)));
    return migrated;
  } catch {
    // Fall through to a fresh state.
  }

  return createInitialState();
}

export function saveAppState(state) {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(serializeState(state)));
  } catch {
    // Local storage can fail in private windows or under quota pressure.
  }
}

export function normalizeStoredState(data = {}) {
  return {
    ...createInitialState(),
    schemaVersion: SCHEMA_VERSION,
    deviceId: typeof data.deviceId === "string" && data.deviceId.trim() ? data.deviceId.trim() : createDeviceId(),
    profile: normalizeProfile(data.profile) || createProfile(),
    hlc: normalizeClock(data.hlc),
    trips: Array.isArray(data.trips) ? data.trips.map(normalizeTrip) : [],
    entries: Array.isArray(data.entries)
      ? data.entries.map(normalizeEntry).filter(entry => entry.tripId)
      : [],
    tripClocks: plainObject(data.tripClocks),
    entryClocks: plainObject(data.entryClocks),
    profileSync: normalizeSyncState(data.profileSync)
  };
}

export function loadSettings() {
  return {
    syncBaseUrl: getConfiguredSyncBaseUrl() || getDefaultSyncBaseUrl()
  };
}

function serializeState(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: state.deviceId,
    profile: state.profile || null,
    hlc: normalizeClock(state.hlc),
    trips: state.trips || [],
    entries: state.entries || [],
    tripClocks: state.tripClocks || {},
    entryClocks: state.entryClocks || {},
    profileSync: normalizeSyncState(state.profileSync)
  };
}

function migrateLegacyState(data = {}) {
  const state = createInitialState();
  const trips = Array.isArray(data.trips) ? data.trips.map(normalizeTrip) : [];
  const entries = Array.isArray(data.entries)
    ? data.entries.map(normalizeEntry).filter(entry => entry.tripId)
    : [];

  for (const trip of trips) {
    const mutation = createMutation(state, "trip", trip.id, "_create", trip);
    applyMutation(state, mutation);
    state.profileSync.mutationQueue.push(mutation);
  }

  for (const entry of entries) {
    const mutation = createMutation(state, "entry", entry.id, "_create", entry);
    applyMutation(state, mutation);
    state.profileSync.mutationQueue.push(mutation);
  }

  return state;
}

function createSyncState(input = {}) {
  return {
    mutationQueue: Array.isArray(input.mutationQueue) ? input.mutationQueue.filter(isQueuedMutation) : [],
    lastSyncTimestamp: typeof input.lastSyncTimestamp === "string" ? input.lastSyncTimestamp : ""
  };
}

function normalizeSyncState(input = {}) {
  return createSyncState(input);
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? clock.wallTime : 0,
    counter: Number.isFinite(clock?.counter) ? clock.counter : 0
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getConfiguredSyncBaseUrl() {
  const value = globalThis.PASSAGE_CONFIG?.syncBaseUrl;
  if (typeof value !== "string") return "";
  if (value.includes("YOUR_")) return "";
  return value.trim().replace(/\/+$/, "");
}

function getDefaultSyncBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || host === "localhost") {
    return "http://localhost:8796";
  }

  if (host === "127.0.0.1") {
    return "http://127.0.0.1:8796";
  }

  return "";
}

function isQueuedMutation(mutation) {
  return Boolean(
    mutation &&
    ["trip", "entry"].includes(mutation.entityType) &&
    typeof mutation.entityId === "string" &&
    typeof mutation.field === "string" &&
    typeof mutation.timestamp === "string"
  );
}
