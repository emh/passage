import {
  applyMutation,
  canViewerSeeEntry,
  COMMENT_FIELDS,
  compareHlc,
  ENTRY_FIELDS,
  ENTITY_TYPES,
  isProfileStateField,
  normalizeCode,
  normalizeComment,
  normalizeEntry,
  normalizeViewer,
  normalizeProfile,
  normalizeTrip,
  TRIP_FIELDS
} from "../../../app/model.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const INTERNAL_CREATE_HEADER = "X-Passage-Internal-Create";
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_URL_METADATA_HTML_BYTES = 512 * 1024;
const DEFAULT_OPENAI_MODEL = "gpt-5";
const DEFAULT_NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org";
const DEFAULT_NOMINATIM_USER_AGENT = "PassagePersonalApp/0.1";
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
        return json(await this.materializedPayload(await this.requireRoom(), viewerFromRequest(request)), 200, cors);
      }

      if (route.action === "sync" && request.method === "GET") {
        return this.handleWebSocket(request);
      }

      if (route.action === "sync" && request.method === "POST") {
        return this.handleHttpSync(request, cors);
      }

      if (route.action === "state" && request.method === "GET") {
        return json(await this.materializedPayload(await this.requireRoom(), viewerFromRequest(request)), 200, cors);
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
    const room = await this.requireRoom();

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (room.type === "trip") rememberSocketViewer(server, viewerFromRequest(request));
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleHttpSync(request, cors) {
    const room = await this.requireRoom();
    const body = await request.json();
    const accepted = await this.acceptMutations(Array.isArray(body.mutations) ? body.mutations : [], room);
    const highWatermark = await this.highWatermark();

    if (room.type === "trip") {
      const materialized = filterTripStateForViewer(
        materializeMutations(await this.listSince(""), room),
        viewerFromSyncInput(request, body)
      );
      return json({
        room,
        code: room.code,
        trip: materialized.trips[0] || null,
        entries: materialized.entries,
        comments: materialized.comments,
        confirmedIds: accepted.map(mutation => mutation.id),
        highWatermark
      }, 200, cors);
    }

    return json({
      room,
      code: room.code,
      profile: room.profile || null,
      mutations: await this.listSince(typeof body.since === "string" ? body.since : ""),
      confirmedIds: accepted.map(mutation => mutation.id),
      highWatermark
    }, 200, cors);
  }

  async webSocketMessage(socket, raw) {
    await this.ready;

    try {
      const room = await this.requireRoom();
      const message = parseSocketMessage(raw);

      if (message.type === "sync") {
        if (room.type === "trip") {
          const viewer = normalizeViewer(message.viewer || socketViewer(socket));
          rememberSocketViewer(socket, viewer);
          socket.send(JSON.stringify({ type: "room", room }));
          await this.sendTripSnapshot(socket, room, viewer);
          return;
        }

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

        if (room.type === "trip") {
          const viewer = normalizeViewer(message.viewer || socketViewer(socket));
          rememberSocketViewer(socket, viewer);
          const materialized = materializeMutations(await this.listSince(""), room);
          await this.sendTripSnapshot(socket, room, viewer, materialized, highWatermark);
          if (accepted.length) {
            await this.broadcastTripSnapshots(socket, room, materialized, highWatermark);
          }
          return;
        }

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

  async broadcastTripSnapshots(sender, room, materialized, highWatermark) {
    for (const socket of this.state.getWebSockets()) {
      if (socket === sender) continue;
      try {
        await this.sendTripSnapshot(socket, room, socketViewer(socket), materialized, highWatermark);
      } catch {
        // Ignore dead sockets.
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

  async materializedPayload(room, viewer = null) {
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
        tripActivitySeenAt: state.tripActivitySeenAt || {},
        highWatermark: await this.highWatermark()
      }
      : createTripSnapshotPayload(room, filterTripStateForViewer(state, viewer), await this.highWatermark());
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

  async sendTripSnapshot(socket, room, viewer, materialized = null, highWatermark = "") {
    const state = filterTripStateForViewer(materialized || materializeMutations(await this.listSince(""), room), viewer);
    socket.send(JSON.stringify({
      type: "snapshot",
      ...createTripSnapshotPayload(room, state, highWatermark || await this.highWatermark())
    }));
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

    if (request.method === "POST" && url.pathname === "/api/url-metadata") {
      try {
        return await handleUrlMetadataRequest(request, env, cors);
      } catch (error) {
        return json({ error: messageFromError(error) }, error?.status || 400, cors);
      }
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

async function handleUrlMetadataRequest(request, env, cors) {
  const body = await request.json();
  const targetUrl = normalizeExternalUrl(body?.url);
  const target = await fetchUrlMetadataTarget(targetUrl);
  const metadata = parseSocialMetadata(target.html, target.finalUrl || targetUrl);
  const place = await extractPlaceFromUrl(target, metadata, env);

  return json({
    url: targetUrl,
    finalUrl: target.finalUrl || targetUrl,
    metadata,
    place
  }, 200, cors);
}

export function normalizeExternalUrl(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("URL is required");

  const text = input.trim();
  const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported");
  }

  if (isBlockedUrlHost(url.hostname)) {
    throw new Error("This URL is not allowed");
  }

  url.hash = "";
  return url.toString();
}

function isBlockedUrlHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }

  if (host === "::1" || host.startsWith("[::1]")) return true;
  return false;
}

async function fetchUrlMetadataTarget(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1",
      "User-Agent": "PassageBot/0.1"
    }
  });

  if (!response.ok) throw new Error(`URL returned ${response.status}`);
  const finalUrl = response.url || url;
  if (isBlockedUrlHost(new URL(finalUrl).hostname)) {
    throw new Error("This URL is not allowed");
  }

  return {
    url,
    finalUrl,
    contentType: response.headers.get("Content-Type") || "",
    html: await readLimitedResponseText(response, MAX_URL_METADATA_HTML_BYTES)
  };
}

async function readLimitedResponseText(response, maxBytes) {
  const length = Number(response.headers.get("Content-Length") || 0);
  if (length > maxBytes) throw new Error("URL response is too large");
  if (!response.body?.getReader) return (await response.text()).slice(0, maxBytes);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel?.();
        throw new Error("URL response is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    text += decoder.decode();
  }

  return text;
}

export function parseSocialMetadata(html, baseUrl = "") {
  const meta = collectMetaTags(html);
  const links = collectLinkTags(html);
  const title = cleanWhitespace(firstValue(
    meta.get("og:title"),
    meta.get("twitter:title"),
    titleTag(html)
  ));
  const description = cleanWhitespace(firstValue(
    meta.get("og:description"),
    meta.get("twitter:description"),
    meta.get("description")
  ));
  const imageSource = firstValue(
    meta.get("og:image"),
    meta.get("og:image:url"),
    meta.get("twitter:image"),
    meta.get("twitter:image:src"),
    links.get("image_src")
  );

  return {
    title,
    description,
    imageUrl: absoluteHttpUrl(imageSource, baseUrl)
  };
}

function collectMetaTags(html) {
  const result = new Map();
  for (const match of String(html || "").matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = parseHtmlAttributes(match[1]);
    const key = cleanWhitespace(attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    const content = decodeEntities(attrs.content || "");
    if (key && content && !result.has(key)) result.set(key, content);
  }
  return result;
}

function collectLinkTags(html) {
  const result = new Map();
  for (const match of String(html || "").matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = parseHtmlAttributes(match[1]);
    const href = decodeEntities(attrs.href || "");
    if (!href) continue;
    const rels = String(attrs.rel || "").toLowerCase().split(/\s+/).filter(Boolean);
    for (const rel of rels) {
      if (!result.has(rel)) result.set(rel, href);
    }
  }
  return result;
}

function parseHtmlAttributes(input) {
  const attrs = {};
  const text = String(input || "");
  const pattern = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function titleTag(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return match ? stripTags(decodeEntities(match[1])) : "";
}

async function extractPlaceFromUrl(target, shareMetadata, env) {
  const metadata = await getPlaceMetadata(target, shareMetadata, env);
  if (!metadata.isRelevantPlace) {
    return { isRelevantPlace: false };
  }

  const geocode = await getGeocode(metadata, env);
  return buildEntryPlace(metadata, geocode, target.finalUrl || target.url);
}

async function getPlaceMetadata(target, shareMetadata, env) {
  const fallback = mergePlaceMetadata([
    structuredPlaceMetadata(target.html, target.finalUrl || target.url, shareMetadata),
    placeMetadataFromUrl(target.finalUrl || target.url)
  ], target.finalUrl || target.url);

  if (env.MOCK_LLM === "true" || !stringOr(env.OPENAI_API_KEY, "")) {
    return fallback;
  }

  try {
    const openAiMetadata = await extractPlaceMetadataWithOpenAI(await placeMetadataTarget(target), shareMetadata, env);
    if (openAiMetadata.isRelevantPlace) return openAiMetadata;
  } catch {
    // Fall back to structured data and URL hints.
  }

  return fallback;
}

function mergePlaceMetadata(items, url) {
  const merged = fallbackPlaceMetadata(url);
  for (const item of items) {
    if (!item?.isRelevantPlace) continue;
    for (const field of ["name", "address", "city", "state", "country", "type", "description", "canonicalUrl", "lat", "lng"]) {
      if (!merged[field] && item[field]) merged[field] = item[field];
    }
    merged.isRelevantPlace = true;
  }
  merged.status = merged.isRelevantPlace && merged.name && (merged.address || merged.city || (merged.lat && merged.lng))
    ? "ready"
    : "metadata_incomplete";
  return merged;
}

async function extractPlaceMetadataWithOpenAI(target, shareMetadata, env) {
  const body = {
    model: stringOr(env.OPENAI_MODEL, DEFAULT_OPENAI_MODEL),
    input: [
      {
        role: "system",
        content: placeSystemPrompt()
      },
      {
        role: "user",
        content: placeUserPrompt(target, shareMetadata)
      }
    ],
    tools: [
      { type: "web_search" }
    ],
    tool_choice: "auto",
    text: {
      format: {
        type: "json_schema",
        name: "place_metadata",
        strict: true,
        schema: placeMetadataSchema()
      }
    }
  };

  const reasoning = openAiReasoningConfig(env);
  if (reasoning) body.reasoning = reasoning;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await responseError(response, "OpenAI metadata request failed"));
  }

  const payload = await response.json();
  const outputText = getOutputText(payload);
  if (!outputText) throw new Error("OpenAI returned no metadata text");
  return normalizePlaceMetadata(JSON.parse(outputText), target.url);
}

function placeSystemPrompt() {
  return [
    "The user will provide the URL for a place they need metadata for.",
    "Examine the supplied URL and determine the name, address, lat/lng coordinates, short description, and broad place type.",
    "Use web search to open the exact supplied URL first, follow redirects, and resolve short links or map share links when needed.",
    "If a search query hint is supplied, treat it as the intended place query from the share link and use it to search for the exact place.",
    "For Google Maps or share.google links, prefer the Google Maps place result's displayed address and coordinates when available.",
    "If the URL is a share URL, search result, or interstitial, identify the intended place only when the URL or page clearly points to one physical place.",
    "You may navigate further within the supplied website, especially contact, location, about, hours, store, reservation, and booking pages.",
    "If the page is not about one specific physical place, set isRelevantPlace to false and leave unknown fields empty.",
    "For address, return a complete display address with enough detail to identify the right city, state/province, postal code, and country when available.",
    "Actively look for exact decimal lat/lng coordinates and leave them empty only when you cannot verify them.",
    "Choose a broad place type such as restaurant, bar, cafe, bakery, museum, gym, bookstore, market, hotel, park, shop, or venue.",
    "Do not invent missing facts.",
    "Return structured output that exactly matches the schema."
  ].join(" ");
}

function placeUserPrompt(target, shareMetadata) {
  return [
    `URL: ${target.url}`,
    `Resolved URL hint: ${target.resolvedUrl}`,
    `Search query hint: ${target.searchQuery}`,
    `Host hint: ${target.source}`,
    `Page title hint: ${shareMetadata.title || ""}`,
    `Page description hint: ${shareMetadata.description || ""}`,
    "",
    "Extract these fields:",
    "- name: public place name",
    "- address: full display address",
    "- city: locality only",
    "- state: state, province, prefecture, region, or equivalent administrative area",
    "- country: full country name",
    "- type: broad top-level place type",
    "- description: one short factual description",
    "- canonicalUrl: official website URL when known, otherwise the supplied URL",
    "- lat and lng: exact decimal degrees as strings",
    "- isRelevantPlace: false unless the URL resolves to one specific physical place"
  ].join("\n");
}

function placeMetadataSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "address", "city", "state", "country", "type", "description", "canonicalUrl", "lat", "lng", "isRelevantPlace"],
    properties: {
      name: { type: "string" },
      address: { type: "string" },
      city: { type: "string" },
      state: { type: "string" },
      country: { type: "string" },
      type: { type: "string" },
      description: { type: "string" },
      canonicalUrl: { type: "string" },
      lat: { type: "string" },
      lng: { type: "string" },
      isRelevantPlace: { type: "boolean" }
    }
  };
}

