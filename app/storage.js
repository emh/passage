import {
  applyMutation,
  createDeviceId,
  createMutation,
  createProfile,
  ENTITY_TYPES,
  normalizeComment,
  normalizeEntry,
  normalizeProfile,
  normalizeTrip
} from "./model.js";

export const STATE_STORAGE_KEY = "passage_v1";
export const SCHEMA_VERSION = 5;

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: createDeviceId(),
    profile: createProfile(),
    hlc: { wallTime: 0, counter: 0 },
    trips: [],
    entries: [],
    comments: [],
    tripClocks: {},
    entryClocks: {},
    commentClocks: {},
    profileStateClocks: {},
    activitySeenAt: "",
    tripActivitySeenAt: {},
    locationPermissionAskedAt: "",
    locationEntryPermissionAskedAt: "",
    profileSync: createSyncState(),
    sharedTripSync: {}
  };
}

export function loadAppState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (!raw) return createInitialState();

    const data = JSON.parse(raw);
    if (Number(data?.schemaVersion) >= 2) {
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
  const profile = normalizeProfile(data.profile) || createProfile();
  return {
    ...createInitialState(),
    schemaVersion: SCHEMA_VERSION,
    deviceId: typeof data.deviceId === "string" && data.deviceId.trim() ? data.deviceId.trim() : createDeviceId(),
    profile,
    hlc: normalizeClock(data.hlc),
    trips: Array.isArray(data.trips)
      ? data.trips.map(trip => normalizeTrip({
        ...trip,
        ownerProfileId: trip?.ownerProfileId || profile.id,
        ownerName: trip?.ownerName || profile.name || ""
      }))
      : [],
    entries: Array.isArray(data.entries)
      ? data.entries
        .map(entry => normalizeEntry({
          ...entry,
          authorProfileId: entry?.authorProfileId || profile.id,
          authorName: entry?.authorName || profile.name || ""
        }))
        .filter(entry => entry.tripId)
      : [],
    comments: Array.isArray(data.comments)
      ? data.comments
        .map(comment => normalizeComment({
          ...comment,
          authorProfileId: comment?.authorProfileId || profile.id,
          authorName: comment?.authorName || profile.name || ""
        }))
        .filter(comment => comment.entryId && comment.tripId)
      : [],
    tripClocks: plainObject(data.tripClocks),
    entryClocks: plainObject(data.entryClocks),
    commentClocks: plainObject(data.commentClocks),
    profileStateClocks: plainObject(data.profileStateClocks),
    activitySeenAt: typeof data.activitySeenAt === "string" ? data.activitySeenAt : "",
    tripActivitySeenAt: normalizeSeenAtMap(data.tripActivitySeenAt),
    locationPermissionAskedAt: typeof data.locationPermissionAskedAt === "string" ? data.locationPermissionAskedAt : "",
    locationEntryPermissionAskedAt: typeof data.locationEntryPermissionAskedAt === "string" ? data.locationEntryPermissionAskedAt : "",
    profileSync: normalizeSyncState(data.profileSync),
    sharedTripSync: normalizeSharedTripSync(data.sharedTripSync)
  };
}

export function ensureSharedTripSyncState(state, code, tripId = "") {
  const normalized = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalized) return createSyncState({ tripId });
  state.sharedTripSync ||= {};
  state.sharedTripSync[normalized] = normalizeSyncState({
    ...state.sharedTripSync[normalized],
    tripId: tripId || state.sharedTripSync[normalized]?.tripId || ""
  });
  return state.sharedTripSync[normalized];
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
    comments: state.comments || [],
    tripClocks: state.tripClocks || {},
    entryClocks: state.entryClocks || {},
    commentClocks: state.commentClocks || {},
    profileStateClocks: state.profileStateClocks || {},
    activitySeenAt: typeof state.activitySeenAt === "string" ? state.activitySeenAt : "",
    tripActivitySeenAt: normalizeSeenAtMap(state.tripActivitySeenAt),
    locationPermissionAskedAt: typeof state.locationPermissionAskedAt === "string" ? state.locationPermissionAskedAt : "",
    locationEntryPermissionAskedAt: typeof state.locationEntryPermissionAskedAt === "string" ? state.locationEntryPermissionAskedAt : "",
    profileSync: normalizeSyncState(state.profileSync),
    sharedTripSync: normalizeSharedTripSync(state.sharedTripSync)
  };
}

function migrateLegacyState(data = {}) {
  const state = createInitialState();
  const trips = Array.isArray(data.trips) ? data.trips.map(normalizeTrip) : [];
  const entries = Array.isArray(data.entries)
    ? data.entries.map(normalizeEntry).filter(entry => entry.tripId)
    : [];

  for (const trip of trips) {
    const mutation = createMutation(state, "trip", trip.id, "_create", {
      ...trip,
      ownerProfileId: trip.ownerProfileId || state.profile.id
    });
    applyMutation(state, mutation);
    state.profileSync.mutationQueue.push(mutation);
  }

  for (const entry of entries) {
    const mutation = createMutation(state, "entry", entry.id, "_create", {
      ...entry,
      authorProfileId: entry.authorProfileId || state.profile.id
    });
    applyMutation(state, mutation);
    state.profileSync.mutationQueue.push(mutation);
  }

  return state;
}

function createSyncState(input = {}) {
  return {
    mutationQueue: Array.isArray(input.mutationQueue) ? input.mutationQueue.filter(isQueuedMutation) : [],
    lastSyncTimestamp: typeof input.lastSyncTimestamp === "string" ? input.lastSyncTimestamp : "",
    tripId: typeof input.tripId === "string" ? input.tripId : ""
  };
}

function normalizeSyncState(input = {}) {
  return createSyncState(input);
}

function normalizeSharedTripSync(input) {
  const result = {};
  if (!input || typeof input !== "object") return result;

  for (const [code, syncState] of Object.entries(input)) {
    const normalized = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalized) continue;
    result[normalized] = normalizeSyncState(syncState);
  }

  return result;
}

function normalizeSeenAtMap(input) {
  const result = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;

  for (const [tripId, seenAt] of Object.entries(input)) {
    const id = String(tripId || "").trim();
    const value = typeof seenAt === "string" ? seenAt : "";
    if (id && value) result[id] = value;
  }

  return result;
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

  if (isPrivateNetworkHost(host)) {
    return `${protocol || "http:"}//${host}:8796`;
  }

  return "";
}

function isPrivateNetworkHost(host) {
  if (host.endsWith(".local")) return true;

  const parts = host.split(".").map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
}

function isQueuedMutation(mutation) {
  return Boolean(
    mutation &&
    ENTITY_TYPES.includes(mutation.entityType) &&
    typeof mutation.entityId === "string" &&
    typeof mutation.field === "string" &&
    typeof mutation.timestamp === "string"
  );
}
