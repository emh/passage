import {
  applyMutation,
  COMMENT_FIELDS,
  compareHlc,
  ENTRY_FIELDS,
  ENTITY_TYPES,
  normalizeCode,
  normalizeComment,
  normalizeEntry,
  normalizeProfile,
  normalizeTrip,
  PROFILE_STATE_FIELDS,
  TRIP_FIELDS
} from "../../../app/model.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const INTERNAL_CREATE_HEADER = "X-Passage-Internal-Create";
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const LEGACY_ENTITY_TYPES = [...ENTITY_TYPES, "reaction"];

export class PassageProfileRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = this.initialize();
  }

  async initialize() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mutations (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.state.storage.sql.exec("CREATE INDEX IF NOT EXISTS mutations_timestamp_idx ON mutations(timestamp)");
  }

  async fetch(request) {
    await this.ready;
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const route = parseRoomRoute(url.pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    try {
      if (!route.action && request.method === "POST") {
        return this.createRoom(request, route, cors);
      }

      if (!route.action && request.method === "GET") {
        return json(await this.materializedPayload(await this.requireRoom()), 200, cors);
      }

      if (route.action === "sync" && request.method === "GET") {
        return this.handleWebSocket(request);
      }

      if (route.action === "sync" && request.method === "POST") {
        return this.handleHttpSync(request, cors);
      }

      if (route.action === "state" && request.method === "GET") {
        return json(await this.materializedPayload(await this.requireRoom()), 200, cors);
      }

      if (route.action === "profile" && request.method === "POST") {
        return this.updateProfile(request, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, error?.status || 400, cors);
    }
  }

  async createRoom(request, route, cors) {
    if (request.headers.get(INTERNAL_CREATE_HEADER) !== "1") {
      return json({ error: "Not found" }, 404, cors);
    }

    const existing = await this.getRoom();
    if (existing) return json({ error: "Invite code already exists" }, 409, cors);

    const body = await request.json();

    if (route.kind === "profiles") {
      const room = normalizeProfileRoom({ code: route.code, profile: body.profile });
      await this.saveRoom(room);
      const accepted = await this.acceptMutations(Array.isArray(body.mutations) ? body.mutations : [], room);
      const payload = await this.materializedPayload(room);
      return json({ ...payload, confirmedIds: accepted.map(mutation => mutation.id) }, 200, cors);
    }

    const room = normalizeTripRoom({ code: route.code, trip: body.trip });
    await this.saveRoom(room);
    const seed = createTripSeedMutations(body.trip, body.entries, body.comments, room);
    await this.insertMutations(seed);
    const payload = await this.materializedPayload(room);
    this.broadcast(null, { type: "mutations", items: seed, highWatermark: await this.highWatermark() });
    return json({ ...payload, confirmedIds: seed.map(mutation => mutation.id) }, 200, cors);
  }

  async handleWebSocket(request) {
    await this.requireRoom();

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleHttpSync(request, cors) {
    const room = await this.requireRoom();
    const body = await request.json();
    const accepted = await this.acceptMutations(Array.isArray(body.mutations) ? body.mutations : [], room);
    const materialized = room.type === "trip" ? materializeMutations(await this.listSince(""), room) : null;
    return json({
      room,
      code: room.code,
      profile: room.profile || null,
      trip: materialized?.trips[0] || null,
      entries: materialized?.entries || [],
      comments: materialized?.comments || [],
      mutations: await this.listSince(typeof body.since === "string" ? body.since : ""),
      confirmedIds: accepted.map(mutation => mutation.id),
      highWatermark: await this.highWatermark()
    }, 200, cors);
  }

  async webSocketMessage(socket, raw) {
    await this.ready;

    try {
      const room = await this.requireRoom();
      const message = parseSocketMessage(raw);

      if (message.type === "sync") {
        socket.send(JSON.stringify({ type: "room", room }));
        socket.send(JSON.stringify({
          type: "mutations",
          items: await this.listSince(typeof message.since === "string" ? message.since : ""),
          highWatermark: await this.highWatermark()
        }));
        return;
      }

      if (message.type === "push") {
        const accepted = await this.acceptMutations(Array.isArray(message.mutations) ? message.mutations : [], room);
        const highWatermark = await this.highWatermark();
        socket.send(JSON.stringify({
          type: "ack",
          confirmedIds: accepted.map(mutation => mutation.id),
          highWatermark
        }));

        if (accepted.length) {
          this.broadcast(socket, {
            type: "mutations",
            items: accepted,
            highWatermark
          });
        }
        return;
      }

      socket.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: messageFromError(error) }));
    }
  }

  webSocketClose() {}

  webSocketError() {}

  broadcast(sender, message) {
    const raw = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      if (socket !== sender) {
        try {
          socket.send(raw);
        } catch {
          // Ignore dead sockets.
        }
      }
    }
  }

  async acceptMutations(input, room) {
    const accepted = [];

    for (const candidate of input) {
      const mutation = validateMutation(candidate, room);
      const exists = [...this.state.storage.sql.exec("SELECT id FROM mutations WHERE id = ?", mutation.id)];
      if (exists.length) continue;

      this.state.storage.sql.exec(
        "INSERT INTO mutations (id, timestamp, json, created_at) VALUES (?, ?, ?, ?)",
        mutation.id,
        mutation.timestamp,
        JSON.stringify(mutation),
        Date.now()
      );
      accepted.push(mutation);
    }

    return accepted;
  }

  async insertMutations(mutations) {
    for (const mutation of mutations) {
      const exists = [...this.state.storage.sql.exec("SELECT id FROM mutations WHERE id = ?", mutation.id)];
      if (exists.length) continue;

      this.state.storage.sql.exec(
        "INSERT INTO mutations (id, timestamp, json, created_at) VALUES (?, ?, ?, ?)",
        mutation.id,
        mutation.timestamp,
        JSON.stringify(mutation),
        Date.now()
      );
    }
  }

  async listSince(since) {
    const query = since
      ? this.state.storage.sql.exec("SELECT json FROM mutations WHERE timestamp > ? ORDER BY timestamp ASC, id ASC", since)
      : this.state.storage.sql.exec("SELECT json FROM mutations ORDER BY timestamp ASC, id ASC");
    return [...query].map(row => JSON.parse(row.json));
  }

  async highWatermark() {
    const rows = [...this.state.storage.sql.exec("SELECT timestamp FROM mutations ORDER BY timestamp DESC LIMIT 1")];
    return rows[0]?.timestamp || "";
  }

  async materializedPayload(room) {
    const mutations = await this.listSince("");
    const state = materializeMutations(mutations, room);
    return room.type === "profile"
      ? {
        room,
        code: room.code,
        profile: room.profile,
        mutations,
        trips: state.trips,
        entries: state.entries,
        comments: state.comments,
        activitySeenAt: state.activitySeenAt || "",
        highWatermark: await this.highWatermark()
      }
      : {
        room,
        code: room.code,
        trip: state.trips[0] || null,
        entries: state.entries,
        comments: state.comments,
        mutations,
        highWatermark: await this.highWatermark()
      };
  }

  async getRoom() {
    return await this.state.storage.get("room") || null;
  }

  async requireRoom() {
    const room = await this.getRoom();
    if (!room) throw statusError("Room not found", 404);
    return room;
  }

  async saveRoom(room) {
    await this.state.storage.put("room", room);
  }

  async updateProfile(request, cors) {
    const room = await this.requireRoom();
    if (room.type !== "profile") return json({ error: "Not found" }, 404, cors);

    const body = await request.json();
    const nextRoom = normalizeProfileRoom({
      ...room,
      profile: {
        ...room.profile,
        ...(body?.profile || {})
      }
    });

    await this.saveRoom(nextRoom);
    this.broadcast(null, { type: "room", room: nextRoom });
    return json({
      room: nextRoom,
      code: nextRoom.code,
      profile: nextRoom.profile
    }, 200, cors);
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/profiles") {
      return createRoomWithFreshCode(request, env, cors, "profiles");
    }

    if (request.method === "POST" && url.pathname === "/api/trips") {
      return createRoomWithFreshCode(request, env, cors, "trips");
    }

    const assetRoute = parseAssetRoute(url.pathname);
    if (assetRoute) return handleAssetRequest(request, env, cors, assetRoute);

    const route = parseRoomRoute(url.pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    const id = env.PASSAGE_PROFILE_ROOM.idFromName(`${route.kind}:${route.code}`);
    const room = env.PASSAGE_PROFILE_ROOM.get(id);
    return room.fetch(request);
  }
};

