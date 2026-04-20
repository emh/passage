import { normalizeEntry, normalizeTrip } from "./model.js";

export const STATE_STORAGE_KEY = "passage_v1";
export const SCHEMA_VERSION = 1;

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    trips: [],
    entries: []
  };
}

export function loadAppState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (raw) return normalizeStoredState(JSON.parse(raw));
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
    trips: Array.isArray(data.trips) ? data.trips.map(normalizeTrip) : [],
    entries: Array.isArray(data.entries)
      ? data.entries.map(normalizeEntry).filter(entry => entry.tripId)
      : []
  };
}

function serializeState(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    trips: state.trips || [],
    entries: state.entries || []
  };
}
