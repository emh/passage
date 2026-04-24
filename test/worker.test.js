import assert from "node:assert/strict";
import test from "node:test";

import {
  buildShareMetadata,
  filterTripStateForViewer,
  materializeMutations,
  normalizeExternalUrl,
  normalizeProfileRoom,
  normalizeTripRoom,
  parseAssetRoute,
  parseRoomRoute,
  parseShareRoute,
  parseSocialMetadata,
  validateMutation
} from "../workers/sync/src/index.js";

test("room routes extract profile code and action", () => {
  assert.deepEqual(parseRoomRoute("/api/profiles/ab12/sync"), { kind: "profiles", code: "AB12", action: "sync" });
  assert.deepEqual(parseRoomRoute("/api/profiles/CD34"), { kind: "profiles", code: "CD34", action: "" });
  assert.deepEqual(parseRoomRoute("/api/profiles/CD34/profile"), { kind: "profiles", code: "CD34", action: "profile" });
  assert.deepEqual(parseRoomRoute("/api/trips/TRIP12/state"), { kind: "trips", code: "TRIP12", action: "state" });
  assert.equal(parseRoomRoute("/api/lists/AB12"), null);
});

test("asset routes extract photo asset ids", () => {
  assert.deepEqual(parseAssetRoute("/api/assets/photo-123_ABC.jpg"), { assetId: "photo-123_ABC.jpg" });
  assert.equal(parseAssetRoute("/api/profiles/AB12"), null);
});

test("share routes extract trip, collaborator, and entry targets", () => {
  assert.deepEqual(parseShareRoute("/share/trips/ab12"), {
    code: "AB12",
    access: "viewer",
    entryId: "",
    kind: "trip"
  });
  assert.deepEqual(parseShareRoute("/share/trips/ab12/collab"), {
    code: "AB12",
    access: "collaborator",
    entryId: "",
    kind: "trip"
  });
  assert.deepEqual(parseShareRoute("/share/trips/trip12/entries/entry-1"), {
    code: "TRIP12",
    access: "viewer",
    entryId: "entry-1",
    kind: "entry"
  });
});