function openAiReasoningConfig(env) {
  const effort = stringOr(env.OPENAI_REASONING_EFFORT, "");
  if (!["minimal", "low", "medium", "high"].includes(effort)) return null;
  return { effort };
}

async function placeMetadataTarget(target) {
  const shareHint = await googleShareHint(target.url);
  return {
    url: target.url,
    resolvedUrl: shareHint.resolvedUrl || target.finalUrl || "",
    searchQuery: shareHint.searchQuery || "",
    source: sourceFromUrl(target.url)
  };
}

async function googleShareHint(placeUrl) {
  const url = safeUrl(placeUrl);
  if (!isGoogleShareUrl(url)) {
    return {
      resolvedUrl: "",
      searchQuery: ""
    };
  }

  try {
    const response = await fetch(placeUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1",
        "User-Agent": "PassageBot/0.1"
      }
    });
    const html = await readLimitedResponseText(response, MAX_URL_METADATA_HTML_BYTES);

    return {
      resolvedUrl: response.url || "",
      searchQuery: extractGoogleSearchQuery(html, safeUrl(response.url) || url)
    };
  } catch {
    return {
      resolvedUrl: "",
      searchQuery: ""
    };
  }
}

function isGoogleShareUrl(url) {
  return url?.hostname === "share.google" ||
    (url?.hostname.endsWith("google.com") && url?.pathname === "/share.google");
}

