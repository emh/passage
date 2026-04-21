import assert from "node:assert/strict";
import test from "node:test";

import { PassageSync, updateRemoteProfile } from "../app/sync.js";
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

test("profile updates post to the profile metadata endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;

  globalThis.fetch = async (url, options = {}) => {
    request = { url: String(url), options };
    return {
      ok: true,
      async json() {
        return { ok: true };
      }
    };
  };

  try {
    await updateRemoteProfile(
      { id: "profile-1", name: "Evan", code: "ab12" },
      { syncBaseUrl: "http://127.0.0.1:8796" }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.url, "http://127.0.0.1:8796/api/profiles/AB12/profile");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(request.options.body).profile.name, "Evan");
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
