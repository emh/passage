export const TRIP_FIELDS = [
  "title",
  "startIso",
  "endIso",
  "cities",
  "sharedCode",
  "collaborators",
  "ownerProfileId",
  "ownerName",
  "dateCreated",
  "dateUpdated",
  "deleted"
];

export const ENTRY_FIELDS = [
  "tripId",
  "type",
  "title",
  "description",
  "body",
  "url",
  "linkPreviewTitle",
  "linkPreviewDescription",
  "linkPreviewImageUrl",
  "photos",
  "photoAssetId",
  "photoMime",
  "photoWidth",
  "photoHeight",
  "photoSize",
  "photoUploadedAt",
  "timestamp",
  "lat",
  "lng",
  "locationQuery",
  "locationDisplayName",
  "locationCity",
  "locationRegion",
  "locationCountry",
  "locationAccuracy",
  "geotaggedAt",
  "geotagStatus",
  "authorProfileId",
  "authorName",
  "visibility",
  "dateCreated",
  "dateUpdated",
  "deleted"
];

export const COMMENT_FIELDS = [
  "entryId",
  "tripId",
  "body",
  "authorProfileId",
  "authorName",
  "dateCreated",
  "dateUpdated",
  "deleted"
];

export const PROFILE_STATE_FIELDS = [
  "activitySeenAt"
];

export const ENTRY_VISIBILITY_OPTIONS = ["private", "collaborators", "public"];

const TRIP_ACTIVITY_SEEN_PREFIX = "tripActivitySeenAt:";

export const ENTITY_TYPES = ["trip", "entry", "comment", "profileState"];

export function tripActivitySeenField(tripId) {
  const id = String(tripId || "").trim();
  return id ? `${TRIP_ACTIVITY_SEEN_PREFIX}${id}` : "";
}

export function isProfileStateField(field) {
  return PROFILE_STATE_FIELDS.includes(field) || Boolean(tripIdFromActivitySeenField(field));
}

export function createId(prefix = "id") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createDeviceId() {
  return createId("device");
}

export function createProfile(input = {}) {
  return normalizeProfile({
    id: input.id || createId("profile"),
    name: input.name || "",
    code: input.code || ""
  });
}

export function normalizeProfile(input = {}) {
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
  if (!id) return null;
  return {
    id,
    name: normalizeUserName(input.name),
    code: normalizeCode(input.code)
  };
}

export function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeUserName(value) {
  return cleanSingleLine(value);
}

export function serializeHlc(wallTime, counter, deviceId) {
  return `${String(Math.max(0, Number(wallTime) || 0)).padStart(13, "0")}:${String(Math.max(0, Number(counter) || 0)).padStart(4, "0")}:${deviceId || ""}`;
}

export function parseHlc(value) {
  if (typeof value !== "string" || !value) {
    return { wallTime: 0, counter: 0, deviceId: "" };
  }

  const [wallTime, counter, ...deviceParts] = value.split(":");
  return {
    wallTime: Number.parseInt(wallTime, 10) || 0,
    counter: Number.parseInt(counter, 10) || 0,
    deviceId: deviceParts.join(":")
  };
}

export function compareHlc(left, right) {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.deviceId.localeCompare(b.deviceId);
}

export function tickHlc(state, now = Date.now(), deviceId = state.deviceId) {
  const clock = normalizeClock(state.hlc);
  const wallTime = Math.max(clock.wallTime, now);
  const counter = wallTime === clock.wallTime ? clock.counter + 1 : 0;
  state.hlc = { wallTime, counter };
  return serializeHlc(wallTime, counter, deviceId);
}

export function observeHlc(state, timestamp, now = Date.now(), deviceId = state.deviceId) {
  const local = normalizeClock(state.hlc);
  const remote = parseHlc(timestamp);
  const wallTime = Math.max(local.wallTime, remote.wallTime, now);
  let counter = 0;

  if (wallTime === local.wallTime && wallTime === remote.wallTime) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (wallTime === local.wallTime) {
    counter = local.counter + 1;
  } else if (wallTime === remote.wallTime) {
    counter = remote.counter + 1;
  }

  state.hlc = { wallTime, counter };
  return serializeHlc(wallTime, counter, deviceId);
}