function extractGoogleSearchQuery(html, baseUrl) {
  const matches = String(html || "").matchAll(/href=["']([^"']*\/search\?[^"']*?q=[^"']+)["']/gi);

  for (const match of matches) {
    try {
      const url = new URL(decodeEntities(match[1]), baseUrl);
      const query = url.searchParams.get("q") || "";
      if (query.trim()) return query.trim();
    } catch {
      // Keep looking for a usable search fallback.
    }
  }

  return "";
}

function structuredPlaceMetadata(html, baseUrl, shareMetadata) {
  const objects = jsonLdObjects(html);
  const place = objects.find(isStructuredPlaceObject);
  if (!place) return fallbackPlaceMetadata(baseUrl);

  const addressParts = structuredAddressParts(place.address);
  const geo = structuredGeo(place.geo);
  const name = stringOr(place.name, shareMetadata.title || titleFromUrl(baseUrl));
  const address = addressParts.address || stringOr(place.address, "");
  const lat = Number.isFinite(geo.lat) ? String(geo.lat) : "";
  const lng = Number.isFinite(geo.lng) ? String(geo.lng) : "";
  const isRelevantPlace = Boolean(name && (address || addressParts.city || (lat && lng)));

  return normalizePlaceMetadata({
    name,
    address,
    city: addressParts.city,
    state: addressParts.state,
    country: addressParts.country,
    type: structuredType(place["@type"]),
    description: stringOr(place.description, shareMetadata.description || ""),
    canonicalUrl: stringOr(place.url, baseUrl),
    lat,
    lng,
    isRelevantPlace
  }, baseUrl);
}

function jsonLdObjects(html) {
  const result = [];
  const scripts = String(html || "").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const attrs = parseHtmlAttributes(match[1]);
    if (String(attrs.type || "").toLowerCase() !== "application/ld+json") continue;
    try {
      collectJsonObjects(JSON.parse(decodeEntities(match[2])), result);
    } catch {
      // Ignore malformed structured data.
    }
  }
  return result;
}

function collectJsonObjects(value, result) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(item => collectJsonObjects(item, result));
    return;
  }

  result.push(value);
  if (Array.isArray(value["@graph"])) value["@graph"].forEach(item => collectJsonObjects(item, result));
}

