import test from "node:test";
import assert from "node:assert/strict";

import { loadAppState, SCHEMA_VERSION, STATE_STORAGE_KEY } from "../app/storage.js";

function createLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

test("loadAppState migrates legacy records and seeds queued mutations", t => {
  const localStorage = createLocalStorage();
  globalThis.localStorage = localStorage;
  t.after(() => {
    delete globalThis.localStorage;
  });

  localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    trips: [
      {
        id: "trip-1",
        title: "Road trip",
        startIso: "2026-04-01",
        endIso: "2026-04-05"
      }
    ],
    entries: [
      {
        id: "entry-1",
        tripId: "trip-1",
        body: "First morning in town.",
        timestamp: "2026-04-02T08:30:00.000Z"
      }
    ]
  }));

  const state = loadAppState();
  const persisted = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY));

  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.equal(state.trips.length, 1);
  assert.equal(state.entries.length, 1);
  assert.equal(state.profileSync.mutationQueue.length, 2);
  assert.equal(typeof state.deviceId, "string");
  assert.equal(typeof state.profile?.id, "string");
  assert.equal(persisted.schemaVersion, SCHEMA_VERSION);
});

test("loadAppState normalizes v2 state into shared-trip-ready state", t => {
  const localStorage = createLocalStorage();
  globalThis.localStorage = localStorage;
  t.after(() => {
    delete globalThis.localStorage;
  });

  localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
    schemaVersion: 2,
    deviceId: "device-1",
    profile: { id: "profile-1", code: "ABCD1234" },
    hlc: { wallTime: 10, counter: 1 },
    trips: [{ id: "trip-1", title: "Road trip", startIso: "2026-04-01", endIso: "2026-04-05" }],
    entries: [{ id: "entry-1", tripId: "trip-1", body: "Morning", timestamp: "2026-04-02T08:30:00.000Z" }],
    tripClocks: {},
    entryClocks: {},
    profileSync: { mutationQueue: [], lastSyncTimestamp: "0000000000010:0001:device-1" }
  }));

  const state = loadAppState();
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.equal(state.profile.id, "profile-1");
  assert.equal(state.profile.name, "");
  assert.equal(state.trips[0].ownerProfileId, "profile-1");
  assert.equal(state.entries[0].authorProfileId, "profile-1");
  assert.deepEqual(state.comments, []);
  assert.deepEqual(state.commentClocks, {});
  assert.deepEqual(state.profileStateClocks, {});
  assert.equal(state.activitySeenAt, "");
  assert.deepEqual(state.tripActivitySeenAt, {});
  assert.deepEqual(state.sharedTripSync, {});
});