async function createRoomWithFreshCode(request, env, cors, kind) {
  const body = await request.text();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generateInviteCode();
    const id = env.PASSAGE_PROFILE_ROOM.idFromName(`${kind}:${code}`);
    const room = env.PASSAGE_PROFILE_ROOM.get(id);
    const url = new URL(request.url);
    url.pathname = `/api/${kind}/${code}`;

    const response = await room.fetch(new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") || "application/json",
        "Origin": request.headers.get("Origin") || "",
        [INTERNAL_CREATE_HEADER]: "1"
      },
      body
    }));

    if (response.status !== 409) return response;
  }

  return json({ error: "Could not create invite code" }, 500, cors);
}

export function parseRoomRoute(pathname) {
  const match = /^\/api\/(profiles|trips)\/([A-Za-z0-9]+)(?:\/(sync|state|profile))?\/?$/.exec(pathname);
  if (!match) return null;
  return {
    kind: match[1],
    code: normalizeCode(match[2]),
    action: match[3] || ""
  };
}

export function parseAssetRoute(pathname) {
  const match = /^\/api\/assets\/([A-Za-z0-9._-]+)\/?$/.exec(pathname);
  if (!match) return null;
  return { assetId: match[1] };
}

async function handleAssetRequest(request, env, cors, route) {
  if (!env.PASSAGE_PHOTOS) {
    return json({ error: "Photo storage is not configured" }, 503, cors);
  }

  const key = photoAssetKey(route.assetId);
  if (request.method === "GET") {
    const object = await env.PASSAGE_PHOTOS.get(key);
    if (!object) return json({ error: "Photo not found" }, 404, cors);

    const headers = new Headers(cors);
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("ETag", object.httpEtag);
    return new Response(object.body, { status: 200, headers });
  }

  if (request.method === "PUT" || request.method === "POST") {
    const contentType = request.headers.get("Content-Type") || "application/octet-stream";
    if (!contentType.startsWith("image/")) return json({ error: "Expected an image" }, 415, cors);

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_PHOTO_BYTES) return json({ error: "Photo is too large" }, 413, cors);

    const uploadedAt = new Date().toISOString();
    await env.PASSAGE_PHOTOS.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { assetId: route.assetId, uploadedAt }
    });

    return json({
      assetId: route.assetId,
      size: bytes.byteLength,
      uploadedAt
    }, 200, cors);
  }

  return json({ error: "Not found" }, 404, cors);
}