function isStructuredPlaceObject(object) {
  const types = structuredTypes(object?.["@type"]);
  if (types.some(type => /place|localbusiness|restaurant|bar|cafe|bakery|museum|hotel|store|shop|park|touristattraction|landmarksorhistoricalbuildings/i.test(type))) {
    return true;
  }
  return Boolean(object?.address && object?.geo && object?.name);
}

function structuredTypes(type) {
  if (Array.isArray(type)) return type.map(item => String(item || ""));
  return String(type || "").split(/\s*,\s*/).filter(Boolean);
}

function structuredType(type) {
  const text = structuredTypes(type)[0] || "place";
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function structuredAddressParts(address) {
  if (!address) return { address: "", city: "", state: "", country: "" };
  if (typeof address === "string") {
    return {
      address: cleanWhitespace(address),
      city: "",
      state: "",
      country: ""
    };
  }

  const street = cleanWhitespace([
    address.streetAddress,
    address.postOfficeBoxNumber
  ].filter(Boolean).join(" "));
  const city = cleanWhitespace(address.addressLocality || "");
  const state = cleanWhitespace(address.addressRegion || "");
  const postal = cleanWhitespace(address.postalCode || "");
  const country = cleanWhitespace(typeof address.addressCountry === "object"
    ? address.addressCountry.name
    : address.addressCountry || "");
  const display = [street, city, state, postal, country].filter(Boolean).join(", ");

  return {
    address: display,
    city,
    state,
    country
  };
}

function structuredGeo(geo) {
  if (!geo || typeof geo !== "object") return { lat: null, lng: null };
  return {
    lat: numberOrNull(geo.latitude),
    lng: numberOrNull(geo.longitude)
  };
}

function placeMetadataFromUrl(input) {
  const url = safeUrl(input);
  if (!url) return fallbackPlaceMetadata(input);

  const host = url.hostname.toLowerCase();
  if (host.includes("google.") || host === "share.google") return googleMapsPlaceMetadata(url);
  if (host.includes("maps.apple.")) return appleMapsPlaceMetadata(url);
  if (host.includes("openstreetmap.org")) return osmPlaceMetadata(url);
  return fallbackPlaceMetadata(url.toString());
}

function googleMapsPlaceMetadata(url) {
  const text = `${url.pathname}${url.search}`;
  const atMatch = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
  const dataMatch = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(text);
  const query = url.searchParams.get("q") || "";
  const coords = atMatch || dataMatch;
  const placeName = decodeURIComponent((/\/place\/([^/]+)/.exec(url.pathname)?.[1] || query || "").replace(/\+/g, " "));
  const lat = coords ? coords[1] : "";
  const lng = coords ? coords[2] : "";

  return normalizePlaceMetadata({
    name: cleanWhitespace(placeName) || titleFromUrl(url.toString()),
    address: "",
    city: "",
    state: "",
    country: "",
    type: "place",
    description: "",
    canonicalUrl: url.toString(),
    lat,
    lng,
    isRelevantPlace: Boolean(placeName || (lat && lng))
  }, url.toString());
}

function appleMapsPlaceMetadata(url) {
  const ll = url.searchParams.get("ll") || "";
  const [lat = "", lng = ""] = ll.split(",").map(part => part.trim());
  const query = url.searchParams.get("q") || "";
  return normalizePlaceMetadata({
    name: cleanWhitespace(query) || titleFromUrl(url.toString()),
    address: "",
    city: "",
    state: "",
    country: "",
    type: "place",
    description: "",
    canonicalUrl: url.toString(),
    lat,
    lng,
    isRelevantPlace: Boolean(query || (lat && lng))
  }, url.toString());
}

function osmPlaceMetadata(url) {
  const lat = url.searchParams.get("mlat") || "";
  const lng = url.searchParams.get("mlon") || "";
  const query = url.searchParams.get("query") || "";
  return normalizePlaceMetadata({
    name: cleanWhitespace(query) || titleFromUrl(url.toString()),
    address: "",
    city: "",
    state: "",
    country: "",
    type: "place",
    description: "",
    canonicalUrl: url.toString(),
    lat,
    lng,
    isRelevantPlace: Boolean(query || (lat && lng))
  }, url.toString());
}

function normalizePlaceMetadata(metadata, fallbackUrl) {
  const name = stringOr(metadata.name, "");
  const lat = stringOr(metadata.lat, "");
  const lng = stringOr(metadata.lng, "");
  const isRelevantPlace = typeof metadata.isRelevantPlace === "boolean"
    ? metadata.isRelevantPlace
    : Boolean(name && (metadata.address || metadata.city || (lat && lng)));

  return {
    name,
    address: stringOr(metadata.address, ""),
    city: stringOr(metadata.city, ""),
    state: stringOr(metadata.state, ""),
    country: countryName(metadata.country),
    type: stringOr(metadata.type, "place"),
    description: stringOr(metadata.description, ""),
    canonicalUrl: stringOr(metadata.canonicalUrl, fallbackUrl),
    lat,
    lng,
    isRelevantPlace,
    status: isRelevantPlace && name && (metadata.address || metadata.city || (lat && lng)) ? "ready" : "metadata_incomplete",
    error: ""
  };
}

function fallbackPlaceMetadata(url) {
  return {
    name: "",
    address: "",
    city: "",
    state: "",
    country: "",
    type: "place",
    description: "",
    canonicalUrl: url || "",
    lat: "",
    lng: "",
    isRelevantPlace: false,
    status: "metadata_incomplete",
    error: ""
  };
}

async function getGeocode(metadata, env) {
  const lat = numberOrNull(metadata.lat);
  const lng = numberOrNull(metadata.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return {
      status: "metadata",
      lat,
      lng,
      city: metadata.city || "",
      state: metadata.state || "",
      country: metadata.country || ""
    };
  }

  try {
    return await geocodePlaceMetadata(metadata, env);
  } catch (error) {
    return {
      status: "geocode_failed",
      error: messageFromError(error)
    };
  }
}

async function geocodePlaceMetadata(place, env) {
  const queries = buildGeocodeQueries(place);
  if (!queries.length) {
    return {
      status: "not_found",
      error: "No address or city to geocode"
    };
  }

  for (const query of queries) {
    const searchUrl = buildGeocodeSearchUrl(query, env);
    const response = await fetch(searchUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": env.NOMINATIM_USER_AGENT || DEFAULT_NOMINATIM_USER_AGENT,
        "Referer": "https://passage.local/"
      }
    });

    if (!response.ok) throw new Error(`Nominatim returned ${response.status}`);

    const results = await response.json();
    const result = normalizeGeocodeResult(pickGeocodeResult(Array.isArray(results) ? results : [], place, query));
    if (result.status === "ready" || result.status === "approximate") return result;
  }

  return {
    status: "not_found",
    error: "No geocoding result"
  };
}