export function createMutation(state, entityType, entityId, field, value) {
  return {
    id: createId("mutation"),
    entityType: String(entityType || ""),
    entityId: String(entityId || ""),
    field: String(field || ""),
    value,
    timestamp: tickHlc(state, Date.now(), state.deviceId),
    deviceId: String(state.deviceId || ""),
    profileId: String(state.profile?.id || "")
  };
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(iso, days) {
  const date = parseDateOnly(iso);
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
}

export function normalizeTrip(input = {}) {
  const now = new Date().toISOString();
  const startIso = validDateOnly(input.startIso) || todayIso();
  const endIso = validDateOnly(input.endIso) || startIso;
  const normalizedEnd = parseDateOnly(endIso) < parseDateOnly(startIso) ? startIso : endIso;

  return {
    id: String(input.id || createId("trip")),
    title: cleanSingleLine(input.title) || "Untitled trip",
    startIso,
    endIso: normalizedEnd,
    cities: normalizeCities(input.cities),
    sharedCode: normalizeCode(input.sharedCode),
    collaborators: normalizeCollaborators(input.collaborators),
    ownerProfileId: String(input.ownerProfileId || "").trim(),
    ownerName: normalizeUserName(input.ownerName),
    dateCreated: typeof input.dateCreated === "string" && input.dateCreated ? input.dateCreated : now,
    dateUpdated: typeof input.dateUpdated === "string" ? input.dateUpdated : "",
    deleted: Boolean(input.deleted)
  };
}

export function createTrip(title) {
  const startIso = todayIso();
  return normalizeTrip({
    id: createId("trip"),
    title,
    startIso,
    endIso: addDaysIso(startIso, 7),
    dateCreated: new Date().toISOString()
  });
}

export function normalizeEntry(input = {}) {
  const now = new Date().toISOString();
  const description = cleanText(input.description) || cleanText(input.body);
  const photos = normalizeEntryPhotos(input.photos, input);
  const firstPhoto = photos[0] || {};
  return {
    id: String(input.id || createId("entry")),
    tripId: String(input.tripId || ""),
    type: "entry",
    title: cleanSingleLine(input.title),
    description,
    body: description,
    url: normalizeEntryUrl(input.url),
    linkPreviewTitle: cleanSingleLine(input.linkPreviewTitle),
    linkPreviewDescription: cleanText(input.linkPreviewDescription),
    linkPreviewImageUrl: normalizeAbsoluteHttpUrl(input.linkPreviewImageUrl),
    photos,
    photoAssetId: firstPhoto.photoAssetId || "",
    photoMime: firstPhoto.photoMime || "",
    photoWidth: firstPhoto.photoWidth,
    photoHeight: firstPhoto.photoHeight,
    photoSize: firstPhoto.photoSize,
    photoUploadedAt: firstPhoto.photoUploadedAt || "",
    timestamp: validDateTime(input.timestamp) || now,
    lat: geoNumberOrNull(input.lat),
    lng: geoNumberOrNull(input.lng),
    locationQuery: cleanSingleLine(input.locationQuery),
    locationDisplayName: cleanSingleLine(input.locationDisplayName),
    locationCity: cleanSingleLine(input.locationCity),
    locationRegion: cleanSingleLine(input.locationRegion),
    locationCountry: cleanSingleLine(input.locationCountry),
    locationAccuracy: geoNumberOrNull(input.locationAccuracy),
    geotaggedAt: validDateTime(input.geotaggedAt),
    geotagStatus: normalizeGeotagStatus(input.geotagStatus),
    authorProfileId: String(input.authorProfileId || "").trim(),
    authorName: normalizeUserName(input.authorName),
    visibility: normalizeEntryVisibility(input.visibility),
    dateCreated: typeof input.dateCreated === "string" && input.dateCreated ? input.dateCreated : now,
    dateUpdated: typeof input.dateUpdated === "string" ? input.dateUpdated : "",
    deleted: Boolean(input.deleted)
  };
}

export function createJournalEntry(tripId, fields = {}) {
  return normalizeEntry({
    ...fields,
    id: createId("entry"),
    tripId,
    type: "journal",
    timestamp: fields.timestamp || new Date().toISOString(),
    dateCreated: new Date().toISOString()
  });
}

export function createEntry(tripId, fields = {}) {
  return createJournalEntry(tripId, fields);
}

export function normalizeComment(input = {}) {
  const now = new Date().toISOString();
  return {
    id: String(input.id || createId("comment")),
    entryId: String(input.entryId || ""),
    tripId: String(input.tripId || ""),
    body: cleanText(input.body),
    authorProfileId: String(input.authorProfileId || "").trim(),
    authorName: normalizeUserName(input.authorName),
    dateCreated: typeof input.dateCreated === "string" && input.dateCreated ? input.dateCreated : now,
    dateUpdated: typeof input.dateUpdated === "string" ? input.dateUpdated : "",
    deleted: Boolean(input.deleted)
  };
}

export function createComment(entry, profile, body) {
  return normalizeComment({
    id: createId("comment"),
    entryId: entry?.id || "",
    tripId: entry?.tripId || "",
    body,
    authorProfileId: profile?.id || "",
    authorName: profile?.name || "",
    dateCreated: new Date().toISOString()
  });
}

export function visibleTrips(trips = []) {
  return trips.filter(trip => !trip.deleted);
}

export function visibleEntries(entries = []) {
  return entries.filter(entry => !entry.deleted);
}

export function visibleComments(comments = []) {
  return comments.filter(comment => !comment.deleted);
}

export function normalizeViewer(input = {}) {
  return {
    profileId: String(input.profileId || "").trim(),
    name: normalizeUserName(input.name),
    access: normalizeViewerAccess(input.access)
  };
}

export function viewerMatchesProfile(viewer, profileId, name = "") {
  const currentViewer = normalizeViewer(viewer);
  const candidateId = String(profileId || "").trim();
  if (currentViewer.profileId && candidateId) return currentViewer.profileId === candidateId;
  return Boolean(currentViewer.name && normalizeUserName(name) && currentViewer.name === normalizeUserName(name));
}

export function normalizeEntryVisibility(value) {
  const visibility = String(value || "").trim().toLowerCase();
  return ENTRY_VISIBILITY_OPTIONS.includes(visibility) ? visibility : "public";
}

export function viewerCanAccessCollaboratorEntries(trip, viewer) {
  const currentViewer = normalizeViewer(viewer);
  if (currentViewer.access === "collaborator") return true;
  if (viewerMatchesProfile(currentViewer, trip?.ownerProfileId, trip?.ownerName)) return true;
  return normalizeCollaborators(trip?.collaborators)
    .some(collaborator => viewerMatchesProfile(currentViewer, collaborator.profileId, collaborator.name));
}

export function canViewerSeeEntry(entry, trip, viewer) {
  const visibility = normalizeEntryVisibility(entry?.visibility);
  if (visibility === "public") return true;

  const currentViewer = normalizeViewer(viewer);
  if (viewerMatchesProfile(currentViewer, entry?.authorProfileId, entry?.authorName)) return true;
  if (visibility === "private") return false;
  return viewerCanAccessCollaboratorEntries(trip, currentViewer);
}

export function entriesForTrip(entries, tripId) {
  return visibleEntries(entries)
    .filter(entry => entry.tripId === String(tripId))
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
}

export function commentsForEntry(comments, entryId) {
  return visibleComments(comments)
    .filter(comment => comment.entryId === String(entryId))
    .sort((left, right) => new Date(left.dateCreated) - new Date(right.dateCreated));
}

export function tripEntryCounts(entries, tripId) {
  const count = entriesForTrip(entries, tripId).length;
  return {
    total: count,
    journals: count
  };
}

export function isTripSharedByOtherProfile(trip, profile) {
  if (!normalizeCode(trip?.sharedCode)) return false;

  const ownerProfileId = String(trip?.ownerProfileId || "").trim();
  const profileId = String(profile?.id || "").trim();
  if (ownerProfileId && profileId) return ownerProfileId !== profileId;

  const ownerName = normalizeUserName(trip?.ownerName);
  const profileName = normalizeUserName(profile?.name);
  return Boolean(ownerName && profileName && ownerName !== profileName);
}

export function applyMutations(state, mutations = []) {
  let changed = false;
  for (const mutation of mutations) {
    changed = applyMutation(state, mutation) || changed;
  }
  return changed;
}

export function applyMutation(state, mutation) {
  if (!isMutationLike(mutation)) return false;
  observeHlc(state, mutation.timestamp);

  if (mutation.entityType === "trip") return applyTripMutation(state, mutation);
  if (mutation.entityType === "entry") return applyEntryMutation(state, mutation);
  if (mutation.entityType === "comment") return applyCommentMutation(state, mutation);
  if (mutation.entityType === "profileState") return applyProfileStateMutation(state, mutation);
  return false;
}

export function daysBetween(startIso, endIso) {
  const start = parseDateOnly(startIso);
  const end = parseDateOnly(endIso);
  const days = Math.round((end - start) / 86400000) + 1;
  return Math.max(1, days);
}

export function isTripActive(trip, now = new Date()) {
  const today = parseDateOnly(toDateInputValue(now));
  return parseDateOnly(trip.startIso) <= today && parseDateOnly(trip.endIso) >= today;
}

export function isTripPast(trip, now = new Date()) {
  const today = parseDateOnly(toDateInputValue(now));
  return parseDateOnly(trip.endIso) < today;
}

export function parseCitiesInput(value) {
  return normalizeCities(String(value || "").split(","));
}

export function citiesToInput(cities = []) {
  return normalizeCities(cities).join(", ");
}

export function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toDateTimeInputValue(iso) {
  const date = new Date(iso || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function fromDateTimeInputValue(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function parseDateOnly(iso) {
  const value = validDateOnly(iso) || todayIso();
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function applyTripMutation(state, mutation) {
  state.tripClocks ||= {};
  state.tripClocks[mutation.entityId] ||= {};
  const clocks = state.tripClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeTrip({ ...mutation.value, id: mutation.entityId });
    let trip = state.trips.find(candidate => candidate.id === mutation.entityId);
    if (!trip) {
      state.trips.push(incoming);
      trip = state.trips[state.trips.length - 1];
    }

    for (const field of TRIP_FIELDS) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        trip[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    clocks._create = maxHlc(clocks._create, mutation.timestamp);
    return true;
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!TRIP_FIELDS.includes(field)) return false;

  let trip = state.trips.find(candidate => candidate.id === mutation.entityId);
  if (!trip) {
    trip = normalizeTrip({ id: mutation.entityId });
    state.trips.push(trip);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  trip[field] = coerceTripField(field, mutation.value);
  clocks[field] = mutation.timestamp;
  return true;
}

function applyEntryMutation(state, mutation) {
  state.entryClocks ||= {};
  state.entryClocks[mutation.entityId] ||= {};
  const clocks = state.entryClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeEntry({ ...mutation.value, id: mutation.entityId });
    let entry = state.entries.find(candidate => candidate.id === mutation.entityId);
    if (!entry) {
      state.entries.push(incoming);
      entry = state.entries[state.entries.length - 1];
    }

    for (const field of ENTRY_FIELDS) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        entry[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    clocks._create = maxHlc(clocks._create, mutation.timestamp);
    return true;
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!ENTRY_FIELDS.includes(field)) return false;

  let entry = state.entries.find(candidate => candidate.id === mutation.entityId);
  if (!entry) {
    entry = normalizeEntry({
      id: mutation.entityId,
      tripId: field === "tripId" ? mutation.value : ""
    });
    state.entries.push(entry);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  const value = coerceEntryField(field, mutation.value);
  entry[field] = value;
  if (field === "description" || field === "body") {
    entry.description = value;
    entry.body = value;
  }
  if (field === "photos") {
    syncEntryPhotoMirror(entry);
  } else if (field.startsWith("photo") && (!Array.isArray(entry.photos) || entry.photos.length <= 1)) {
    entry.photos = normalizeEntryPhotos(null, entry);
  }
  clocks[field] = mutation.timestamp;
  return true;
}

function applyCommentMutation(state, mutation) {
  state.commentClocks ||= {};
  state.commentClocks[mutation.entityId] ||= {};
  const clocks = state.commentClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeComment({ ...mutation.value, id: mutation.entityId });
    let comment = state.comments.find(candidate => candidate.id === mutation.entityId);
    if (!comment) {
      state.comments.push(incoming);
      comment = state.comments[state.comments.length - 1];
    }

    for (const field of COMMENT_FIELDS) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        comment[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    clocks._create = maxHlc(clocks._create, mutation.timestamp);
    return true;
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!COMMENT_FIELDS.includes(field)) return false;

  let comment = state.comments.find(candidate => candidate.id === mutation.entityId);
  if (!comment) {
    comment = normalizeComment({
      id: mutation.entityId,
      entryId: field === "entryId" ? mutation.value : "",
      tripId: field === "tripId" ? mutation.value : ""
    });
    state.comments.push(comment);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  comment[field] = coerceCommentField(field, mutation.value);
  clocks[field] = mutation.timestamp;
  return true;
}

function applyProfileStateMutation(state, mutation) {
  state.profileStateClocks ||= {};
  state.profileStateClocks[mutation.entityId] ||= {};
  const clocks = state.profileStateClocks[mutation.entityId];
  const field = mutation.field;
  if (!isProfileStateField(field)) return false;
  if (!shouldApply(clocks[field], mutation.timestamp)) return false;

  const tripId = tripIdFromActivitySeenField(field);
  if (tripId) {
    state.tripActivitySeenAt ||= {};
    state.tripActivitySeenAt[tripId] = coerceProfileStateField("activitySeenAt", mutation.value);
  } else {
    state[field] = coerceProfileStateField(field, mutation.value);
  }
  clocks[field] = mutation.timestamp;
  return true;
}

function normalizeCities(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(raw
    .map(city => cleanSingleLine(city))
    .filter(Boolean)));
}

function normalizeCollaborators(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];

  for (const item of list) {
    const profileId = String(item?.profileId || item?.id || "").trim();
    const name = normalizeUserName(item?.name);
    const key = profileId || name.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      profileId,
      name,
      joinedAt: validDateTime(item?.joinedAt) || ""
    });
  }

  return result;
}

function tripIdFromActivitySeenField(field) {
  const value = String(field || "");
  if (!value.startsWith(TRIP_ACTIVITY_SEEN_PREFIX)) return "";
  return value.slice(TRIP_ACTIVITY_SEEN_PREFIX.length).trim();
}

function validDateOnly(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? "" : text;
}

function validDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function cleanSingleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function geoNumberOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveIntegerOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function normalizeEntryPhotos(value, legacy = {}) {
  const raw = Array.isArray(value) ? value : [];
  const source = raw.length ? raw : (legacy.photoAssetId ? [legacy] : []);
  const seen = new Set();
  const photos = [];

  for (const item of source) {
    const photo = normalizeEntryPhoto(item);
    if (!photo.photoAssetId || seen.has(photo.photoAssetId)) continue;
    seen.add(photo.photoAssetId);
    photos.push(photo);
  }

  return photos;
}

function normalizeEntryPhoto(input = {}) {
  return {
    photoAssetId: cleanSingleLine(input.photoAssetId),
    photoMime: normalizePhotoMime(input.photoMime),
    photoWidth: positiveIntegerOrNull(input.photoWidth),
    photoHeight: positiveIntegerOrNull(input.photoHeight),
    photoSize: positiveIntegerOrNull(input.photoSize),
    photoUploadedAt: validDateTime(input.photoUploadedAt),
    photoCaption: cleanSingleLine(input.photoCaption)
  };
}

function syncEntryPhotoMirror(entry) {
  const firstPhoto = Array.isArray(entry.photos) ? entry.photos[0] || {} : {};
  entry.photoAssetId = firstPhoto.photoAssetId || "";
  entry.photoMime = firstPhoto.photoMime || "";
  entry.photoWidth = firstPhoto.photoWidth ?? null;
  entry.photoHeight = firstPhoto.photoHeight ?? null;
  entry.photoSize = firstPhoto.photoSize ?? null;
  entry.photoUploadedAt = firstPhoto.photoUploadedAt || "";
}

function normalizeGeotagStatus(value) {
  const status = String(value || "").trim();
  return ["ready", "denied", "unavailable", "error", "skipped"].includes(status) ? status : "";
}

function normalizeViewerAccess(value) {
  return String(value || "").trim().toLowerCase() === "collaborator" ? "collaborator" : "viewer";
}

function normalizeEntryUrl(value) {
  const text = cleanSingleLine(value);
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  return `https://${text}`;
}

function normalizeAbsoluteHttpUrl(value) {
  const text = cleanSingleLine(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizePhotoMime(value) {
  const text = cleanSingleLine(value).toLowerCase();
  if (text.startsWith("image/") || text.startsWith("video/")) return text;
  return "";
}

function coerceTripField(field, value) {
  if (field === "deleted") return Boolean(value);
  if (field === "cities") return normalizeCities(value);
  if (field === "collaborators") return normalizeCollaborators(value);
  if (field === "startIso" || field === "endIso") return validDateOnly(value) || todayIso();
  if (field === "sharedCode") return normalizeCode(value);
  if (field === "ownerProfileId") return String(value || "").trim();
  if (field === "ownerName") return normalizeUserName(value);
  if (field === "title") return cleanSingleLine(value) || "Untitled trip";
  if (field === "dateCreated") return validDateTime(value) || new Date().toISOString();
  if (field === "dateUpdated") return validDateTime(value);
  return cleanSingleLine(value);
}

function coerceEntryField(field, value) {
  if (field === "deleted") return Boolean(value);
  if (field === "lat" || field === "lng" || field === "locationAccuracy") return geoNumberOrNull(value);
  if (field === "timestamp" || field === "dateCreated") return validDateTime(value) || new Date().toISOString();
  if (field === "geotaggedAt" || field === "dateUpdated" || field === "photoUploadedAt") return validDateTime(value);
  if (field === "type") return "entry";
  if (field === "body" || field === "description") return cleanText(value);
  if (field === "url") return normalizeEntryUrl(value);
  if (field === "linkPreviewDescription") return cleanText(value);
  if (field === "linkPreviewImageUrl") return normalizeAbsoluteHttpUrl(value);
  if (field === "photos") return normalizeEntryPhotos(value);
  if (field === "photoMime") return normalizePhotoMime(value);
  if (field === "photoWidth" || field === "photoHeight" || field === "photoSize") return positiveIntegerOrNull(value);
  if (field === "photoAssetId") return cleanSingleLine(value);
  if (field === "tripId") return String(value || "");
  if (field === "geotagStatus") return normalizeGeotagStatus(value);
  if (field === "authorProfileId") return String(value || "").trim();
  if (field === "authorName") return normalizeUserName(value);
  if (field === "visibility") return normalizeEntryVisibility(value);
  return cleanSingleLine(value);
}

function coerceCommentField(field, value) {
  if (field === "deleted") return Boolean(value);
  if (field === "body") return cleanText(value);
  if (field === "entryId" || field === "tripId" || field === "authorProfileId") return String(value || "").trim();
  if (field === "authorName") return normalizeUserName(value);
  if (field === "dateCreated") return validDateTime(value) || new Date().toISOString();
  if (field === "dateUpdated") return validDateTime(value);
  return cleanSingleLine(value);
}

function coerceProfileStateField(field, value) {
  if (field === "activitySeenAt") return validDateTime(value);
  return cleanSingleLine(value);
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? clock.wallTime : 0,
    counter: Number.isFinite(clock?.counter) ? clock.counter : 0
  };
}

function shouldApply(currentTimestamp, incomingTimestamp) {
  return !currentTimestamp || compareHlc(incomingTimestamp, currentTimestamp) >= 0;
}

function maxHlc(left, right) {
  if (!left) return right || "";
  if (!right) return left || "";
  return compareHlc(left, right) >= 0 ? left : right;
}

function isMutationLike(mutation) {
  return Boolean(
    mutation &&
    ENTITY_TYPES.includes(mutation.entityType) &&
    typeof mutation.entityId === "string" &&
    typeof mutation.field === "string" &&
    typeof mutation.timestamp === "string"
  );
}