function photoAssetKey(assetId) {
  return `photos/${String(assetId || "").trim()}`;
}

export function generateInviteCode(length = CODE_LENGTH) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export function normalizeProfileRoom(input = {}) {
  const code = normalizeCode(input.code);
  const profile = normalizeProfile({ ...input.profile, code });
  if (!code) throw new Error("Code is required");
  if (!profile) throw new Error("Profile is required");
  return {
    type: "profile",
    code,
    profile,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString()
  };
}

export function normalizeTripRoom(input = {}) {
  const code = normalizeCode(input.code);
  const trip = normalizeTrip({ ...input.trip, sharedCode: code });
  if (!code) throw new Error("Code is required");
  if (!trip.id) throw new Error("Trip id is required");
  return {
    type: "trip",
    code,
    tripId: trip.id,
    tripTitle: trip.title,
    ownerProfileId: trip.ownerProfileId,
    ownerName: trip.ownerName,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString()
  };
}

export function validateMutation(input, room) {
  if (!input || typeof input !== "object") throw new Error("Mutation must be an object");

  const mutation = {
    id: stringValue(input.id, "Mutation id"),
    entityType: stringValue(input.entityType, "Entity type"),
    entityId: stringValue(input.entityId, "Entity id"),
    field: stringValue(input.field, "Field"),
    value: input.value,
    timestamp: stringValue(input.timestamp, "Timestamp"),
    deviceId: stringValue(input.deviceId, "Device id"),
    profileId: String(input.profileId || "").trim()
  };

  if (!LEGACY_ENTITY_TYPES.includes(mutation.entityType)) throw new Error("Invalid entity type");
  if (!isHlc(mutation.timestamp)) throw new Error("Invalid timestamp");

  if (room.type === "profile" && room.profile?.id && mutation.profileId && mutation.profileId !== room.profile.id) {
    throw new Error("Invalid profile");
  }

  if (mutation.entityType === "trip") return validateTripMutation(mutation, room);
  if (mutation.entityType === "entry") return validateEntryMutation(mutation, room);
  if (mutation.entityType === "comment") return validateCommentMutation(mutation, room);
  if (mutation.entityType === "profileState") return validateProfileStateMutation(mutation, room);
  return validateLegacyReactionMutation(mutation, room);
}