function buildGeocodeQueries(place) {
  const hasLocationHint = [
    place.address,
    place.city,
    place.state,
    place.country
  ].some(value => String(value || "").trim());

  if (!hasLocationHint) return [];

  const name = cleanPlaceName(place.name);
  const address = String(place.address || "").trim();
  const simpleAddress = simplifyAddress(address);
  const streetAddress = streetAddressLine(simpleAddress || address);
  const roadAddress = roadAddressLine(streetAddress);
  const city = String(place.city || "").trim();
  const state = String(place.state || "").trim();
  const country = countryName(place.country);
  const queries = [];

  addGeocodeQuery(queries, [name, address, city, state, country]);
  if (address) addGeocodeQuery(queries, [address, city, state, country]);
  if (simpleAddress && simpleAddress !== address) {
    addGeocodeQuery(queries, [name, simpleAddress, city, state, country]);
    addGeocodeQuery(queries, [simpleAddress, city, state, country]);
  }
  if (streetAddress && streetAddress !== address && streetAddress !== simpleAddress) {
    addGeocodeQuery(queries, [name, streetAddress, city, state, country]);
    addGeocodeQuery(queries, [streetAddress, city, state, country]);
  }
  if (roadAddress && roadAddress !== streetAddress) {
    addGeocodeQuery(queries, [roadAddress, city, state, country]);
  }
  if (name && city) addGeocodeQuery(queries, [name, city, state, country]);

  return queries;
}