test("URL metadata helpers normalize public URLs and parse social tags", () => {
  assert.equal(normalizeExternalUrl("example.com/place#section"), "https://example.com/place");
  assert.throws(() => normalizeExternalUrl("http://127.0.0.1/private"), /not allowed/i);

  const metadata = parseSocialMetadata(`
    <html>
      <head>
        <meta property="og:title" content="Cafe Example">
        <meta name="description" content="A tiny coffee bar">
        <meta property="og:image" content="/card.jpg">
      </head>
    </html>
  `, "https://example.com/places/cafe");

  assert.deepEqual(metadata, {
    title: "Cafe Example",
    description: "A tiny coffee bar",
    imageUrl: "https://example.com/card.jpg"
  });
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

test("share metadata uses trip details and prefers uploaded entry photos", () => {
  const snapshot = {
    trip: {
      id: "trip-1",
      title: "Todos Santos",
      ownerName: "Evan"
    },
    entries: [
      {
        id: "entry-1",
        tripId: "trip-1",
        title: "Sunrise surf",
        visibility: "public",
        timestamp: "2026-04-01T08:00:00.000Z",
        photoAssetId: "photo-1",
        photoUploadedAt: "2026-04-01T08:05:00.000Z"
      },
      {
        id: "entry-2",
        tripId: "trip-1",
        title: "Later lunch",
        visibility: "public",
        timestamp: "2026-04-01T12:00:00.000Z",
        photoAssetId: "photo-2",
        photoUploadedAt: "2026-04-01T12:05:00.000Z"
      }
    ]
  };

  const tripMetadata = buildShareMetadata(
    snapshot,
    { code: "TRIP12", access: "viewer", entryId: "", kind: "trip" },
    "https://passage-sync.example/share/trips/TRIP12"
  );
  assert.equal(tripMetadata.title, "Follow along on Evan's trip: Todos Santos.");
  assert.equal(tripMetadata.description, "Open the full trip in Passage.");
  assert.equal(tripMetadata.imageUrl, "https://passage-sync.example/api/assets/photo-1");

  const entryMetadata = buildShareMetadata(
    snapshot,
    { code: "TRIP12", access: "viewer", entryId: "entry-2", kind: "entry" },
    "https://passage-sync.example/share/trips/TRIP12/entries/entry-2"
  );
  assert.equal(entryMetadata.title, "Later lunch");
  assert.equal(entryMetadata.description, "From Evan's trip: Todos Santos.");
  assert.equal(entryMetadata.imageUrl, "https://passage-sync.example/api/assets/photo-2");
});

test("trip rooms accept and materialize collaborator updates", () => {
  const room = normalizeTripRoom({
    code: "trip-12",
    trip: { id: "trip-1", title: "Road trip", ownerProfileId: "profile-1", ownerName: "Evan" }
  });
  const collaborator = {
    profileId: "profile-2",
    name: "Avery",
    joinedAt: "2026-04-21T12:00:00.000Z"
  };
  const createTrip = mutation({
    id: "trip-create",
    entityType: "trip",
    entityId: "trip-1",
    field: "_create",
    timestamp: hlc(100),
    value: { id: "trip-1", title: "Road trip", startIso: "2026-04-01", endIso: "2026-04-03" }
  });
  const addCollaborator = mutation({
    id: "trip-collaborator",
    entityType: "trip",
    entityId: "trip-1",
    field: "collaborators",
    timestamp: hlc(101),
    profileId: "profile-2",
    value: [collaborator]
  });

  assert.equal(validateMutation(addCollaborator, room).field, "collaborators");

  const visible = materializeMutations([createTrip, addCollaborator], room);
  assert.deepEqual(visible.trips[0].collaborators, [collaborator]);
});

test("trip room snapshots filter entry visibility for viewers and collaborators", () => {
  const room = normalizeTripRoom({
    code: "trip-12",
    trip: { id: "trip-1", title: "Road trip", ownerProfileId: "owner-1", ownerName: "Owner" }
  });
  const createTrip = mutation({
    id: "trip-create",
    entityType: "trip",
    entityId: "trip-1",
    field: "_create",
    timestamp: hlc(100),
    value: {
      id: "trip-1",
      title: "Road trip",
      startIso: "2026-04-01",
      endIso: "2026-04-03",
      collaborators: [{ profileId: "collab-1", name: "Collab" }]
    }
  });
  const entries = [
    mutation({
      id: "entry-public",
      entityType: "entry",
      entityId: "entry-public",
      field: "_create",
      timestamp: hlc(101),
      value: {
        id: "entry-public",
        tripId: "trip-1",
        body: "Visible to everyone",
        visibility: "public",
        authorProfileId: "author-1"
      }
    }),
    mutation({
      id: "entry-collab",
      entityType: "entry",
      entityId: "entry-collab",
      field: "_create",
      timestamp: hlc(102),
      value: {
        id: "entry-collab",
        tripId: "trip-1",
        body: "Visible to collaborators",
        visibility: "collaborators",
        authorProfileId: "author-1"
      }
    }),
    mutation({
      id: "entry-private",
      entityType: "entry",
      entityId: "entry-private",
      field: "_create",
      timestamp: hlc(103),
      value: {
        id: "entry-private",
        tripId: "trip-1",
        body: "Visible only to the author",
        visibility: "private",
        authorProfileId: "author-1"
      }
    })
  ];
  const materialized = materializeMutations([createTrip, ...entries], room);

  const viewerState = filterTripStateForViewer(materialized, { profileId: "viewer-1" });
  assert.deepEqual(viewerState.entries.map(entry => entry.id), ["entry-public"]);

  const collaboratorState = filterTripStateForViewer(materialized, { profileId: "collab-1" });
  assert.deepEqual(collaboratorState.entries.map(entry => entry.id), ["entry-public", "entry-collab"]);

  const authorState = filterTripStateForViewer(materialized, { profileId: "author-1" });
  assert.deepEqual(authorState.entries.map(entry => entry.id), ["entry-public", "entry-collab", "entry-private"]);
});

test("worker validation accepts trip, entry, comment, and profile state mutations for the room profile", () => {
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

  const comment = validateMutation(mutation({
    entityType: "comment",
    entityId: "comment-1",
    field: "_create",
    value: { id: "comment-1", entryId: "entry-1", tripId: "trip-1", body: "Great spot." }
  }), room);

  const profileState = validateMutation(mutation({
    entityType: "profileState",
    entityId: "profile-1",
    field: "activitySeenAt",
    value: "2026-04-21T12:00:00.000Z"
  }), room);
  const tripProfileState = validateMutation(mutation({
    entityType: "profileState",
    entityId: "profile-1",
    field: "tripActivitySeenAt:trip-1",
    value: "2026-04-21T13:00:00.000Z"
  }), room);

  assert.equal(trip.value.title, "Road trip");
  assert.equal(entry.value.tripId, "trip-1");
  assert.equal(comment.value.body, "Great spot.");
  assert.equal(profileState.value, "2026-04-21T12:00:00.000Z");
  assert.equal(tripProfileState.field, "tripActivitySeenAt:trip-1");
});

test("worker materialization applies entry updates and comments, ignores legacy reactions, and filters deleted records", () => {
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
  const createComment = mutation({
    id: "comment-create",
    entityType: "comment",
    entityId: "comment-1",
    field: "_create",
    timestamp: hlc(103),
    value: { id: "comment-1", entryId: "entry-1", tripId: "trip-1", body: "Great spot." }
  });
  const legacyReaction = mutation({
    id: "reaction-create",
    entityType: "reaction",
    entityId: "reaction-1",
    field: "_create",
    timestamp: hlc(104),
    value: { id: "reaction-1", entryId: "entry-1", tripId: "trip-1", kind: "like" }
  });
  const deleteTrip = mutation({
    id: "trip-delete",
    entityType: "trip",
    entityId: "trip-1",
    field: "_delete",
    timestamp: hlc(105),
    value: true
  });

  const visible = materializeMutations([createTrip, createEntry, updateEntry, createComment, legacyReaction], room);
  assert.equal(visible.trips.length, 1);
  assert.equal(visible.entries[0].body, "Second draft.");
  assert.equal(visible.comments[0].body, "Great spot.");
  assert.equal("reactions" in visible, false);

  const deleted = materializeMutations([createTrip, createEntry, updateEntry, createComment, legacyReaction, deleteTrip], room);
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