export function materializeMutations(mutations, room) {
  const state = {
    deviceId: "server",
    profile: room.type === "profile" ? room.profile : null,
    hlc: { wallTime: 0, counter: 0 },
    trips: [],
    entries: [],
    comments: [],
    tripClocks: {},
    entryClocks: {},
    commentClocks: {},
    profileStateClocks: {},
    profileSync: { mutationQueue: [], lastSyncTimestamp: "" },
    sharedTripSync: {}
  };

  for (const mutation of mutations
    .map(item => validateMutation(item, room))
    .sort(compareMutation)) {
    applyMutation(state, mutation);
  }

  return {
    trips: state.trips.filter(trip => !trip.deleted),
    entries: state.entries.filter(entry => !entry.deleted),
    comments: state.comments.filter(comment => !comment.deleted)
  };
}

function validateTripMutation(mutation, room) {
  if (mutation.field === "_create") {
    const trip = normalizeTrip({ ...mutation.value, id: mutation.entityId });
    if (room.type === "trip" && trip.id !== room.tripId) throw new Error("Invalid trip");
    return { ...mutation, value: trip };
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!TRIP_FIELDS.includes(field)) throw new Error("Invalid trip field");
  if (room.type === "trip" && mutation.entityId !== room.tripId) throw new Error("Invalid trip");
  return mutation;
}

function validateEntryMutation(mutation, room) {
  if (mutation.field === "_create") {
    const entry = normalizeEntry({ ...mutation.value, id: mutation.entityId });
    if (!entry.tripId) throw new Error("Entry tripId is required");
    if (room.type === "trip" && entry.tripId !== room.tripId) throw new Error("Invalid entry");
    return { ...mutation, value: entry };
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!ENTRY_FIELDS.includes(field)) throw new Error("Invalid entry field");
  return mutation;
}

function validateCommentMutation(mutation, room) {
  if (mutation.field === "_create") {
    const comment = normalizeComment({ ...mutation.value, id: mutation.entityId });
    if (!comment.entryId) throw new Error("Comment entryId is required");
    if (!comment.tripId) throw new Error("Comment tripId is required");
    if (!comment.body) throw new Error("Comment body is required");
    if (room.type === "trip" && comment.tripId !== room.tripId) throw new Error("Invalid comment");
    return { ...mutation, value: comment };
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!COMMENT_FIELDS.includes(field)) throw new Error("Invalid comment field");
  return mutation;
}