function addGeocodeQuery(queries, parts) {
  const query = parts.filter(Boolean).join(", ");
  if (query && !queries.includes(query)) queries.push(query);
}

function buildGeocodeSearchUrl(query, env) {
  const endpoint = new URL(env.NOMINATIM_ENDPOINT || DEFAULT_NOMINATIM_ENDPOINT);
  if (!["https:", "http:"].includes(endpoint.protocol)) {
    throw new Error("NOMINATIM_ENDPOINT must be HTTP or HTTPS");
  }

  const searchUrl = new URL("/search", endpoint);
  searchUrl.searchParams.set("format", "jsonv2");
  searchUrl.searchParams.set("addressdetails", "1");
  searchUrl.searchParams.set("limit", "5");
  searchUrl.searchParams.set("q", query);
  return searchUrl;
}

function pickGeocodeResult(results, place, query) {
  if (!results.length) return null;

  return [...results]
    .map((result, index) => ({
      result,
      score: scoreGeocodeResult(result, place, query) - index * 0.01
    }))
    .sort((left, right) => right.score - left.score)[0]?.result || null;
}

function scoreGeocodeResult(result, place, query) {
  const resultName = result.name || namedAddressValue(result.address) || "";
  const wantedName = cleanPlaceName(place.name);
  const resultText = `${resultName} ${result.display_name || ""} ${result.category || ""} ${result.type || ""}`;
  const queryText = `${query} ${place.type || ""}`;
  let score = Number(result.importance || 0);

  score += tokenOverlap(wantedName, resultText) * 8;
  score += tokenOverlap(queryText, resultText) * 2;

  if (sameText(result.address?.city || result.address?.town || result.address?.village, place.city)) score += 3;
  if (sameText(result.address?.state || result.address?.region || result.address?.province, place.state)) score += 2;
  if (sameText(result.address?.country, countryName(place.country))) score += 2;
  if (isCategoryMatch(place.type, result)) score += 4;

  return score;
}

