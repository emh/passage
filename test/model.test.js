import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMutation,
  createComment,
  isTripSharedByOtherProfile,
  normalizeEntry,
  visibleComments
} from "../app/model.js";
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

test("comment mutations create and delete social records", () => {
  const state = createInitialState();
  const entry = { id: "entry-1", tripId: "trip-1" };
  const profile = { id: "profile-1", name: "Evan" };
  const comment = createComment(entry, profile, "Looks excellent.");

  applyMutation(state, {
    id: "m-comment-create",
    entityType: "comment",
    entityId: comment.id,
    field: "_create",
    value: comment,
    timestamp: "0000000000100:0000:device-a"
  });

  assert.equal(visibleComments(state.comments).length, 1);
  assert.equal(state.comments[0].body, "Looks excellent.");

  applyMutation(state, {
    id: "m-comment-delete",
    entityType: "comment",
    entityId: comment.id,
    field: "_delete",
    value: true,
    timestamp: "0000000000200:0000:device-a"
  });

  assert.equal(visibleComments(state.comments).length, 0);
});

test("profile state mutations update activity seen timestamp", () => {
  const state = createInitialState();

  applyMutation(state, {
    id: "m-profile-state",
    entityType: "profileState",
    entityId: state.profile.id,
    field: "activitySeenAt",
    value: "2026-04-21T12:00:00.000Z",
    timestamp: "0000000000100:0000:device-a"
  });

  assert.equal(state.activitySeenAt, "2026-04-21T12:00:00.000Z");
});

test("entries keep legacy body text as description and normalize photo metadata", () => {
  const entry = normalizeEntry({
    id: "entry-1",
    tripId: "trip-1",
    body: "First morning in town.",
    url: "example.com/path",
    photoAssetId: "photo-1",
    photoMime: "image/jpeg",
    photoWidth: 1600,
    photoHeight: 900,
    photoSize: 123456
  });

  assert.equal(entry.type, "entry");
  assert.equal(entry.description, "First morning in town.");
  assert.equal(entry.body, "First morning in town.");
  assert.equal(entry.url, "https://example.com/path");
  assert.equal(entry.photoAssetId, "photo-1");
  assert.equal(entry.photoWidth, 1600);
});

test("shared trip ownership identifies trips owned by another profile", () => {
  assert.equal(isTripSharedByOtherProfile({
    sharedCode: "ABCD1234",
    ownerProfileId: "profile-owner",
    ownerName: "Avery"
  }, {
    id: "profile-viewer",
    name: "Evan"
  }), true);

  assert.equal(isTripSharedByOtherProfile({
    sharedCode: "ABCD1234",
    ownerProfileId: "profile-viewer",
    ownerName: "Evan"
  }, {
    id: "profile-viewer",
    name: "Evan"
  }), false);

  assert.equal(isTripSharedByOtherProfile({
    sharedCode: "",
    ownerProfileId: "profile-owner",
    ownerName: "Avery"
  }, {
    id: "profile-viewer",
    name: "Evan"
  }), false);
});
