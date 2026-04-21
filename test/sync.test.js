import assert from "node:assert/strict";
import test from "node:test";

import { PassageSync } from "../app/sync.js";
import { createInitialState } from "../app/storage.js";

test("sync confirmation removes queued mutations and stores high watermark", () => {
  const state = createInitialState();
  state.profileSync.mutationQueue = [
    queued("m-1", "0000000000100:0000:device-a"),
    queued("m-2", "0000000000101:0000:device-a")
  ];

  let saved = false;
  const sync = new PassageSync({
    code: "ABCD1234",
    state,
    save() {
      saved = true;
    }
  });

  sync.confirm(["m-1"], "0000000000100:0000:device-a", false);

  assert.equal(saved, true);
  assert.deepEqual(state.profileSync.mutationQueue.map(mutation => mutation.id), ["m-2"]);
  assert.equal(state.profileSync.lastSyncTimestamp, "0000000000100:0000:device-a");
});

function queued(id, timestamp) {
  return {
    id,
    entityType: "trip",
    entityId: "trip-1",
    field: "title",
    value: "Trip",
    timestamp,
    deviceId: "device-a",
    profileId: "profile-1"
  };
}