function normalizeGeocodeResult(result) {
  if (!result) {
    return {
      status: "not_found",
      error: "No geocoding result"
    };
  }

  const address = result.address || {};
  const lat = Number(result.lat);
  const lng = Number(result.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      status: "not_found",
      error: "Geocoding result had no coordinates"
    };
  }

  return {
    status: isApproximateGeocodeResult(result) ? "approximate" : "ready",
    name: result.name || namedAddressValue(address),
    lat,
    lng,
    displayAddress: result.display_name || "",
    city: address.city || address.town || address.village || address.hamlet || address.municipality || "",
    state: address.state || address.region || address.province || "",
    country: address.country || "",
    provider: "nominatim"
  };
}

function isApproximateGeocodeResult(result) {
  const category = String(result?.category || "").toLowerCase();
  const type = String(result?.type || "").toLowerCase();
  const addresstype = String(result?.addresstype || "").toLowerCase();

  return category === "highway" ||
    addresstype === "road" ||
    ["road", "residential", "tertiary", "secondary", "primary", "service", "footway"].includes(type);
}

function buildEntryPlace(metadata, geocode, fallbackUrl) {
  const metadataLat = numberOrNull(metadata.lat);
  const metadataLng = numberOrNull(metadata.lng);
  const geocodeLat = numberOrNull(geocode.lat);
  const geocodeLng = numberOrNull(geocode.lng);
  const lat = geocodeLat ?? metadataLat;
  const lng = geocodeLng ?? metadataLng;
  const address = metadata.address || geocode.displayAddress || "";
  const city = metadata.city || geocode.city || "";
  const state = metadata.state || geocode.state || "";
  const country = countryName(metadata.country) || geocode.country || "";
  const name = metadata.name || geocode.name || titleFromUrl(fallbackUrl);

  return {
    isRelevantPlace: Boolean(metadata.isRelevantPlace && (address || city || (Number.isFinite(lat) && Number.isFinite(lng)))),
    name,
    address,
    city,
    state,
    country,
    type: metadata.type || "place",
    description: metadata.description || "",
    canonicalUrl: metadata.canonicalUrl || fallbackUrl || "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    geocodeStatus: geocode.status || "",
    status: metadata.status || ""
  };
}

function cleanPlaceName(name) {
  const text = String(name || "").trim();
  const pipeParts = text.split(/\s+\|\s+/).map(part => part.trim()).filter(Boolean);
  if (pipeParts.length > 1) return pipeParts[pipeParts.length - 1];
  return text;
}

function simplifyAddress(address) {
  return String(address || "")
    .replace(/\([^)]*(?:entre|between)[^)]*\)/gi, " ")
    .replace(/\b(?:entre|between)\b.+$/i, " ")
    .replace(/#\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
}

function streetAddressLine(address) {
  return String(address || "").split(",")[0]?.trim() || "";
}

function roadAddressLine(address) {
  return String(address || "")
    .replace(/^\d+[a-z]?\s+/i, "")
    .trim();
}

