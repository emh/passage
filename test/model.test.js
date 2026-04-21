import test from "node:test";
import assert from "node:assert/strict";

import { applyMutation } from "../app/model.js";
import { createInitialState } from "../app/storage.js";

test("trip title keeps the newest mutation", () => {
  const state = createInitialState();

  applyMutation(state, {
    id: "m-trip-create",
    entityType: "trip",
    entityId: "trip-1",
    field: "_create",
    value: {
      id: "trip-1",
      title: "Spring drive",
      startIso: "2026-04-01",
      endIso: "2026-04-04"
    },
    timestamp: "0000000000100:0000:device-a"
  });

  applyMutation(state, {
    id: "m-trip-newer",
    entityType: "trip",
    entityId: "trip-1",
    field: "title",
    value: "Spring coast drive",
    timestamp: "0000000000300:0000:device-a"
  });

  applyMutation(state, {
    id: "m-trip-older",
    entityType: "trip",
    entityId: "trip-1",
    field: "title",
    value: "Old title",
    timestamp: "0000000000200:0000:device-a"
  });

  assert.equal(state.trips.length, 1);
  assert.equal(state.trips[0].title, "Spring coast drive");
});

test("entry create and delete mutations update the entry record", () => {
  const state = createInitialState();

  applyMutation(state, {
    id: "m-entry-create",
    entityType: "entry",
    entityId: "entry-1",
    field: "_create",
    value: {
      id: "entry-1",
      tripId: "trip-1",
      body: "Arrived before sunset.",
      timestamp: "2026-04-02T19:00:00.000Z",
      lat: 49.2827,
      lng: -123.1207,
      geotagStatus: "ready"
    },
    timestamp: "0000000000100:0000:device-a"
  });

  applyMutation(state, {
    id: "m-entry-delete",
    entityType: "entry",
    entityId: "entry-1",
    field: "_delete",
    value: true,
    timestamp: "0000000000200:0000:device-a"
  });

  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].tripId, "trip-1");
  assert.equal(state.entries[0].geotagStatus, "ready");
  assert.equal(state.entries[0].deleted, true);
});
