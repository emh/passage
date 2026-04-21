import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeMutations,
  normalizeProfileRoom,
  normalizeTripRoom,
  parseRoomRoute,
  validateMutation
} from "../workers/sync/src/index.js";

test("room routes extract profile code and action", () => {
  assert.deepEqual(parseRoomRoute("/api/profiles/ab12/sync"), { kind: "profiles", code: "AB12", action: "sync" });
  assert.deepEqual(parseRoomRoute("/api/profiles/CD34"), { kind: "profiles", code: "CD34", action: "" });
  assert.deepEqual(parseRoomRoute("/api/profiles/CD34/profile"), { kind: "profiles", code: "CD34", action: "profile" });
  assert.deepEqual(parseRoomRoute("/api/trips/TRIP12/state"), { kind: "trips", code: "TRIP12", action: "state" });
  assert.equal(parseRoomRoute("/api/lists/AB12"), null);
});

test("profile rooms normalize hidden profile metadata", () => {
  const room = normalizeProfileRoom({
    code: "ab-12",
    profile: { id: "profile-1" }
  });

  assert.equal(room.code, "AB12");
  assert.equal(room.profile.id, "profile-1");
  assert.equal(room.profile.code, "AB12");
});

test("trip rooms normalize share metadata and restrict to one trip", () => {
  const room = normalizeTripRoom({
    code: "trip-12",
    trip: { id: "trip-1", title: "Road trip", ownerProfileId: "profile-1", ownerName: "Evan" }
  });

  assert.equal(room.code, "TRIP12");
  assert.equal(room.tripId, "trip-1");
  assert.throws(() => validateMutation(mutation({
    entityType: "trip",
    entityId: "trip-2",
    field: "_create",
    value: { id: "trip-2", title: "Wrong trip", startIso: "2026-04-01", endIso: "2026-04-03" }
  }), room), /Invalid trip/);
});

test("worker validation accepts trip and entry mutations for the room profile", () => {
  const room = normalizeProfileRoom({
    code: "pass1234",
    profile: { id: "profile-1" }
  });

  const trip = validateMutation(mutation({
    entityType: "trip",
    entityId: "trip-1",
    field: "_create",
    value: { id: "trip-1", title: "Road trip", startIso: "2026-04-01", endIso: "2026-04-03" }
  }), room);

  const entry = validateMutation(mutation({
    entityType: "entry",
    entityId: "entry-1",
    field: "_create",
    value: { id: "entry-1", tripId: "trip-1", body: "First sunset.", timestamp: "2026-04-01T19:00:00.000Z" }
  }), room);

  assert.equal(trip.value.title, "Road trip");
  assert.equal(entry.value.tripId, "trip-1");
});

test("worker materialization applies entry updates and filters deleted records", () => {
  const room = normalizeProfileRoom({
    code: "pass1234",
    profile: { id: "profile-1" }
  });

  const createTrip = mutation({
    id: "trip-create",
    entityType: "trip",
    entityId: "trip-1",
    field: "_create",
    timestamp: hlc(100),
    value: { id: "trip-1", title: "Road trip", startIso: "2026-04-01", endIso: "2026-04-03" }
  });
  const createEntry = mutation({
    id: "entry-create",
    entityType: "entry",
    entityId: "entry-1",
    field: "_create",
    timestamp: hlc(101),
    value: { id: "entry-1", tripId: "trip-1", body: "First sunset.", timestamp: "2026-04-01T19:00:00.000Z" }
  });
  const updateEntry = mutation({
    id: "entry-update",
    entityType: "entry",
    entityId: "entry-1",
    field: "body",
    timestamp: hlc(102),
    value: "Second draft."
  });
  const deleteTrip = mutation({
    id: "trip-delete",
    entityType: "trip",
    entityId: "trip-1",
    field: "_delete",
    timestamp: hlc(103),
    value: true
  });

  const visible = materializeMutations([createTrip, createEntry, updateEntry], room);
  assert.equal(visible.trips.length, 1);
  assert.equal(visible.entries[0].body, "Second draft.");

  const deleted = materializeMutations([createTrip, createEntry, updateEntry, deleteTrip], room);
  assert.equal(deleted.trips.length, 0);
});

function mutation(overrides) {
  return {
    id: "mutation",
    entityType: "trip",
    entityId: "trip-1",
    field: "title",
    value: "Trip",
    timestamp: hlc(100),
    deviceId: "device-a",
    profileId: "profile-1",
    ...overrides
  };
}

function hlc(wallTime, counter = 0, device = "device-a") {
  return `${String(wallTime).padStart(13, "0")}:${String(counter).padStart(4, "0")}:${device}`;
}