function tokenOverlap(left, right) {
  const leftTokens = usefulTokens(left);
  const rightTokens = usefulTokens(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  return leftTokens.filter(token => rightTokens.includes(token)).length;
}

function usefulTokens(value) {
  const stop = new Set(["the", "and", "for", "with", "world", "largest", "independent", "bookstore"]);
  return String(value || "")
    .toLowerCase()
    .match(/[a-z0-9']{3,}/g)
    ?.filter(token => !stop.has(token)) || [];
}

function sameText(left, right) {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  return Boolean(a && b && a === b);
}

function isCategoryMatch(type, result) {
  const wanted = String(type || "").toLowerCase();
  const category = String(result.category || "").toLowerCase();
  const resultType = String(result.type || "").toLowerCase();

  if (/\b(shop|store|bookstore|boutique)\b/.test(wanted)) return category === "shop" || ["books", "bookstore"].includes(resultType);
  if (/\b(restaurant|diner|bistro|trattoria|pizzeria|sushi|ramen|taqueria)\b/.test(wanted)) return category === "amenity" && ["restaurant", "cafe", "bar", "pub"].includes(resultType);
  if (/\b(bar|pub|cocktail|brewery|taproom)\b/.test(wanted)) return category === "amenity" && ["bar", "pub", "biergarten"].includes(resultType);
  if (/\b(cafe|coffee|bakery|tea)\b/.test(wanted)) return category === "amenity" && ["cafe", "bakery"].includes(resultType);
  if (/\b(fitness|gym|yoga|pilates)\b/.test(wanted)) return ["leisure", "amenity"].includes(category) && ["fitness_centre", "sports_centre", "gym"].includes(resultType);
  if (/\b(museum|gallery)\b/.test(wanted)) return category === "tourism" && ["museum", "gallery"].includes(resultType);

  return false;
}

function namedAddressValue(address = {}) {
  return address.shop || address.amenity || address.tourism || address.leisure || address.building || "";
}

function countryName(code) {
  const countries = {
    CA: "Canada",
    US: "United States",
    GB: "United Kingdom"
  };
  const text = String(code || "").trim();
  if (!text) return "";
  return countries[text.toUpperCase()] || text;
}

function numberOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOr(value, fallback = "") {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function firstValue(...values) {
  return values.find(value => String(value || "").trim()) || "";
}

function cleanWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, " ");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function absoluteHttpUrl(value, baseUrl) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, baseUrl || undefined);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeUrl(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function sourceFromUrl(input) {
  try {
    return new URL(input).hostname.replace(/^www\./, "");
  } catch {
    return "place";
  }
}

function titleFromUrl(input) {
  try {
    const url = new URL(input);
    const slug = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
    return slug
      .replace(/\.[a-z0-9]+$/i, "")
      .split(/[-_+]+/g)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  } catch {
    return "Untitled place";
  }
}

function getOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;

  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }

  return chunks.join("");
}

async function responseError(response, fallback) {
  try {
    const payload = await response.json();
    const message = payload?.error?.message || payload?.error || payload?.message;
    if (typeof message === "string" && message) return `${fallback}: ${message}`;
  } catch {
    // Fall through to status text.
  }

  return `${fallback}: ${response.status}`;
}

function photoAssetKey(assetId) {
  return `photos/${String(assetId || "").trim()}`;
}

function createTripSnapshotPayload(room, state, highWatermark = "") {
  return {
    room,
    code: room.code,
    trip: state.trips[0] || null,
    entries: state.entries,
    comments: state.comments,
    highWatermark
  };
}

export function filterTripStateForViewer(state, viewer = {}) {
  const trip = state?.trips?.[0] || null;
  if (!trip) {
    return {
      trips: [],
      entries: [],
      comments: []
    };
  }

  const entries = Array.isArray(state?.entries)
    ? state.entries.filter(entry => canViewerSeeEntry(entry, trip, viewer))
    : [];
  const entryIds = new Set(entries.map(entry => entry.id));
  return {
    trips: [trip],
    entries,
    comments: Array.isArray(state?.comments)
      ? state.comments.filter(comment => entryIds.has(comment.entryId))
      : []
  };
}

function viewerFromRequest(request) {
  const url = new URL(request.url);
  return normalizeViewer({
    profileId: url.searchParams.get("profileId") || "",
    name: url.searchParams.get("profileName") || "",
    access: url.searchParams.get("access") || ""
  });
}

function viewerFromSyncInput(request, body) {
  const requested = normalizeViewer(body?.viewer);
  if (requested.profileId || requested.name || requested.access === "collaborator") return requested;
  return viewerFromRequest(request);
}

function rememberSocketViewer(socket, viewer) {
  try {
    socket.serializeAttachment?.(normalizeViewer(viewer));
  } catch {
    // Attachments are optional; fall back to per-message viewer context.
  }
}

function socketViewer(socket) {
  try {
    return normalizeViewer(socket.deserializeAttachment?.() || {});
  } catch {
    return normalizeViewer();
  }
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
    tripActivitySeenAt: {},
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
  if (!isProfileStateField(mutation.field)) throw new Error("Invalid profile state field");
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