function validateProfileStateMutation(mutation, room) {
  if (room.type !== "profile") throw new Error("Invalid profile state");
  if (room.profile?.id && mutation.entityId !== room.profile.id) throw new Error("Invalid profile state");
  if (!PROFILE_STATE_FIELDS.includes(mutation.field)) throw new Error("Invalid profile state field");
  return mutation;
}

function validateLegacyReactionMutation(mutation, room) {
  if (mutation.field === "_create") {
    const entryId = String(mutation.value?.entryId || "").trim();
    const tripId = String(mutation.value?.tripId || "").trim();
    if (!entryId) throw new Error("Reaction entryId is required");
    if (!tripId) throw new Error("Reaction tripId is required");
    if (room.type === "trip" && tripId !== room.tripId) throw new Error("Invalid reaction");
    return mutation;
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!["entryId", "tripId", "kind", "authorProfileId", "authorName", "dateCreated", "deleted"].includes(field)) {
    throw new Error("Invalid reaction field");
  }
  return mutation;
}

function createTripSeedMutations(rawTrip, rawEntries, rawComments, room) {
  const trip = normalizeTrip({ ...rawTrip, id: room.tripId, sharedCode: room.code });
  const entries = Array.isArray(rawEntries)
    ? rawEntries
      .map(entry => normalizeEntry({ ...entry, tripId: room.tripId }))
      .filter(entry => entry.tripId === room.tripId)
      .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp))
    : [];
  const entryIds = new Set(entries.map(entry => entry.id));
  const comments = Array.isArray(rawComments)
    ? rawComments
      .map(comment => normalizeComment({ ...comment, tripId: room.tripId }))
      .filter(comment => comment.tripId === room.tripId && entryIds.has(comment.entryId) && comment.body)
      .sort((left, right) => new Date(left.dateCreated) - new Date(right.dateCreated))
    : [];

  const wallTime = Date.now();
  const mutations = [
    serverMutation("trip", trip.id, "_create", trip, wallTime, 0, trip.ownerProfileId)
  ];

  for (let index = 0; index < entries.length; index += 1) {
    mutations.push(serverMutation("entry", entries[index].id, "_create", entries[index], wallTime, index + 1, entries[index].authorProfileId));
  }

  for (let index = 0; index < comments.length; index += 1) {
    mutations.push(serverMutation("comment", comments[index].id, "_create", comments[index], wallTime, entries.length + index + 1, comments[index].authorProfileId));
  }

  return mutations;
}

function serverMutation(entityType, entityId, field, value, wallTime, counter, profileId = "") {
  return {
    id: `server-${crypto.randomUUID()}`,
    entityType,
    entityId: String(entityId || ""),
    field,
    value,
    timestamp: serializeServerHlc(wallTime, counter),
    deviceId: "server",
    profileId: String(profileId || "").trim()
  };
}

function serializeServerHlc(wallTime, counter) {
  return `${String(Math.max(0, Number(wallTime) || 0)).padStart(13, "0")}:${String(Math.max(0, Number(counter) || 0)).padStart(4, "0")}:server`;
}

function compareMutation(left, right) {
  const byTimestamp = compareHlc(left.timestamp, right.timestamp);
  if (byTimestamp) return byTimestamp;
  return left.id.localeCompare(right.id);
}

function parseSocketMessage(raw) {
  const message = JSON.parse(raw);
  if (!message || typeof message !== "object") throw new Error("Invalid message");
  return message;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin === "null" ? "*" : origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function messageFromError(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Sync failed");
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function stringValue(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function isHlc(value) {
  return /^\d{13}:\d{4}:.+$/.test(String(value || ""));
}
