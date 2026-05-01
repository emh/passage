import {
  applyMutations,
  applyMutation,
  canViewerSeeEntry,
  COMMENT_FIELDS,
  commentsForEntry,
  compareHlc,
  createComment,
  createId,
  createMutation,
  createEntry,
  createTrip,
  daysBetween,
  ENTRY_FIELDS,
  entriesForTrip,
  fromDateTimeInputValue,
  isTripSharedByOtherProfile,
  isTripActive,
  isTripPast,
  normalizeCode,
  normalizeComment,
  normalizeEntry,
  normalizeEntryVisibility,
  observeHlc,
  normalizeProfile,
  normalizeTrip,
  normalizeUserName,
  normalizeViewer,
  TRIP_FIELDS,
  toDateTimeInputValue,
  tripActivitySeenField,
  visibleComments,
  visibleEntries,
  visibleTrips
} from "./model.js";
import { ensureSharedTripSyncState, loadAppState, loadSettings, saveAppState } from "./storage.js";
import { ensurePhotoObjectUrl, getCachedPhotoUrl, getPhotoAsset, hasPhotoAsset, processPhotoFile, processVideoFile, putPhotoAsset } from "./photos.js";
import { createRemoteProfile, createRemoteTrip, fetchPhotoAsset, fetchRemoteProfile, fetchRemoteTrip, inspectEntryUrl, PassageSync, updateRemoteProfile, uploadPhotoAsset } from "./sync.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TILE_LAYER_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_LAYER_OPTIONS = {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  subdomains: "abcd",
  maxZoom: 19
};
const MARKER_STYLE = {
  radius: 6,
  fillColor: "#8b0000",
  fillOpacity: 0.85,
  color: "#fffff8",
  weight: 2,
  opacity: 1
};

const loadedState = loadAppState();
const settings = loadSettings();
const state = {
  ...loadedState,
  settings,
  syncStatus: settings.syncBaseUrl ? "unlinked" : "local",
  search: "",
  currentTripId: null,
  currentEntryId: null,
  composeEntryId: null,
  editingTripId: null,
  pendingLinkCode: "",
  pendingTripCode: "",
  linkBusy: false,
  linkError: "",
  shareTripId: null,
  shareEntryId: null,
  shareBusy: false,
  shareError: "",
  setupError: "",
  isChangingEntryLocation: false,
  entryLocationDraft: null,
  entryLocationEnabled: true,
  entryLocationQuery: "",
  entryLocationError: "",
  entryFormDraft: null,
  entryPhotoDrafts: [],
  entryPhotoRemovedIds: new Set(),
  entryPhotoError: "",
  entryPhotoNote: "",
  entryUrlMetadataDraft: null,
  entryUrlMetadataRemoved: false,
  entryUrlMetadataStatus: "",
  entryUrlMetadataError: "",
  entryUrlMetadataLastUrl: "",
  entryUrlMetadataRequestId: 0,
  composeInitialSnapshot: null,
  commentDraft: "",
  inlineCommentDrafts: new Map(),
  pendingComment: null,
  selectedCommentId: "",
  editingCommentId: "",
  commentEditDraft: "",
  expandedCommentEntryIds: new Set(),
  activityTripId: "",
  entryReturnTo: "",
  activitySeenAt: loadedState.activitySeenAt || "",
  tripActivitySeenAt: loadedState.tripActivitySeenAt || {},
  confirmation: null,
  geolocationStatus: "checking",
  geolocationMessage: "checking location...",
  locationPermissionAskedAt: loadedState.locationPermissionAskedAt || "",
  locationEntryPermissionAskedAt: loadedState.locationEntryPermissionAskedAt || "",
  lastPosition: null,
  tripSort: "oldest"
};

const $ = id => document.getElementById(id);
let toastTimer;
const overlayFocusStack = [];
let overlayZIndex = 300;
let tripMap = null;
let entryMap = null;
let composeMap = null;
let profileSync = null;
const tripSyncs = new Map();
const photoUploads = new Set();
const photoDownloads = new Set();
const photoTransferStatus = new Map();
const photoRetryTimers = new Map();
let photoWorkScheduled = false;
let entryUrlMetadataTimer = null;

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function cssEscape(value) {
  const text = String(value || "");
  return globalThis.CSS?.escape ? globalThis.CSS.escape(text) : text.replace(/["\\]/g, "\\$&");
}

function save() {
  saveAppState(state);
}

function syncQueue() {
  return state.profileSync?.mutationQueue || [];
}

function saveAndFlushSync() {
  save();
  configureSync();
  profileSync?.flush();
  for (const sync of tripSyncs.values()) sync.flush();
}

function runAction(fn) {
  Promise.resolve(fn()).catch(error => {
    toast(error instanceof Error ? error.message : String(error));
  });
}

function hasProfileName() {
  return Boolean(state.profile?.name);
}

function sharedSyncState(code, tripId = "") {
  return ensureSharedTripSyncState(state, code, tripId);
}

function setSharedTripAccessMode(code, accessMode = "viewer", tripId = "") {
  const syncState = sharedSyncState(code, tripId);
  if (String(accessMode || "").trim().toLowerCase() === "collaborator") {
    syncState.accessMode = "collaborator";
  }
  return syncState;
}

function sharedTripAccessMode(code) {
  return sharedSyncState(code).accessMode === "collaborator" ? "collaborator" : "viewer";
}

function sharedTripViewer(code) {
  return normalizeViewer({
    profileId: state.profile?.id || "",
    name: state.profile?.name || "",
    access: sharedTripAccessMode(code)
  });
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2000);
}

async function initGeolocation() {
  if (!("geolocation" in navigator)) {
    setGeolocationStatus("unavailable", "location unavailable in this browser");
    return;
  }

  setGeolocationStatus("checking", "checking location...");
  let permissionState = "";

  if (navigator.permissions?.query) {
    try {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      permissionState = permission.state;
      updatePermissionStatus(permission.state);
      permission.addEventListener("change", () => {
        updatePermissionStatus(permission.state);
        if (permission.state === "granted") {
          refreshCurrentPosition({ quiet: true });
        }
      });
    } catch {
      // Some browsers expose Permissions but not geolocation queries.
    }
  }

  if (permissionState === "granted") {
    refreshCurrentPosition({ quiet: true });
    return;
  }

  if (permissionState === "denied") return;

  setGeolocationStatus("prompting", "location will be requested when you add an entry");
}

function updatePermissionStatus(permissionState) {
  if (permissionState === "granted") {
    setGeolocationStatus("enabled", state.lastPosition ? "location enabled" : "location enabled; finding position...");
  } else if (permissionState === "denied") {
    setGeolocationStatus("denied", "location denied; entries will save without coordinates");
  } else if (permissionState === "prompt") {
    setGeolocationStatus("prompting", "location will be requested when you add an entry");
  }
}

function setGeolocationStatus(status, message) {
  state.geolocationStatus = status;
  state.geolocationMessage = message;
  renderLocationStatus();
}

function recordLocationPermissionRequest() {
  if (state.locationPermissionAskedAt) return;
  state.locationPermissionAskedAt = new Date().toISOString();
  save();
}

function recordEntryLocationPermissionRequest() {
  if (state.locationEntryPermissionAskedAt) return;
  state.locationEntryPermissionAskedAt = new Date().toISOString();
  save();
}

function renderLocationStatus() {
  const el = $("location-status");
  if (!el) return;
  el.textContent = state.geolocationMessage || "";
}

function syncIndicatorState() {
  const pendingCount = syncQueue().length;
  if (state.syncStatus === "syncing") return { tone: "syncing", label: "syncing" };
  if (state.syncStatus === "synced") return { tone: "synced", label: "synced" };
  if (state.syncStatus === "offline") return { tone: pendingCount ? "pending" : "ready", label: pendingCount ? `${plural(pendingCount, "change")} pending` : "offline" };
  if (pendingCount) return { tone: "pending", label: `${plural(pendingCount, "change")} pending` };
  if (!state.settings.syncBaseUrl) return { tone: "local", label: "local only" };
  if (state.profile?.code) return { tone: "ready", label: "linked" };
  return { tone: "ready", label: "ready to link" };
}

function renderSyncIndicator() {
  const dot = $("sync-dot");
  const link = $("link-device-btn");
  if (!dot || !link) return;

  const indicator = syncIndicatorState();
  dot.classList.toggle("synced", indicator.tone === "synced");
  dot.classList.toggle("pending", indicator.tone === "pending" || indicator.tone === "syncing");
  dot.classList.toggle("ready", indicator.tone === "ready");
  dot.classList.toggle("local", indicator.tone === "local");
  dot.setAttribute("aria-label", indicator.label);
  dot.title = indicator.label;
  link.title = indicator.label;
}

function refreshCurrentPosition(options = {}) {
  if (!("geolocation" in navigator)) {
    setGeolocationStatus("unavailable", "location unavailable in this browser");
    return Promise.resolve(null);
  }

  if (options.requestPermission) recordLocationPermissionRequest();
  if (!options.quiet) setGeolocationStatus("locating", "asking for location...");

  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(position => {
      const capturedAt = new Date().toISOString();
      state.lastPosition = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        capturedAt
      };
      recordLocationPermissionRequest();
      setGeolocationStatus("enabled", `location enabled | +/- ${Math.round(position.coords.accuracy)}m`);
      refreshComposeLocationView();
      resolve(state.lastPosition);
    }, error => {
      const status = error.code === error.PERMISSION_DENIED ? "denied" : "error";
      const message = error.code === error.PERMISSION_DENIED
        ? "location denied; entries will save without coordinates"
        : "location not available; entries will save without coordinates";
      setGeolocationStatus(status, message);
      refreshComposeLocationView();
      resolve(null);
    }, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    });
  });
}

function refreshComposeLocationView() {
  if ($("compose-overlay")?.classList.contains("active")) {
    captureEntryFormDraft();
    renderCompose();
    return;
  }

  requestAnimationFrame(renderComposeMap);
}

async function positionForNewEntry() {
  if (state.geolocationStatus === "denied") return null;
  if (state.locationPermissionAskedAt &&
    !state.lastPosition &&
    state.geolocationStatus !== "enabled") {
    return null;
  }
  if (state.lastPosition && Date.now() - new Date(state.lastPosition.capturedAt).getTime() < 300000) {
    return state.lastPosition;
  }
  return await refreshCurrentPosition({ quiet: true });
}

function requestLocationForNewEntry() {
  if (!("geolocation" in navigator)) return;
  if (state.lastPosition || state.geolocationStatus === "denied") return;
  if (state.locationEntryPermissionAskedAt) return;

  recordEntryLocationPermissionRequest();
  refreshCurrentPosition({ requestPermission: true });
}

async function geocodeAddress(query) {
  const text = String(query || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("enter an address");

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", text);

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) throw new Error(`geocoder returned ${response.status}`);

  const results = await response.json();
  const result = Array.isArray(results) ? results[0] : null;
  const lat = Number(result?.lat);
  const lng = Number(result?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("location not found");
  }

  const address = result.address || {};
  return {
    lat,
    lng,
    locationQuery: text,
    locationDisplayName: String(result.display_name || text).trim(),
    locationCity: cityFromAddress(address),
    locationRegion: String(address.state || address.region || address.province || "").trim(),
    locationCountry: String(address.country || "").trim(),
    locationAccuracy: null,
    geotaggedAt: new Date().toISOString(),
    geotagStatus: "ready"
  };
}

async function reverseGeocodeCoordinates(lat, lng) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) throw new Error(`geocoder returned ${response.status}`);

  const result = await response.json();
  const address = result.address || {};
  return {
    lat,
    lng,
    locationQuery: cityFromAddress(address) || String(result.name || "photo location").trim(),
    locationDisplayName: String(result.display_name || "").trim(),
    locationCity: cityFromAddress(address),
    locationRegion: String(address.state || address.region || address.province || "").trim(),
    locationCountry: String(address.country || "").trim(),
    locationAccuracy: null,
    geotaggedAt: new Date().toISOString(),
    geotagStatus: "ready"
  };
}

function cityFromAddress(address = {}) {
  return String(
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    address.municipality ||
    address.county ||
    ""
  ).trim();
}

function getTrip(id) {
  return visibleTrips(state.trips).find(trip => trip.id === String(id)) || null;
}

function viewerForTrip(trip) {
  return normalizeViewer({
    profileId: state.profile?.id || "",
    name: state.profile?.name || "",
    access: trip?.sharedCode ? sharedTripAccessMode(trip.sharedCode) : "viewer"
  });
}

function canViewEntry(entry, trip = getTrip(entry?.tripId)) {
  return Boolean(entry && trip && canViewerSeeEntry(entry, trip, viewerForTrip(trip)));
}

function allVisibleEntries() {
  return visibleEntries(state.entries).filter(entry => canViewEntry(entry, getTrip(entry.tripId)));
}

function visibleTripEntries(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return [];
  return entriesForTrip(state.entries, trip.id).filter(entry => canViewEntry(entry, trip));
}

function visibleTripEntryCounts(tripId) {
  const count = visibleTripEntries(tripId).length;
  return {
    total: count,
    journals: count
  };
}

function getEntry(id) {
  return allVisibleEntries().find(entry => entry.id === String(id)) || null;
}

function getComment(id) {
  return visibleComments(state.comments).find(comment => comment.id === String(id)) || null;
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function formatDate(iso) {
  if (!iso) return "undated";
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "undated";
  const now = new Date();
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label}, ${date.getFullYear()}`;
}

function formatDateRange(startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00`);
  const end = new Date(`${endIso}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "undated";

  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${MONTHS[start.getMonth()].toUpperCase()} ${start.getDate()} - ${end.getDate()}`;
  }

  return `${MONTHS[start.getMonth()].toUpperCase()} ${start.getDate()} - ${MONTHS[end.getMonth()].toUpperCase()} ${end.getDate()}`;
}

function formatDayLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "UNDATED";
  return `${DAYS[date.getDay()].toUpperCase()} | ${MONTHS[date.getMonth()].toUpperCase()} ${date.getDate()}`;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  let hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, "0");
  const suffix = hour >= 12 ? "pm" : "am";
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute}${suffix}`;
}

function dayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "undated";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function routeCities(trip) {
  return uniqueLabels(visibleTripEntries(trip.id).map(entryRouteLabel).filter(Boolean));
}

function routeLabel(trip) {
  const cities = routeCities(trip);
  return cities.length ? cities.join(" - ") : "no cities yet";
}

function isCurrentProfile(profileId, name = "") {
  const currentId = String(state.profile?.id || "").trim();
  const candidateId = String(profileId || "").trim();
  if (currentId && candidateId) return currentId === candidateId;

  const currentName = normalizeUserName(state.profile?.name || "");
  const candidateName = normalizeUserName(name);
  return Boolean(currentName && candidateName && currentName === candidateName);
}

function isTripOwner(trip) {
  return isCurrentProfile(trip?.ownerProfileId, trip?.ownerName);
}

function tripCollaborators(trip) {
  const ownerId = String(trip?.ownerProfileId || "").trim();
  const ownerName = normalizeUserName(trip?.ownerName);
  return Array.isArray(trip?.collaborators)
    ? trip.collaborators.filter(collaborator => {
      const profileId = String(collaborator?.profileId || "").trim();
      const name = normalizeUserName(collaborator?.name);
      if (ownerId && profileId && ownerId === profileId) return false;
      if (!ownerId && ownerName && name && ownerName === name) return false;
      return Boolean(profileId || name);
    })
    : [];
}

function isTripCollaborator(trip) {
  return tripCollaborators(trip).some(collaborator => isCurrentProfile(collaborator.profileId, collaborator.name));
}

function isReadOnlyTrip(trip) {
  return isTripSharedByOtherProfile(trip, state.profile) && !isTripCollaborator(trip);
}

function isEntryDirectShareable(entry) {
  return normalizeEntryVisibility(entry?.visibility) === "public";
}

function isCommentAuthor(comment) {
  return isCurrentProfile(comment?.authorProfileId, comment?.authorName);
}

function canEditComment(comment) {
  return isCommentAuthor(comment);
}

function canDeleteComment(comment) {
  return isCommentAuthor(comment) || isTripOwner(getTrip(comment?.tripId));
}

function canManageEntry(entry) {
  return isTripOwner(getTrip(entry?.tripId)) || isCurrentProfile(entry?.authorProfileId, entry?.authorName);
}

function tripSharedByLabel(trip) {
  if (!trip?.sharedCode || !trip?.ownerName) return "";
  if (!isReadOnlyTrip(trip)) return "";
  return `shared by ${trip.ownerName}`;
}

function tripParticipantNames(trip) {
  if (!tripCollaborators(trip).length) return [];
  return uniqueLabels([
    trip?.ownerName || "",
    ...tripCollaborators(trip).map(collaborator => collaborator.name)
  ].filter(Boolean));
}

function tripParticipantsLabel(trip) {
  return tripParticipantNames(trip).join(", ");
}

function renderTripParticipants(trip) {
  const label = tripParticipantsLabel(trip);
  return label ? `<div class="trip-participants">${esc(label)}</div>` : "";
}

function entryRouteLabel(entry) {
  return entry.locationCity ||
    entry.locationQuery ||
    firstDisplayNamePart(entry.locationDisplayName);
}

function firstDisplayNamePart(value) {
  return String(value || "").split(",")[0]?.trim() || "";
}

function uniqueLabels(labels) {
  const seen = new Set();
  const result = [];
  for (const label of labels) {
    const clean = String(label || "").replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function statusLabel(trip) {
  if (isTripActive(trip)) return "NOW";
  if (isTripPast(trip)) return "PAST";
  return "PLANNED";
}

function hasGeotag(entry) {
  return Number.isFinite(entry.lat) && Number.isFinite(entry.lng);
}

function entryLocationLabel(entry) {
  if (entry.locationQuery) return entry.locationQuery;
  if (entry.locationDisplayName) return entry.locationDisplayName;
  if (hasGeotag(entry)) return `${entry.lat.toFixed(5)}, ${entry.lng.toFixed(5)}`;
  if (entry.geotagStatus === "denied") return "location denied";
  if (entry.geotagStatus === "unavailable" || entry.geotagStatus === "error") return "location unavailable";
  return "";
}

function tripAuthors(tripId) {
  return uniqueLabels(visibleTripEntries(tripId).map(entry => entry.authorName).filter(Boolean));
}

function showEntryAuthors(tripId) {
  return visibleTripEntries(tripId)
    .some(entry => entry.authorName && !isCurrentProfile(entry.authorProfileId, entry.authorName));
}

function entryVisibilityLabel(entry) {
  const visibility = normalizeEntryVisibility(entry?.visibility);
  if (visibility === "private") return "PRIVATE";
  if (visibility === "collaborators") return "COLLABORATORS";
  return "";
}

function entryMetaLine(entry, options = {}) {
  const parts = [];
  const visibility = entryVisibilityLabel(entry);
  if (visibility) parts.push(visibility);
  if (options.includeAuthor && entry.authorName && !isCurrentProfile(entry.authorProfileId, entry.authorName)) {
    parts.push(entry.authorName);
  }
  if (options.includeDate) parts.push(formatDate(entry.timestamp.slice(0, 10)));
  parts.push(formatTime(entry.timestamp));
  const location = options.shortLocation ? entryRouteLabel(entry) : entryLocationLabel(entry);
  if (location) parts.push(location);
  return parts.filter(Boolean).join(" | ");
}

function entryDescription(entry) {
  return entry?.description || entry?.body || "";
}

function entryHasPhoto(entry) {
  return entryPhotos(entry).length > 0;
}

function entryUrlLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function validEntryUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`).toString();
  } catch {
    return "";
  }
}

function validHttpEntryUrl(value) {
  const url = validEntryUrl(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function entryUrlReadyForLookup(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text) && !text.includes(".")) return "";
  return validHttpEntryUrl(text);
}

function sameEntryUrl(left, right) {
  const a = validHttpEntryUrl(left);
  const b = validHttpEntryUrl(right);
  return Boolean(a && b && a === b);
}

function cleanPreviewText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizePreviewImageUrl(value) {
  const text = cleanPreviewText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizeLinkPreview(input = {}, fallbackUrl = "") {
  const url = validHttpEntryUrl(input.url || fallbackUrl);
  const preview = {
    url,
    title: cleanPreviewText(input.title),
    description: cleanPreviewText(input.description),
    imageUrl: normalizePreviewImageUrl(input.imageUrl)
  };
  return hasLinkPreview(preview) ? preview : null;
}

function hasLinkPreview(preview) {
  return Boolean(preview?.title || preview?.description || preview?.imageUrl);
}

function entryLinkPreview(entry) {
  if (!entry) return null;
  return normalizeLinkPreview({
    url: entry.url,
    title: entry.linkPreviewTitle,
    description: entry.linkPreviewDescription,
    imageUrl: entry.linkPreviewImageUrl
  }, entry.url);
}

function currentLinkPreview(entry, rawUrl = "") {
  const url = validHttpEntryUrl(rawUrl || state.entryFormDraft?.url || entry?.url || "");
  if (!url || state.entryUrlMetadataRemoved) return null;
  if (state.entryUrlMetadataDraft && sameEntryUrl(state.entryUrlMetadataDraft.url, url)) {
    return state.entryUrlMetadataDraft;
  }

  const existing = entryLinkPreview(entry);
  if (existing && sameEntryUrl(existing.url, url)) return existing;
  return null;
}

function linkPreviewFields(preview) {
  return {
    linkPreviewTitle: preview?.title || "",
    linkPreviewDescription: preview?.description || "",
    linkPreviewImageUrl: preview?.imageUrl || ""
  };
}

function linkPreviewSignature(preview) {
  if (!preview) return "";
  return JSON.stringify({
    title: preview.title || "",
    description: preview.description || "",
    imageUrl: preview.imageUrl || ""
  });
}

function normalizeInspectedLinkPreview(payload, url) {
  const metadata = payload?.metadata || {};
  return normalizeLinkPreview({
    url,
    title: metadata.title,
    description: metadata.description,
    imageUrl: metadata.imageUrl
  }, url);
}

function entryHasRequiredContent({ title = "", description = "", url = "", hasPhoto = false } = {}) {
  return Boolean(
    String(title || "").trim() ||
    String(description || "").trim() ||
    validEntryUrl(url) ||
    hasPhoto
  );
}

function entryPhotos(entry) {
  const photos = Array.isArray(entry?.photos) ? entry.photos : [];
  if (photos.length) return photos.filter(photo => photo?.photoAssetId);
  return entry?.photoAssetId ? [{
    photoAssetId: entry.photoAssetId,
    photoMime: entry.photoMime || "",
    photoWidth: entry.photoWidth || null,
    photoHeight: entry.photoHeight || null,
    photoSize: entry.photoSize || null,
    photoUploadedAt: entry.photoUploadedAt || ""
  }] : [];
}

function photoFieldsFromList(photos = []) {
  const normalized = photos
    .filter(photo => photo?.photoAssetId)
    .map(photo => ({
      photoAssetId: photo.photoAssetId || "",
      photoMime: photo.photoMime || "",
      photoWidth: photo.photoWidth || null,
      photoHeight: photo.photoHeight || null,
      photoSize: photo.photoSize || null,
      photoUploadedAt: photo.photoUploadedAt || ""
    }));
  const first = normalized[0] || {};

  return {
    photos: normalized,
    photoAssetId: first.photoAssetId || "",
    photoMime: first.photoMime || "",
    photoWidth: first.photoWidth || null,
    photoHeight: first.photoHeight || null,
    photoSize: first.photoSize || null,
    photoUploadedAt: first.photoUploadedAt || ""
  };
}

function photoListSignature(photos = []) {
  return JSON.stringify(photos.map(photo => ({
    photoAssetId: photo.photoAssetId || "",
    photoUploadedAt: photo.photoUploadedAt || ""
  })));
}

function renderConfirmation() {
  const root = $("confirm-root");
  if (!root) return;

  const confirmation = state.confirmation;
  if (!confirmation) {
    root.innerHTML = "";
    return;
  }

  root.innerHTML = `
    <div class="confirm-toast" role="status" aria-live="polite">
      <span>${esc(confirmation.message)}</span>
      <button class="action-link destructive" data-action="confirm-toast-yes" type="button">YES</button>
      <button class="action-link secondary" data-action="confirm-toast-no" id="confirm-toast-no" type="button">NO</button>
    </div>
  `;
}

function openConfirmation(view, message, action, contextId = "") {
  state.confirmation = {
    view,
    message,
    action,
    contextId: String(contextId || "")
  };
  renderConfirmation();
}

function clearConfirmation(view = "") {
  if (!view || state.confirmation?.view === view) {
    state.confirmation = null;
    renderConfirmation();
  }
}

function photoStatus(photo) {
  const assetId = photo?.photoAssetId || "";
  if (!assetId) return { label: "", tone: "" };
  const kind = (photo?.photoMime || "").startsWith("video/") ? "video" : "photo";

  const transfer = photoTransferStatus.get(assetId);
  if (transfer?.status === "upload-failed") return { label: `${kind} upload failed - retrying`, tone: "error" };
  if (transfer?.status === "download-failed") return { label: `${kind} download failed - retrying`, tone: "error" };
  if (photoUploads.has(assetId)) return { label: `uploading ${kind}...`, tone: "pending" };
  if (photoDownloads.has(assetId)) return { label: `downloading ${kind}...`, tone: "pending" };

  const cached = Boolean(getCachedPhotoUrl(assetId));
  if (!photo.photoUploadedAt && cached && state.settings.syncBaseUrl) return { label: `${kind} pending upload`, tone: "pending" };
  if (!photo.photoUploadedAt && cached) return { label: `${kind} saved locally`, tone: "local" };
  if (photo.photoUploadedAt && cached) return { label: `${kind} cached`, tone: "ready" };
  if (photo.photoUploadedAt) return { label: `${kind} ready to download`, tone: "pending" };
  return { label: `${kind} pending upload`, tone: "pending" };
}

function setPhotoTransferStatus(assetId, status, error = "") {
  const id = String(assetId || "");
  if (!id) return;

  if (status) {
    photoTransferStatus.set(id, {
      status,
      error: error instanceof Error ? error.message : String(error || "")
    });
    schedulePhotoRetry(id);
    return;
  }

  photoTransferStatus.delete(id);
  clearTimeout(photoRetryTimers.get(id));
  photoRetryTimers.delete(id);
}

function schedulePhotoRetry(assetId) {
  const id = String(assetId || "");
  if (!id || photoRetryTimers.has(id)) return;

  const timer = setTimeout(() => {
    photoRetryTimers.delete(id);
    schedulePhotoWork();
  }, 12000);
  photoRetryTimers.set(id, timer);
}

function currentPositionLabel() {
  if (state.lastPosition) return `${state.lastPosition.lat.toFixed(5)}, ${state.lastPosition.lng.toFixed(5)}`;
  return state.geolocationMessage || "location status unknown";
}

function queueLocalMutation(entityType, entityId, field, value, options = {}) {
  const trip = tripForLocalMutation(entityType, entityId, value);
  if (!options.skipWritableCheck && (entityType === "trip" || entityType === "entry")) {
    assertTripWritable(trip);
  }

  const mutation = createMutation(state, entityType, entityId, field, value);
  if (applyMutation(state, mutation)) {
    syncQueue().push(mutation);
    const code = sharedCodeForMutation(entityType, entityId, value);
    if (code) {
      const tripId = tripIdForMutation(entityType, entityId, value);
      sharedSyncState(code, tripId).mutationQueue.push(mutation);
    }
  }
  return mutation;
}

function tripForLocalMutation(entityType, entityId, value) {
  if (entityType === "trip") {
    return getTrip(entityId) || state.trips.find(candidate => candidate.id === String(entityId)) || normalizeTrip(value);
  }

  const tripId = tripIdForMutation(entityType, entityId, value);
  return tripId ? getTrip(tripId) || state.trips.find(candidate => candidate.id === tripId) || null : null;
}

function assertTripWritable(trip) {
  if (trip && isReadOnlyTrip(trip)) throw new Error("Shared trips are read only for now.");
}

function queueEntityCreate(entityType, record) {
  return queueLocalMutation(entityType, record.id, "_create", record);
}

function queueEntityPatch(entityType, currentRecord, nextRecord, fields) {
  let changed = 0;
  for (const field of fields) {
    if (field === "id") continue;
    if (valuesEqual(currentRecord[field], nextRecord[field])) continue;
    queueLocalMutation(entityType, currentRecord.id, field, nextRecord[field]);
    changed += 1;
  }
  return changed;
}

function valuesEqual(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

function sharedCodeForMutation(entityType, entityId, value) {
  if (entityType === "trip") {
    const trip = getTrip(entityId) || state.trips.find(candidate => candidate.id === String(entityId));
    if (trip?.sharedCode) return trip.sharedCode;
    const code = normalizeCode(value?.sharedCode);
    return code || "";
  }

  const tripId = tripIdForMutation(entityType, entityId, value);
  const trip = tripId ? getTrip(tripId) || state.trips.find(candidate => candidate.id === tripId) : null;
  return trip?.sharedCode || "";
}

function tripIdForMutation(entityType, entityId, value) {
  if (entityType === "trip") return String(entityId || "");
  if (value?.tripId) return String(value.tripId || "");

  if (entityType === "comment") {
    const comment = getComment(entityId) || state.comments.find(candidate => candidate.id === String(entityId));
    return comment?.tripId || "";
  }

  const entry = getEntry(entityId) || state.entries.find(candidate => candidate.id === String(entityId));
  return entry?.tripId || String(value?.tripId || "");
}

function schedulePhotoWork() {
  if (photoWorkScheduled) return;
  photoWorkScheduled = true;
  setTimeout(() => {
    photoWorkScheduled = false;
    refreshPhotoAssets().catch(() => {});
  }, 0);
}

async function refreshPhotoAssets() {
  const entries = allVisibleEntries().filter(entryHasPhoto);
  await Promise.all(entries.map(async entry => {
    await Promise.all(entryPhotos(entry).map(async photo => {
      await ensureEntryPhotoCached(photo);
      await uploadPendingPhotoForEntryPhoto(entry, photo);
    }));
  }));
}

async function ensureEntryPhotoCached(photo) {
  const assetId = photo?.photoAssetId || "";
  if (!assetId || getCachedPhotoUrl(assetId) || photoDownloads.has(assetId)) return;
  if (photoTransferStatus.get(assetId)?.status === "download-failed" && photoRetryTimers.has(assetId)) return;

  photoDownloads.add(assetId);
  setPhotoTransferStatus(assetId, "");
  try {
    if (!(await hasPhotoAsset(assetId))) {
      if (!photo.photoUploadedAt || !state.settings.syncBaseUrl) return;
      const blob = await fetchPhotoAsset(assetId, state.settings);
      await putPhotoAsset(assetId, blob);
    }

    await ensurePhotoObjectUrl(assetId);
    renderAll();
    syncOpenViews();
  } catch (error) {
    setPhotoTransferStatus(assetId, "download-failed", error);
  } finally {
    photoDownloads.delete(assetId);
    renderAll();
    syncOpenViews();
  }
}

async function uploadPendingPhotoForEntryPhoto(entry, photo) {
  const assetId = photo?.photoAssetId || "";
  if (!assetId || photo.photoUploadedAt || !state.settings.syncBaseUrl || photoUploads.has(assetId)) return;
  if (photoTransferStatus.get(assetId)?.status === "upload-failed" && photoRetryTimers.has(assetId)) return;

  photoUploads.add(assetId);
  setPhotoTransferStatus(assetId, "");
  try {
    const asset = await getPhotoAsset(assetId);
    if (!asset?.blob) return;

    const payload = await uploadPhotoAsset(assetId, asset.blob, state.settings);
    const current = getEntry(entry.id);
    const currentPhotos = entryPhotos(current);
    if (currentPhotos.some(candidate => candidate.photoAssetId === assetId && !candidate.photoUploadedAt)) {
      const uploadedAt = payload.uploadedAt || new Date().toISOString();
      const nextPhotos = currentPhotos.map(candidate => candidate.photoAssetId === assetId
        ? { ...candidate, photoUploadedAt: uploadedAt }
        : candidate);
      queueEntryPhotoListUpdate(current, nextPhotos);
      saveAndFlushSync();
      renderAll();
      syncOpenViews();
    }
  } catch (error) {
    setPhotoTransferStatus(assetId, "upload-failed", error);
  } finally {
    photoUploads.delete(assetId);
    renderAll();
    syncOpenViews();
  }
}

function queueEntryPhotoListUpdate(entry, photos) {
  if (!entry) return;
  const fields = photoFieldsFromList(photos);
  queueLocalMutation("entry", entry.id, "photos", fields.photos);
  for (const field of ["photoAssetId", "photoMime", "photoWidth", "photoHeight", "photoSize", "photoUploadedAt"]) {
    if (!valuesEqual(entry[field], fields[field])) {
      queueLocalMutation("entry", entry.id, field, fields[field]);
    }
  }
}

function geotaggedEntriesForTrip(tripId) {
  return visibleTripEntries(tripId).filter(hasGeotag);
}

function leaflet() {
  return globalThis.L || null;
}

function destroyMap(map) {
  if (map) map.remove();
  return null;
}

function renderMapUnavailable(container, message = "map unavailable") {
  if (!container) return;
  container.innerHTML = `<div class="map-empty">${esc(message)}</div>`;
}

function createBaseMap(container, options = {}) {
  const Leaflet = leaflet();
  if (!Leaflet || !container) return null;

  container.innerHTML = "";
  const map = Leaflet.map(container, {
    zoomControl: Boolean(options.zoomControl),
    attributionControl: true
  });

  Leaflet.tileLayer(TILE_LAYER_URL, TILE_LAYER_OPTIONS).addTo(map);
  return map;
}

function fitMapToPoints(map, points, maxZoom = 15) {
  const Leaflet = leaflet();
  if (!Leaflet || !map || !points.length) return;

  const container = map.getContainer();
  requestAnimationFrame(() => {
    if (!container.isConnected) return;
    map.invalidateSize();
    if (points.length === 1) {
      map.setView(points[0], maxZoom);
      return;
    }

    map.fitBounds(Leaflet.latLngBounds(points), {
      padding: [28, 28],
      maxZoom
    });
  });
}

function renderSinglePointMap({ container, point, label, accuracy, zoom = 15 }) {
  const Leaflet = leaflet();
  if (!Leaflet) {
    renderMapUnavailable(container);
    return null;
  }

  const map = createBaseMap(container);
  if (!map) return null;

  Leaflet.circleMarker(point, MARKER_STYLE)
    .bindTooltip(esc(label), {
      className: "entry-tooltip",
      direction: "top",
      offset: [0, -6]
    })
    .addTo(map);

  if (Number.isFinite(accuracy) && accuracy > 0) {
    Leaflet.circle(point, {
      radius: accuracy,
      color: "#8b0000",
      weight: 1,
      opacity: 0.25,
      fillColor: "#8b0000",
      fillOpacity: 0.05
    }).addTo(map);
  }

  fitMapToPoints(map, [point], zoom);
  return map;
}

function renderTripMap(tripId) {
  const container = $("trip-map");
  if (!container) return;

  tripMap = destroyMap(tripMap);
  const Leaflet = leaflet();
  if (!Leaflet) {
    renderMapUnavailable(container);
    return;
  }

  const entries = geotaggedEntriesForTrip(tripId);
  if (!entries.length) {
    renderMapUnavailable(container, "no located entries yet");
    return;
  }

  tripMap = createBaseMap(container);
  if (!tripMap) return;

  const points = entries.map(entry => [entry.lat, entry.lng]);
  if (points.length > 1) {
    Leaflet.polyline(points, {
      color: "#8b0000",
      weight: 1.2,
      opacity: 0.55,
      dashArray: "3,4"
    }).addTo(tripMap);
  }

  for (const entry of entries) {
    const point = [entry.lat, entry.lng];
    const title = entry.title || formatDayLabel(entry.timestamp);
    const marker = Leaflet.circleMarker(point, MARKER_STYLE);
    marker.bindTooltip(
      `<strong>${esc(title)}</strong><br><span style="color:#999;font-family:var(--mono);font-size:10.5px;">${esc(formatTime(entry.timestamp))}</span>`,
      {
        className: "entry-tooltip",
        direction: "top",
        offset: [0, -6]
      }
    );
    marker.on("click", () => openEntry(entry.id));
    marker.addTo(tripMap);
  }

  fitMapToPoints(tripMap, points, 10);
}

function renderEntryMap(entryId) {
  const container = $("entry-map");
  entryMap = destroyMap(entryMap);
  if (!container) return;

  const entry = getEntry(entryId);
  if (!entry || !hasGeotag(entry)) return;

  entryMap = renderSinglePointMap({
    container,
    point: [entry.lat, entry.lng],
    label: entry.title || "entry",
    accuracy: entry.locationAccuracy,
    zoom: 15
  });
}

function renderComposeMap() {
  const container = $("compose-location-map");
  composeMap = destroyMap(composeMap);
  if (!container) return;

  const entry = state.composeEntryId ? getEntry(state.composeEntryId) : null;
  if (!isComposeLocationEnabled(entry)) {
    renderMapUnavailable(container, "location tagging off for this entry");
    return;
  }

  if (state.entryLocationDraft && hasGeotag(state.entryLocationDraft)) {
    composeMap = renderSinglePointMap({
      container,
      point: [state.entryLocationDraft.lat, state.entryLocationDraft.lng],
      label: state.entryLocationDraft.locationQuery || "new location",
      accuracy: state.entryLocationDraft.locationAccuracy,
      zoom: 15
    });
    return;
  }

  if (entry && hasGeotag(entry)) {
    composeMap = renderSinglePointMap({
      container,
      point: [entry.lat, entry.lng],
      label: entry.title || "saved location",
      accuracy: entry.locationAccuracy,
      zoom: 15
    });
    return;
  }

  if (state.lastPosition) {
    composeMap = renderSinglePointMap({
      container,
      point: [state.lastPosition.lat, state.lastPosition.lng],
      label: "current location",
      accuracy: state.lastPosition.accuracy,
      zoom: 15
    });
    return;
  }

  renderMapUnavailable(container, state.geolocationMessage || "waiting for current location");
}

function filteredTrips() {
  const query = state.search.trim().toLowerCase();
  const list = visibleTrips(state.trips).filter(trip => {
    if (!query) return true;
    const haystack = `${trip.title} ${routeCities(trip).join(" ")}`.toLowerCase();
    return haystack.includes(query);
  });

  return list.sort((left, right) => new Date(`${right.startIso}T00:00:00`) - new Date(`${left.startIso}T00:00:00`));
}

function renderStats() {
  const trips = visibleTrips(state.trips);
  const entries = allVisibleEntries().filter(entry => trips.some(trip => trip.id === entry.tripId));
  const cities = new Set();
  for (const trip of trips) {
    for (const city of routeCities(trip)) cities.add(city);
  }

  $("stats").textContent = `${plural(trips.length, "trip")} | ${plural(entries.length, "entry", "entries")} | ${plural(cities.size, "city", "cities")}`;
}

function renderList() {
  const list = filteredTrips();
  const container = $("trip-list");
  const empty = $("empty-state");

  if (!list.length) {
    container.innerHTML = "";
    empty.hidden = false;
    empty.textContent = state.search ? "no matches." : "no trips yet - write one above.";
    return;
  }

  empty.hidden = true;
  container.innerHTML = list.map(trip => {
    const counts = visibleTripEntryCounts(trip.id);
    const active = isTripActive(trip);
    const past = isTripPast(trip);
    const days = daysBetween(trip.startIso, trip.endIso);
    const sharedBy = tripSharedByLabel(trip);
    const participants = tripParticipantsLabel(trip);
    const activity = renderTripCardActivity(trip);

    return `
      <article class="trip-item ${past ? "past" : ""}" data-trip-id="${esc(trip.id)}">
        <div class="trip-meta">
          <span>${esc(formatDateRange(trip.startIso, trip.endIso))} | ${plural(days, "day").toUpperCase()} | ${esc(plural(counts.total, "entry", "entries").toUpperCase())}</span>
          <span class="right">${esc(active ? "NOW" : statusLabel(trip))}${activity ? ` | ${activity}` : ""}</span>
        </div>
        <h2 class="trip-title">${esc(trip.title)}</h2>
        <div class="trip-route">${esc(routeLabel(trip))}</div>
        ${sharedBy ? `<div class="trip-shared-by">${esc(sharedBy)}</div>` : ""}
        ${participants ? `<div class="trip-participants">${esc(participants)}</div>` : ""}
      </article>
    `;
  }).join("");
}

function entryComments(entryId) {
  const entry = getEntry(entryId);
  if (!entry || !canViewEntry(entry)) return [];
  return commentsForEntry(state.comments, entryId);
}

function formatActivityTime(iso) {
  const date = new Date(iso || "");
  if (Number.isNaN(date.getTime())) return "";
  const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${formatDate(localDate)} | ${formatTime(iso)}`;
}

function activityItems(tripId = "") {
  const filterTripId = String(tripId || "").trim();
  const entriesById = new Map(allVisibleEntries().map(entry => [entry.id, entry]));
  const tripsById = new Map(visibleTrips(state.trips).map(trip => [trip.id, trip]));
  const items = [];

  for (const entry of allVisibleEntries()) {
    if (filterTripId && entry.tripId !== filterTripId) continue;
    const trip = tripsById.get(entry.tripId);
    if (!trip) continue;
    items.push({
      id: entry.id,
      type: "entry",
      dateCreated: entry.dateCreated || entry.timestamp,
      authorName: entry.authorName,
      authorProfileId: entry.authorProfileId,
      body: entry.title || firstLine(entryDescription(entry)),
      entry,
      trip
    });
  }

  for (const comment of visibleComments(state.comments)) {
    if (filterTripId && comment.tripId !== filterTripId) continue;
    const entry = entriesById.get(comment.entryId);
    const trip = tripsById.get(comment.tripId);
    if (!entry || !trip) continue;
    items.push({
      id: comment.id,
      type: "comment",
      dateCreated: comment.dateCreated,
      authorName: comment.authorName,
      authorProfileId: comment.authorProfileId,
      body: comment.body,
      entry,
      trip
    });
  }

  return items.sort((left, right) => new Date(right.dateCreated) - new Date(left.dateCreated));
}

function entryActivityPhrase(entry) {
  const title = firstLine(entry?.title || "");
  const description = firstLine(entryDescription(entry));
  if (title) return `posted ${title}`;
  if (description) return `posted ${description}`;
  if (entryHasPhoto(entry) && !entry?.url) return "posted a photo";
  if (entry?.url) return `posted ${entryUrlLabel(entry.url)}`;
  if (entryHasPhoto(entry)) return "posted a photo";
  return "posted an entry";
}

function activityLineParts(item) {
  return {
    time: formatActivityTime(item.dateCreated),
    author: item.authorName || "Someone",
    action: item.type === "entry"
      ? entryActivityPhrase(item.entry)
      : `commented ${firstLine(item.body) || "on an entry"}`
  };
}

function tripSeenAt(tripId) {
  return state.tripActivitySeenAt?.[tripId] || state.activitySeenAt || "";
}

function unseenActivityCount(tripId) {
  const id = String(tripId || "").trim();
  if (!id) return 0;
  const seenAt = Date.parse(tripSeenAt(id)) || 0;
  return activityItems(id).filter(item => {
    if (isCurrentProfile(item.authorProfileId, item.authorName)) return false;
    return (Date.parse(item.dateCreated || "") || 0) > seenAt;
  }).length;
}

function renderActivityIndicator() {
  const button = $("activity-btn");
  const badge = $("activity-badge");
  if (!button || !badge) return;

  button.hidden = true;
  badge.hidden = true;
  badge.textContent = "";
  button.title = "";
}

function markActivitySeen(tripId) {
  const profileId = String(state.profile?.id || "").trim();
  const id = String(tripId || "").trim();
  if (!profileId || !id) return;
  const seenAt = new Date().toISOString();
  queueLocalMutation("profileState", profileId, tripActivitySeenField(id), seenAt);
  saveAndFlushSync();
}

function renderActivityScreen() {
  const body = $("activity-body");
  if (!body) return;

  const trip = getTrip(state.activityTripId);
  const items = activityItems(state.activityTripId);
  body.innerHTML = `
    <button class="back-btn" data-action="activity-back" type="button">BACK</button>
    <h2 class="screen-title">Activity</h2>
    ${trip ? `<div class="trip-route" style="margin-bottom:20px;">${esc(trip.title)}</div>` : ""}
    ${items.length ? `
      <div class="activity-list">
        ${items.map(renderActivityItem).join("")}
      </div>
    ` : '<div class="empty-state">no activity yet.</div>'}
  `;
}

function renderActivityItem(item) {
  const parts = activityLineParts(item);
  return `
    <button class="activity-item" data-action="open-activity-entry" data-entry-id="${esc(item.entry.id)}" type="button">
      <span class="activity-line">
        <span class="activity-line-stamp">${esc(parts.time)}</span>
        <span class="activity-line-author">${esc(parts.author)}</span>
        <span class="activity-line-action">${esc(parts.action)}</span>
      </span>
    </button>
  `;
}

function activityCountText(count) {
  return count > 99 ? "99+" : String(count);
}

function renderTripCardActivity(trip) {
  const count = unseenActivityCount(trip.id);
  if (!count) return "";
  return `
    <button class="action-link activity-link trip-card-activity" data-action="open-trip-activity" data-trip-id="${esc(trip.id)}" type="button" aria-label="${esc(plural(count, "new activity item"))}">
      <span class="activity-badge">${esc(activityCountText(count))}</span>
    </button>
  `;
}

function renderTripActivityButton(trip) {
  const count = unseenActivityCount(trip.id);
  return `
    <button class="action-link activity-link title-action trip-activity-link" data-action="open-trip-activity" data-trip-id="${esc(trip.id)}" type="button" aria-label="${esc(count ? plural(count, "new activity item") : "activity")}">
      <span class="activity-badge">${esc(activityCountText(count))}</span>
    </button>
  `;
}

function firstLine(value) {
  return String(value || "").split("\n").map(part => part.trim()).filter(Boolean)[0] || "";
}

function openActivityScreen(options = {}) {
  const tripId = String(options.tripId || state.activityTripId || state.currentTripId || "").trim();
  state.activityTripId = tripId;
  if (options.markSeen !== false) markActivitySeen(tripId);
  renderActivityIndicator();
  renderList();
  if ($("trip-overlay").classList.contains("active") && state.currentTripId) renderTrip();
  renderActivityScreen();
  openOverlay("activity-overlay");
  requestAnimationFrame(() => $("activity-body")?.focus());
}

function closeActivityScreen() {
  closeOverlay("activity-overlay");
}

function openActivityEntry(entryId) {
  const entry = getEntry(entryId);
  if (!entry) {
    toast("entry is no longer available");
    return;
  }

  state.currentTripId = entry.tripId;
  openEntry(entry.id, { returnTo: "activity" });
}

function renderAll() {
  renderLocationStatus();
  renderSyncIndicator();
  renderActivityIndicator();
  renderStats();
  renderList();
  schedulePhotoWork();
}

function renderSetupScreen() {
  $("setup-body").innerHTML = `
    <h2 class="screen-title">Your name</h2>
    <div class="trip-route" style="margin-bottom:20px;">shown when you share or write in a shared trip</div>

    <label class="field">
      <span class="field-label">Name</span>
      <input class="field-input" id="setup-name-input" value="${esc(state.profile?.name || "")}" autocomplete="name" placeholder="your name">
      ${state.setupError ? `<span class="field-helper accent">${esc(state.setupError)}</span>` : ""}
    </label>

    <div class="action-row">
      <button class="action-link" data-action="save-setup-name" type="button">SAVE</button>
    </div>
  `;
}

function openSetupScreen() {
  if ($("setup-overlay").classList.contains("active")) {
    renderSetupScreen();
    return;
  }
  renderSetupScreen();
  openOverlay("setup-overlay");
  requestAnimationFrame(() => $("setup-name-input")?.focus());
}

function closeSetupScreen() {
  closeOverlay("setup-overlay");
}

function mergeProfile(currentProfile, incomingProfile, code = "") {
  const current = normalizeProfile(currentProfile);
  const incoming = normalizeProfile(incomingProfile);
  const next = normalizeProfile({
    id: incoming?.id || current?.id || "",
    name: incoming?.name || current?.name || "",
    code: code || incoming?.code || current?.code || ""
  });
  return next || current || incoming || null;
}

function backfillProfileIdentity() {
  const profileId = state.profile?.id || "";
  const profileName = state.profile?.name || "";
  if (!profileId || !profileName) return;

  for (const trip of visibleTrips(state.trips)) {
    if (trip.ownerProfileId && trip.ownerProfileId !== profileId) continue;
    const nextTrip = normalizeTrip({
      ...trip,
      ownerProfileId: profileId,
      ownerName: profileName
    });
    queueEntityPatch("trip", trip, nextTrip, TRIP_FIELDS);
  }

  for (const entry of allVisibleEntries()) {
    if (entry.authorProfileId && entry.authorProfileId !== profileId) continue;
    const nextEntry = normalizeEntry({
      ...entry,
      authorProfileId: profileId,
      authorName: profileName
    });
    queueEntityPatch("entry", entry, nextEntry, ENTRY_FIELDS);
  }

  for (const comment of visibleComments(state.comments)) {
    if (comment.authorProfileId && comment.authorProfileId !== profileId) continue;
    const nextComment = normalizeComment({
      ...comment,
      authorProfileId: profileId,
      authorName: profileName
    });
    queueEntityPatch("comment", comment, nextComment, COMMENT_FIELDS);
  }

}

async function saveSetupName() {
  const name = normalizeUserName($("setup-name-input")?.value || "");
  if (!name) {
    state.setupError = "name required";
    renderSetupScreen();
    requestAnimationFrame(() => $("setup-name-input")?.focus());
    return;
  }

  state.setupError = "";
  state.profile = normalizeProfile({
    ...state.profile,
    name
  });
  backfillProfileIdentity();
  saveAndFlushSync();
  closeSetupScreen();
  renderAll();
  savePendingComment();
  handleIncomingQueries();

  if (state.profile?.code) {
    const payload = await updateRemoteProfile(state.profile, state.settings);
    state.profile = mergeProfile(state.profile, payload?.profile || payload?.room?.profile, payload?.code || payload?.room?.code || state.profile.code);
    save();
    renderAll();
  }
}

function hasLocalContent() {
  return Boolean(
    visibleTrips(state.trips).length ||
    allVisibleEntries().length ||
    syncQueue().length ||
    Object.values(state.sharedTripSync || {}).some(syncState => syncState.mutationQueue?.length > 0)
  );
}

function applyRemotePayload(payload, options = {}) {
  if (options.replaceLocal) {
    state.trips = [];
    state.entries = [];
    state.comments = [];
    state.tripClocks = {};
    state.entryClocks = {};
    state.commentClocks = {};
    state.profileStateClocks = {};
    state.profileSync.mutationQueue = [];
    state.profileSync.lastSyncTimestamp = "";
    state.sharedTripSync = {};
  }

  if (Array.isArray(payload?.mutations)) {
    applyMutations(state, payload.mutations);
  }

  const incomingProfile = normalizeProfile(payload?.profile) || normalizeProfile(payload?.room?.profile);
  if (incomingProfile) {
    state.profile = mergeProfile(state.profile, incomingProfile, payload?.code || payload?.room?.code || incomingProfile.code || "");
  } else if (payload?.code && state.profile) {
    state.profile.code = payload.code;
  }

  if (Array.isArray(payload?.confirmedIds)) {
    const confirmed = new Set(payload.confirmedIds);
    state.profileSync.mutationQueue = syncQueue().filter(mutation => !confirmed.has(mutation.id));
  }

  if (payload?.highWatermark && compareHlc(payload.highWatermark, state.profileSync.lastSyncTimestamp) > 0) {
    state.profileSync.lastSyncTimestamp = payload.highWatermark;
  }
}

function snapshotClockMap(fields, timestamp = "") {
  if (!timestamp) return {};
  const clocks = { _create: timestamp };
  for (const field of fields) clocks[field] = timestamp;
  return clocks;
}

function applySharedTripSnapshot(payload) {
  const code = normalizeCode(payload?.code || payload?.room?.code || payload?.trip?.sharedCode);
  const incomingTrip = payload?.trip ? normalizeTrip(payload.trip) : null;
  const syncState = sharedSyncState(code, incomingTrip?.id || payload?.room?.tripId || "");
  const tripId = String(incomingTrip?.id || syncState.tripId || payload?.room?.tripId || "");
  if (!code && !tripId) return;
  if (payload?.highWatermark) observeHlc(state, payload.highWatermark);

  const existingEntryIds = new Set(state.entries
    .filter(entry => entry.tripId === tripId)
    .map(entry => entry.id));
  const existingCommentIds = new Set(state.comments
    .filter(comment => comment.tripId === tripId)
    .map(comment => comment.id));

  state.trips = state.trips.filter(trip => trip.id !== tripId);
  state.entries = state.entries.filter(entry => entry.tripId !== tripId);
  state.comments = state.comments.filter(comment => comment.tripId !== tripId);
  delete state.tripClocks[tripId];
  for (const entryId of existingEntryIds) delete state.entryClocks[entryId];
  for (const commentId of existingCommentIds) delete state.commentClocks[commentId];

  if (incomingTrip) {
    state.trips.push(incomingTrip);
    state.tripClocks[incomingTrip.id] = snapshotClockMap(TRIP_FIELDS, payload?.highWatermark);
    syncState.tripId = incomingTrip.id;
  }

  const nextEntries = Array.isArray(payload?.entries)
    ? payload.entries
      .map(normalizeEntry)
      .filter(entry => entry.tripId === tripId)
    : [];
  const entryIds = new Set(nextEntries.map(entry => entry.id));
  for (const entry of nextEntries) {
    state.entries.push(entry);
    state.entryClocks[entry.id] = snapshotClockMap(ENTRY_FIELDS, payload?.highWatermark);
  }

  const nextComments = Array.isArray(payload?.comments)
    ? payload.comments
      .map(normalizeComment)
      .filter(comment => comment.tripId === tripId && entryIds.has(comment.entryId))
    : [];
  for (const comment of nextComments) {
    state.comments.push(comment);
    state.commentClocks[comment.id] = snapshotClockMap(COMMENT_FIELDS, payload?.highWatermark);
  }

  for (const mutation of syncState.mutationQueue || []) {
    applyMutation(state, mutation);
  }

  if (payload?.highWatermark && compareHlc(payload.highWatermark, syncState.lastSyncTimestamp) > 0) {
    syncState.lastSyncTimestamp = payload.highWatermark;
  }
}

function applySharedTripPayload(payload) {
  if (payload?.trip || Array.isArray(payload?.entries) || Array.isArray(payload?.comments)) {
    applySharedTripSnapshot(payload);
    return;
  }

  if (Array.isArray(payload?.mutations)) {
    applyMutations(state, payload.mutations);
  }

  const trip = payload?.trip || visibleTrips(state.trips).find(candidate => candidate.sharedCode === payload?.code);
  const code = normalizeCode(payload?.code || trip?.sharedCode);
  const tripId = String(trip?.id || "");
  if (code && tripId) {
    sharedSyncState(code, tripId).lastSyncTimestamp = payload?.highWatermark || sharedSyncState(code, tripId).lastSyncTimestamp;
  }
}

function seedProfileQueueFromTrip(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const entries = visibleTripEntries(trip.id);
  const entryIds = new Set(entries.map(entry => entry.id));
  syncQueue().push(createMutation(state, "trip", trip.id, "_create", trip));
  for (const entry of entries) {
    syncQueue().push(createMutation(state, "entry", entry.id, "_create", entry));
  }
  for (const comment of visibleComments(state.comments).filter(comment => comment.tripId === trip.id && entryIds.has(comment.entryId))) {
    syncQueue().push(createMutation(state, "comment", comment.id, "_create", comment));
  }
}

function currentCollaboratorRecord() {
  return {
    profileId: state.profile?.id || "",
    name: state.profile?.name || "",
    joinedAt: new Date().toISOString()
  };
}

function ensureCurrentCollaborator(trip, options = {}) {
  if (!trip || !hasProfileName() || isTripOwner(trip) || isTripCollaborator(trip)) return false;
  if (trip.sharedCode) setSharedTripAccessMode(trip.sharedCode, "collaborator", trip.id);
  const collaborators = [
    ...tripCollaborators(trip),
    currentCollaboratorRecord()
  ];
  queueLocalMutation("trip", trip.id, "collaborators", collaborators, {
    skipWritableCheck: Boolean(options.skipWritableCheck)
  });
  return true;
}

async function ensureProfileCode() {
  if (!state.settings.syncBaseUrl) throw new Error("Linking is not available here yet.");
  if (state.profile?.code) return state.profile.code;

  const payload = await createRemoteProfile({
    profile: state.profile,
    mutations: syncQueue()
  }, state.settings);

  applyRemotePayload(payload);
  save();
  configureSync();
  return state.profile?.code || "";
}

async function linkDevice(code, options = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Link is invalid.");
  if (!state.settings.syncBaseUrl) throw new Error("Linking is not available here yet.");

  state.linkBusy = true;
  state.linkError = "";
  renderLinkScreen();

  try {
    const payload = await fetchRemoteProfile(normalized, state.settings);
    applyRemotePayload(payload, { replaceLocal: options.replaceLocal !== false });
    state.pendingLinkCode = "";
    stripLinkQuery();
    save();
    configureSync();
    closeLinkScreen();
    renderAll();
    syncOpenViews();
    toast("Device linked");
  } catch (error) {
    state.linkError = error instanceof Error ? error.message : "Device could not be linked.";
    renderLinkScreen();
    throw error;
  } finally {
    state.linkBusy = false;
    if ($("link-overlay").classList.contains("active")) renderLinkScreen();
  }
}

async function ensureTripShared(trip) {
  if (!state.settings.syncBaseUrl) throw new Error("Sharing is not available here yet.");
  if (!hasProfileName()) throw new Error("Set your name first.");
  if (!trip) throw new Error("Trip not found.");
  assertTripWritable(trip);
  if (!isTripOwner(trip)) throw new Error("Only the trip owner can create links.");
  if (trip.sharedCode) {
    sharedSyncState(trip.sharedCode, trip.id);
    return trip.sharedCode;
  }

  const payload = await createRemoteTrip({
    trip,
    entries: visibleTripEntries(trip.id),
    comments: visibleComments(state.comments)
      .filter(comment => comment.tripId === trip.id && getEntry(comment.entryId))
  }, state.settings);

  queueLocalMutation("trip", trip.id, "sharedCode", payload.code);
  sharedSyncState(payload.code, trip.id).lastSyncTimestamp = payload.highWatermark || "";
  saveAndFlushSync();
  renderAll();
  syncOpenViews();
  return payload.code;
}

async function importSharedTrip(code, options = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Share link is invalid.");
  if (!state.settings.syncBaseUrl) throw new Error("Sharing is not available here yet.");
  if (options.collaborator && !hasProfileName()) {
    state.pendingTripCode = normalized;
    openSetupScreen();
    return;
  }

  setSharedTripAccessMode(normalized, options.collaborator ? "collaborator" : "viewer");
  const existing = visibleTrips(state.trips).find(trip => trip.sharedCode === normalized);
  const payload = await fetchRemoteTrip(normalized, state.settings, sharedTripViewer(normalized));
  applySharedTripPayload(payload);

  const trip = visibleTrips(state.trips).find(candidate => candidate.sharedCode === normalized || candidate.id === payload?.trip?.id);
  if (!trip) throw new Error("Shared trip not found.");

  if (options.collaborator) {
    ensureCurrentCollaborator(trip, { skipWritableCheck: true });
  }

  if (!existing) {
    seedProfileQueueFromTrip(trip.id);
  }

  sharedSyncState(normalized, trip.id).lastSyncTimestamp = payload.highWatermark || "";
  state.pendingTripCode = "";
  stripTripQuery();
  saveAndFlushSync();
  renderAll();
  syncOpenViews();
  openSharedTripDestination(trip.id, options.entryId);
  toast(existing ? "Trip updated" : "Trip added");
}

function currentAppUrl() {
  const url = new URL(globalThis.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function deviceLinkUrl() {
  if (!state.settings.syncBaseUrl || !state.profile?.code) return "";
  const url = new URL(currentAppUrl());
  url.searchParams.set("link", state.profile.code);
  return url.toString();
}

function shareLandingUrl(pathname) {
  if (!state.settings.syncBaseUrl) return "";
  const url = new URL(pathname, `${state.settings.syncBaseUrl.replace(/\/+$/, "")}/`);
  const appUrl = currentAppUrl();
  if (appUrl) url.searchParams.set("app", appUrl);
  return url.toString();
}

function tripShareUrl(code) {
  return shareLandingUrl(`/share/trips/${encodeURIComponent(normalizeCode(code))}`);
}

function tripCollabUrl(code) {
  return shareLandingUrl(`/share/trips/${encodeURIComponent(normalizeCode(code))}/collab`);
}

function entryShareUrl(code, entryId) {
  const normalizedCode = normalizeCode(code);
  const normalizedEntryId = String(entryId || "").trim();
  if (!normalizedCode || !normalizedEntryId) return "";
  return shareLandingUrl(`/share/trips/${encodeURIComponent(normalizedCode)}/entries/${encodeURIComponent(normalizedEntryId)}`);
}

function renderLinkScreen() {
  const pendingCount = syncQueue().length;
  const status = syncIndicatorState();
  const linkUrl = deviceLinkUrl();
  const incomingCode = normalizeCode(state.pendingLinkCode);
  const linkCopy = state.linkBusy
    ? "Preparing link..."
    : linkUrl || (
      state.settings.syncBaseUrl
        ? "Open LINK to create a device URL."
        : "Linking is not available here yet."
    );

  if (incomingCode) {
    const counts = `${plural(visibleTrips(state.trips).length, "trip")} | ${plural(allVisibleEntries().length, "entry", "entries")}`;
    $("link-body").innerHTML = `
      <button class="back-btn" data-action="cancel-link-device" type="button">BACK</button>
      <h2 class="screen-title">Link this device</h2>
      <div class="trip-route" style="margin-bottom:20px;">This will replace local data on this device.</div>

      <div class="field">
        <span class="field-label">Incoming link</span>
        <span class="field-helper">${esc(incomingCode)}</span>
      </div>

      <div class="field">
        <span class="field-label">On this device</span>
        <span class="field-helper">${esc(counts)}</span>
      </div>

      ${state.linkError ? `
        <div class="field">
          <span class="field-helper accent">${esc(state.linkError)}</span>
        </div>
      ` : ""}

      <div class="action-row">
        <button class="action-link" data-action="confirm-link-device" type="button">${state.linkBusy ? "LINKING..." : "LINK DEVICE"}</button>
        <button class="action-link secondary" data-action="cancel-link-device" type="button">CANCEL</button>
      </div>
    `;
    return;
  }

  $("link-body").innerHTML = `
    <button class="back-btn" data-action="link-back" type="button">BACK</button>
    <h2 class="screen-title">Link device</h2>
    <div class="trip-route" style="margin-bottom:20px;">${esc(status.label)}</div>

    <div class="field">
      <span class="field-label">Pending</span>
      <span class="field-helper">${esc(pendingCount ? plural(pendingCount, "change") : "no pending changes")}</span>
    </div>

    <div class="field">
      <span class="field-label">Link</span>
      <span class="field-helper break-anywhere">${esc(linkCopy)}</span>
    </div>

    ${state.linkError ? `
      <div class="field">
        <span class="field-helper accent">${esc(state.linkError)}</span>
      </div>
    ` : ""}

    ${linkUrl ? `
      <div class="action-row">
        <button class="action-link" data-action="copy-link" type="button">COPY</button>
      </div>
    ` : ""}
  `;
}

async function openLinkScreen() {
  state.linkError = "";
  renderLinkScreen();
  openOverlay("link-overlay");
  requestAnimationFrame(() => $("link-body")?.focus());

  if (!state.pendingLinkCode && state.settings.syncBaseUrl && !state.profile?.code && !state.linkBusy) {
    state.linkBusy = true;
    renderLinkScreen();
    try {
      await ensureProfileCode();
    } catch (error) {
      state.linkError = error instanceof Error ? error.message : "Link could not be prepared.";
    } finally {
      state.linkBusy = false;
      renderLinkScreen();
    }
  }
}

function closeLinkScreen() {
  state.linkBusy = false;
  closeOverlay("link-overlay");
}

function renderShareScreen() {
  const trip = getTrip(state.shareTripId);
  if (!trip) return;
  const entry = state.shareEntryId ? getEntry(state.shareEntryId) : null;
  const viewerUrl = trip.sharedCode
    ? (entry ? entryShareUrl(trip.sharedCode, entry.id) : tripShareUrl(trip.sharedCode))
    : "";
  const collaboratorUrl = trip.sharedCode ? tripCollabUrl(trip.sharedCode) : "";
  const helper = state.shareBusy
    ? "Preparing links..."
    : (
      state.settings.syncBaseUrl
        ? "Links will appear here."
        : "Sharing is not available here yet."
    );
  const screenTitle = entry ? "Share entry" : "Share trip";
  const routeLabel = entry
    ? (entry.title || entryMetaLine(entry, { includeAuthor: false, includeDate: true }) || "Untitled entry")
    : trip.title;
  const viewerHelper = entry
    ? "People with this link can open this entry and view the whole trip."
    : "People with this link can read and comment. They cannot add or edit entries.";

  $("share-body").innerHTML = `
    <button class="back-btn" data-action="share-back" type="button">BACK</button>
    <h2 class="screen-title">${esc(screenTitle)}</h2>
    <div class="trip-route" style="margin-bottom:20px;">${esc(routeLabel)}</div>

    <div class="field">
      <span class="field-label">Viewer link</span>
      <span class="field-helper">${esc(viewerHelper)}</span>
      <span class="field-helper break-anywhere">${esc(viewerUrl || helper)}</span>
      ${viewerUrl ? `
        <div class="action-row share-link-actions">
          <button class="action-link" data-action="copy-share-link" data-share-kind="viewer" type="button">COPY VIEWER LINK</button>
        </div>
      ` : ""}
    </div>

    ${entry ? "" : `
      <div class="field">
        <span class="field-label">Collaborator link</span>
        <span class="field-helper">People with this link can add entries to this trip.</span>
        <span class="field-helper break-anywhere">${esc(collaboratorUrl || helper)}</span>
        ${collaboratorUrl ? `
          <div class="action-row share-link-actions">
            <button class="action-link" data-action="copy-share-link" data-share-kind="collaborator" type="button">COPY COLLABORATOR LINK</button>
          </div>
        ` : ""}
      </div>
    `}

    ${state.shareError ? `
      <div class="field">
        <span class="field-helper accent">${esc(state.shareError)}</span>
      </div>
    ` : ""}
  `;
}

async function openShareScreen({ tripId = "", entryId = "" } = {}) {
  if (!hasProfileName()) {
    openSetupScreen();
    return;
  }
  const entry = entryId ? getEntry(entryId) : null;
  const trip = getTrip(tripId || entry?.tripId);
  if (!trip) return;
  if (entry && !isEntryDirectShareable(entry)) {
    throw new Error("Only public entries can be shared directly right now.");
  }

  state.shareTripId = trip.id;
  state.shareEntryId = entry?.id || null;
  state.shareError = "";
  renderShareScreen();
  openOverlay("share-overlay");
  requestAnimationFrame(() => $("share-body")?.focus());

  if (!trip || trip.sharedCode || !state.settings.syncBaseUrl || state.shareBusy) return;

  state.shareBusy = true;
  renderShareScreen();
  try {
    await ensureTripShared(trip);
  } catch (error) {
    state.shareError = error instanceof Error ? error.message : "Trip could not be shared.";
  } finally {
    state.shareBusy = false;
    renderShareScreen();
  }
}

function closeShareScreen() {
  state.shareBusy = false;
  state.shareTripId = null;
  state.shareEntryId = null;
  state.shareError = "";
  closeOverlay("share-overlay");
}

function stripLinkQuery() {
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has("link")) return;
  url.searchParams.delete("link");
  globalThis.history?.replaceState?.({}, "", url);
}

function stripTripQuery() {
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has("trip") && !url.searchParams.has("collab") && !url.searchParams.has("entry")) return;
  url.searchParams.delete("trip");
  url.searchParams.delete("collab");
  url.searchParams.delete("entry");
  globalThis.history?.replaceState?.({}, "", url);
}

function openSharedTripDestination(tripId, entryId = "") {
  showTrip(tripId);
  const id = String(entryId || "").trim();
  if (!id) return;
  const entry = getEntry(id);
  if (entry?.tripId === tripId) openEntry(entry.id);
}

function handleLinkQuery() {
  const params = new URLSearchParams(globalThis.location.search);
  const code = normalizeCode(params.get("link"));
  if (!code) return;

  if (state.profile?.code === code) {
    stripLinkQuery();
    return;
  }

  if (!hasLocalContent()) {
    runAction(() => linkDevice(code, { replaceLocal: true }));
    return;
  }

  state.pendingLinkCode = code;
  state.linkError = "";
  openLinkScreen();
}

function handleTripQuery() {
  const params = new URLSearchParams(globalThis.location.search);
  const collabCode = normalizeCode(params.get("collab"));
  const code = collabCode || normalizeCode(params.get("trip"));
  const entryId = String(params.get("entry") || "").trim();
  if (!code) return;

  if (collabCode && !hasProfileName()) {
    state.pendingTripCode = collabCode;
    openSetupScreen();
    return;
  }

  const existing = visibleTrips(state.trips).find(trip => trip.sharedCode === code);
  if (existing) {
    setSharedTripAccessMode(code, collabCode ? "collaborator" : "viewer", existing.id);
    if (collabCode) {
      ensureCurrentCollaborator(existing, { skipWritableCheck: true });
      saveAndFlushSync();
    }
    stripTripQuery();
    openSharedTripDestination(existing.id, entryId);
    return;
  }

  runAction(() => importSharedTrip(code, { collaborator: Boolean(collabCode), entryId }));
}

function handleIncomingQueries() {
  const params = new URLSearchParams(globalThis.location.search);
  const hasIncomingLink = Boolean(normalizeCode(params.get("link")));
  const hasViewerTrip = Boolean(normalizeCode(params.get("trip"))) && !normalizeCode(params.get("collab"));
  const hasCollaboratorTrip = Boolean(normalizeCode(params.get("collab")));

  handleLinkQuery();
  handleTripQuery();

  if (!hasProfileName() && !hasIncomingLink && !hasViewerTrip && !hasCollaboratorTrip) {
    openSetupScreen();
  }
}

async function copyDeviceLink() {
  const url = deviceLinkUrl();
  if (!url) throw new Error("Link is not ready yet.");
  await navigator.clipboard.writeText(url);
  toast("Link copied");
}

async function copyShareLink(kind = "viewer") {
  const trip = getTrip(state.shareTripId);
  const entry = state.shareEntryId ? getEntry(state.shareEntryId) : null;
  const url = trip?.sharedCode
    ? (
      kind === "collaborator"
        ? tripCollabUrl(trip.sharedCode)
        : (entry ? entryShareUrl(trip.sharedCode, entry.id) : tripShareUrl(trip.sharedCode))
    )
    : "";
  if (!url) throw new Error("Share link is not ready yet.");
  await navigator.clipboard.writeText(url);
  toast("Link copied");
}

function showTrip(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  state.currentTripId = trip.id;
  renderTrip();
  openOverlay("trip-overlay");
}

function closeTrip() {
  tripMap = destroyMap(tripMap);
  closeOverlay("trip-overlay");
  state.currentTripId = null;
  renderAll();
}

function renderTrip() {
  const trip = getTrip(state.currentTripId);
  if (!trip) return;

  const entries = visibleTripEntries(trip.id);
  const days = daysBetween(trip.startIso, trip.endIso);
  const counts = visibleTripEntryCounts(trip.id);
  const sharedBy = tripSharedByLabel(trip);
  const readOnly = isReadOnlyTrip(trip);
  const owner = isTripOwner(trip);
  const tripActions = [
    renderTripActivityButton(trip),
    readOnly ? "" : '<button class="action-link title-action" data-action="compose-journal" type="button">+ ADD</button>',
    !readOnly ? '<button class="action-link title-action" data-action="share-trip" type="button">SHARE</button>' : "",
    !readOnly ? '<button class="action-link title-action" data-action="edit-trip" type="button">EDIT</button>' : ""
  ].filter(Boolean).join("");

  $("trip-body").innerHTML = `
    <div class="map-panel"><div class="map-canvas" id="trip-map"></div></div>
    <div class="overlay-topbar">
      <button class="back-btn" data-action="trip-back" type="button">BACK</button>
      ${tripActions ? `<div class="trip-head-actions">${tripActions}</div>` : ""}
    </div>
    <div class="trip-head-dates">
      <span>${esc(formatDateRange(trip.startIso, trip.endIso).toUpperCase())} | ${plural(days, "day").toUpperCase()} | ${esc(plural(counts.total, "entry", "entries").toUpperCase())} | <button class="action-link sort-btn" data-action="toggle-trip-sort" type="button">${state.tripSort === "oldest" ? "OLDEST FIRST" : "NEWEST FIRST"}</button></span>
      <span>${esc(statusLabel(trip))}</span>
    </div>
    <div class="trip-title-row">
      <h2 class="trip-head-title">${esc(trip.title)}</h2>
    </div>
    ${sharedBy ? `<div class="trip-shared-by">${esc(sharedBy)}</div>` : ""}
    ${renderTripParticipants(trip)}

    <div id="timeline">${entries.length ? renderTimeline(entries) : '<div class="empty-state">no entries yet.</div>'}</div>
  `;

  requestAnimationFrame(() => renderTripMap(trip.id));
}

function renderTimeline(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = dayKey(entry.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const days = Array.from(groups.values());
  if (state.tripSort === "newest") { days.reverse(); days.forEach(d => d.reverse()); }

  return days.map(dayEntries => {
    const first = dayEntries[0];
    const places = uniqueLabels(dayEntries.map(entryRouteLabel).filter(Boolean));
    return `
      <section class="day-group">
        <div class="day-header">
          <span class="day-label">${esc(formatDayLabel(first.timestamp))}</span>
          ${places.length ? `<span class="day-places">${esc(places.join(" | "))}</span>` : ""}
        </div>
        ${dayEntries.map(renderEntryItem).join("")}
      </section>
    `;
  }).join("");
}

function renderEntryItem(entry) {
  const paragraphs = bodyParagraphs(entryDescription(entry));
  const includeAuthor = showEntryAuthors(entry.tripId);
  const url = entry.url || "";
  return `
    <article class="entry" data-entry-id="${esc(entry.id)}">
      <div class="entry-meta">
        <span>${esc(entryMetaLine(entry, { includeAuthor, shortLocation: true }))}</span>
      </div>
      <div class="entry-body">
        ${entry.title ? `<p class="entry-summary-title">${esc(entry.title)}</p>` : ""}
        ${renderEntryPhotos(entry, "summary")}
        ${paragraphs}
        ${url ? `<a class="entry-link" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(entryUrlLabel(url))}</a>` : ""}
        ${renderEntryLinkPreview(entry, "summary")}
        ${renderEntryCommentSummary(entry)}
      </div>
    </article>
  `;
}

function renderEntryCommentSummary(entry) {
  const comments = entryComments(entry.id);
  const expanded = state.expandedCommentEntryIds.has(entry.id);
  const label = comments.length ? plural(comments.length, "comment") : "NO COMMENTS";

  return `
    <div class="entry-comments-block">
      <button class="entry-comments-toggle" data-action="toggle-entry-comments" data-entry-id="${esc(entry.id)}" type="button">${esc(label)}</button>
      ${expanded ? `
        <div class="entry-inline-comments">
          ${comments.length ? comments.map(comment => renderComment(comment)).join("") : ""}
          <input class="field-input inline-comment-input" data-entry-id="${esc(entry.id)}" value="${esc(state.inlineCommentDrafts.get(entry.id) || "")}" placeholder="Leave a comment..." autocomplete="off">
        </div>
      ` : ""}
    </div>
  `;
}

function toggleEntryComments(entryId) {
  const id = String(entryId || "");
  if (!id) return;
  let expanded = false;
  if (state.expandedCommentEntryIds.has(id)) {
    state.expandedCommentEntryIds.delete(id);
  } else {
    state.expandedCommentEntryIds.add(id);
    expanded = true;
  }
  renderTrip();
  if (expanded) {
    requestAnimationFrame(() => document.querySelector(`.inline-comment-input[data-entry-id="${cssEscape(id)}"]`)?.focus());
  }
}

function renderEntryPhotos(entry, variant = "summary") {
  const photos = entryPhotos(entry);
  if (!photos.length) return "";

  if (variant === "detail") {
    return `
      <div class="entry-photo-column detail">
        ${photos.map((photo, index) => renderEntryPhotoItem(photo, entry, "detail", index)).join("")}
      </div>
    `;
  }

  const columns = photos.length === 4 ? 2 : Math.min(3, photos.length);
  return `
    <div class="entry-photo-grid summary cols-${esc(columns)}">
      ${photos.map((photo, index) => renderEntryPhotoItem(photo, entry, "summary", index)).join("")}
    </div>
  `;
}

function renderEntryPhotoItem(photo, entry, variant, index = 0) {
  const url = getCachedPhotoUrl(photo.photoAssetId);
  const isVideo = (photo.photoMime || "").startsWith("video/");
  const status = photoStatus(photo);
  const statusHtml = status.label && status.tone !== "ready"
    ? `<div class="photo-status ${esc(status.tone)}">${esc(status.label)}</div>`
    : "";

  if (url) {
    const media = isVideo
      ? `<video class="entry-photo ${esc(variant)}" src="${esc(url)}" ${variant === "detail" ? "controls" : "muted autoplay loop"} playsinline preload="metadata"></video>`
      : `<img class="entry-photo ${esc(variant)}" src="${esc(url)}" alt="${esc(entry.title || `entry photo ${index + 1}`)}" loading="lazy">`;
    return `
      <figure class="entry-photo-frame ${esc(variant)}">
        ${media}
        ${statusHtml}
      </figure>
    `;
  }

  ensureEntryPhotoCached(photo).catch(() => {});
  const kind = isVideo ? "video" : "photo";
  const label = status.label || (photo.photoUploadedAt ? `loading ${kind}...` : `${kind} pending upload`);
  return `<div class="entry-photo-placeholder ${esc(variant)}">${esc(label)}</div>`;
}

function bodyParagraphs(value) {
  const paragraphs = String(value || "")
    .split("\n")
    .map(part => part.trim())
    .filter(Boolean);

  return paragraphs.length
    ? paragraphs.map(part => `<p>${esc(part)}</p>`).join("")
    : "";
}

function renderEntrySocial(entry) {
  const comments = entryComments(entry.id);

  return `
    <section class="entry-social">
      ${comments.length ? `<div class="comments-list">${comments.map(renderComment).join("")}</div>` : ""}
      <input class="field-input comment-input" id="comment-input" value="${esc(state.commentDraft)}" placeholder="Leave a comment..." autocomplete="off">
    </section>
  `;
}

function renderComment(comment) {
  const meta = [comment.authorName || "Someone", formatActivityTime(comment.dateCreated)].filter(Boolean).join(" | ");
  const editing = state.editingCommentId === comment.id;
  const selected = state.selectedCommentId === comment.id;
  return `
    <article class="comment ${selected ? "selected" : ""}" data-comment-id="${esc(comment.id)}">
      <div class="comment-meta">${esc(meta)}</div>
      ${editing ? `
        <input class="field-input comment-edit-input" data-comment-id="${esc(comment.id)}" value="${esc(state.commentEditDraft)}" autocomplete="off">
        <div class="comment-actions">
          <button class="action-link" data-action="save-comment-edit" data-comment-id="${esc(comment.id)}" type="button">SAVE</button>
          <button class="action-link secondary" data-action="cancel-comment-edit" type="button">CANCEL</button>
        </div>
      ` : `
        <div class="comment-body">${bodyParagraphs(comment.body)}</div>
        ${selected ? renderCommentActions(comment) : ""}
      `}
    </article>
  `;
}

function renderCommentActions(comment) {
  const actions = [];
  if (canEditComment(comment)) {
    actions.push(`<button class="action-link" data-action="edit-comment" data-comment-id="${esc(comment.id)}" type="button">EDIT</button>`);
  }
  if (canDeleteComment(comment)) {
    actions.push(`<button class="action-link destructive" data-action="delete-comment" data-comment-id="${esc(comment.id)}" type="button">DELETE</button>`);
  }
  return actions.length ? `<div class="comment-actions">${actions.join("")}</div>` : "";
}

function openEntry(entryId, options = {}) {
  const entry = getEntry(entryId);
  if (!entry) return;
  if (state.currentEntryId !== entry.id) state.commentDraft = "";
  state.currentEntryId = entry.id;
  state.entryReturnTo = options.returnTo || "";
  renderEntry();
  openOverlay("entry-overlay");
}

function closeEntry() {
  const returnTo = state.entryReturnTo;
  entryMap = destroyMap(entryMap);
  closeOverlay("entry-overlay");
  state.currentEntryId = null;
  state.entryReturnTo = "";
  state.commentDraft = "";
  state.editingCommentId = "";
  state.commentEditDraft = "";
  clearConfirmation("entry");

  if (returnTo === "activity" && $("activity-overlay").classList.contains("active")) {
    renderActivityScreen();
    requestAnimationFrame(() => $("activity-body")?.focus());
  }
}

function renderEntry() {
  const entry = getEntry(state.currentEntryId);
  if (!entry) return;
  const trip = getTrip(entry.tripId);
  const includeAuthor = showEntryAuthors(entry.tripId);
  const readOnly = isReadOnlyTrip(trip);
  const actions = [
    !readOnly && isEntryDirectShareable(entry)
      ? '<button class="action-link" data-action="share-entry" type="button">SHARE</button>'
      : "",
    !readOnly && canManageEntry(entry)
      ? '<button class="action-link" data-action="edit-entry" type="button">EDIT</button>'
      : "",
    !readOnly && canManageEntry(entry)
      ? '<button class="action-link destructive" data-action="delete-entry" type="button">DELETE</button>'
      : ""
  ].filter(Boolean).join("");

  const timelineEntries = visibleTripEntries(entry.tripId);
  const timelineIdx = timelineEntries.findIndex(e => e.id === entry.id);
  const timelineMinTs = timelineEntries.length > 1 ? new Date(timelineEntries[0].timestamp).getTime() : 0;
  const timelineMaxTs = timelineEntries.length > 1 ? new Date(timelineEntries[timelineEntries.length - 1].timestamp).getTime() : 1;
  const timelineSpan = timelineMaxTs - timelineMinTs || 1;
  // Compute horizontal positions, then assign vertical rows to reduce overlap.
  // Rows: 0=center, 1=below, -1=above, 2=further below, -2=further above (10px each).
  const TIMELINE_OVERLAP_PCT = 3.5;
  const timelineRowPrefs = [0, 1, -1, 2, -2];
  const timelineLastOnRow = {};
  const timelineDots = timelineEntries.map((e, i) => {
    const pct = timelineEntries.length < 2 ? 50
      : timelineSpan > 0 ? (new Date(e.timestamp).getTime() - timelineMinTs) / timelineSpan * 100
      : i / (timelineEntries.length - 1) * 100;
    let row = 0;
    for (const r of timelineRowPrefs) {
      if (timelineLastOnRow[r] === undefined || pct - timelineLastOnRow[r] >= TIMELINE_OVERLAP_PCT) {
        row = r;
        timelineLastOnRow[r] = pct;
        break;
      }
    }
    const topStyle = row === 0 ? "" : `;top:calc(50% + ${row * 10}px)`;
    let stem = "";
    if (row !== 0) {
      const stemHeight = Math.abs(row) * 10 - 4;
      const stemTop = row > 0 ? "50%" : `calc(50% - ${stemHeight}px)`;
      stem = `<span class="entry-timeline-stem" style="left:${pct}%;top:${stemTop};height:${stemHeight}px"></span>`;
    }
    return stem + `<button class="entry-timeline-dot${e.id === entry.id ? " current" : ""}" data-action="entry-nav" data-entry-id="${esc(e.id)}" aria-label="${esc(entryMetaLine(e, { includeDate: true }))}" style="left:${pct}%${topStyle}"></button>`;
  }).join("");

  $("entry-body").innerHTML = `
    ${hasGeotag(entry) ? '<div class="map-panel compact"><div class="map-canvas" id="entry-map"></div></div>' : ""}
    <div class="entry-timeline">
      <button class="entry-timeline-nav" data-action="entry-prev" aria-label="Previous entry"${timelineIdx <= 0 ? " disabled" : ""}><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m12 8-4 4 4 4"/><path d="M16 12H8"/></svg></button>
      <span class="entry-timeline-connector" aria-hidden="true"></span>
      <div class="entry-timeline-track">${timelineDots}</div>
      <span class="entry-timeline-connector" aria-hidden="true"></span>
      <button class="entry-timeline-nav" data-action="entry-next" aria-label="Next entry"${timelineIdx >= timelineEntries.length - 1 ? " disabled" : ""}><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m12 16 4-4-4-4"/><path d="M8 12h8"/></svg></button>
    </div>
    <div class="overlay-topbar">
      <button class="back-btn" data-action="entry-back" type="button">BACK</button>
      ${actions ? `<div class="entry-head-actions">${actions}</div>` : ""}
    </div>
    <div class="entry-meta">
      <span>${esc(entryMetaLine(entry, { includeAuthor, includeDate: true }))}</span>
    </div>
    ${entryLocationLabel(entry) ? `<div class="entry-location">${esc(entryLocationLabel(entry))}${entry.locationAccuracy ? ` | +/- ${esc(Math.round(entry.locationAccuracy))}m` : ""}</div>` : ""}
    ${entry.title ? `<h2 class="entry-detail-title">${esc(entry.title)}</h2>` : ""}
    ${renderEntryPhotos(entry, "detail")}
    <div class="entry-detail-content">
      ${bodyParagraphs(entryDescription(entry))}
      ${entry.url ? `<a class="entry-link" href="${esc(entry.url)}" target="_blank" rel="noreferrer">${esc(entryUrlLabel(entry.url))}</a>` : ""}
      ${renderEntryLinkPreview(entry, "detail")}
    </div>
    ${renderEntrySocial(entry)}
  `;

  requestAnimationFrame(() => renderEntryMap(entry.id));
}

function saveCommentFromForm() {
  const entry = getEntry(state.currentEntryId);
  if (!entry) return;
  const body = ($("comment-input")?.value || state.commentDraft || "").trim();
  saveCommentForEntry(entry, body, () => {
    state.commentDraft = "";
  });
}

function saveInlineCommentFromForm(entryId) {
  const entry = getEntry(entryId);
  if (!entry) return;
  const body = String(state.inlineCommentDrafts.get(entry.id) || "").trim();
  saveCommentForEntry(entry, body, () => {
    state.inlineCommentDrafts.delete(entry.id);
    state.expandedCommentEntryIds.add(entry.id);
  });
}

function saveCommentForEntry(entry, body, onSaved) {
  const text = String(body || "").trim();
  if (!text) {
    toast("comment required");
    return;
  }

  if (!hasProfileName()) {
    state.pendingComment = { entryId: entry.id, body: text };
    openSetupScreen();
    return;
  }

  onSaved?.();
  createCommentForEntry(entry, text);
}

function createCommentForEntry(entry, body) {
  const comment = createComment(entry, state.profile, body);
  queueEntityCreate("comment", comment);
  state.selectedCommentId = comment.id;
  saveAndFlushSync();
  renderAll();
  renderCommentSurfaces();
  toast("comment added");
}

function savePendingComment() {
  if (!state.pendingComment || !hasProfileName()) return false;
  const pending = state.pendingComment;
  state.pendingComment = null;

  const entry = getEntry(pending.entryId);
  const body = String(pending.body || "").trim();
  if (!entry || !body) return false;

  state.commentDraft = "";
  state.inlineCommentDrafts.delete(entry.id);
  state.expandedCommentEntryIds.add(entry.id);
  createCommentForEntry(entry, body);
  return true;
}

function renderCommentSurfaces() {
  if ($("trip-overlay").classList.contains("active") && state.currentTripId) {
    renderTrip();
  }
  if ($("entry-overlay").classList.contains("active") && state.currentEntryId) {
    renderEntry();
  }
  if ($("activity-overlay").classList.contains("active")) {
    renderActivityScreen();
  }
}

function selectComment(commentId) {
  const comment = getComment(commentId);
  if (!comment || state.selectedCommentId === comment.id) return;
  state.selectedCommentId = comment.id;
  renderCommentSurfaces();
}

function maybeSelectCommentFromEvent(event) {
  if (event.target.closest("a, button, input, textarea, select")) return false;
  const comment = event.target.closest(".comment");
  if (!comment) return false;
  selectComment(comment.dataset.commentId);
  return true;
}

function startEditComment(commentId) {
  const comment = getComment(commentId);
  if (!comment) return;
  if (!canEditComment(comment)) {
    toast("Only the author can edit this comment.");
    return;
  }

  state.selectedCommentId = comment.id;
  state.editingCommentId = comment.id;
  state.commentEditDraft = comment.body;
  clearConfirmation("comment");
  renderCommentSurfaces();
  requestAnimationFrame(() => {
    const root = $("entry-overlay").classList.contains("active") ? $("entry-overlay") : $("trip-overlay");
    root.querySelector(`.comment-edit-input[data-comment-id="${cssEscape(comment.id)}"]`)?.focus();
  });
}

function cancelEditComment() {
  state.editingCommentId = "";
  state.commentEditDraft = "";
  renderCommentSurfaces();
}

function saveEditedComment(commentId) {
  const comment = getComment(commentId || state.editingCommentId);
  if (!comment) return;
  if (!canEditComment(comment)) {
    toast("Only the author can edit this comment.");
    return;
  }

  const body = String(state.commentEditDraft || "").trim();
  if (!body) {
    toast("comment required");
    return;
  }

  queueLocalMutation("comment", comment.id, "body", body);
  queueLocalMutation("comment", comment.id, "dateUpdated", new Date().toISOString());
  state.editingCommentId = "";
  state.commentEditDraft = "";
  saveAndFlushSync();
  renderAll();
  renderCommentSurfaces();
  toast("comment updated");
}

function requestDeleteComment(commentId) {
  const comment = getComment(commentId);
  if (!comment) return;
  if (!canDeleteComment(comment)) {
    toast("You cannot delete this comment.");
    return;
  }

  openConfirmation("comment", "Are you sure?", "delete-comment", comment.id);
}

function deleteComment(commentId) {
  const comment = getComment(commentId);
  if (!comment) return;
  if (!canDeleteComment(comment)) {
    toast("You cannot delete this comment.");
    return;
  }

  queueLocalMutation("comment", comment.id, "_delete", true);
  if (state.editingCommentId === comment.id) {
    state.editingCommentId = "";
    state.commentEditDraft = "";
  }
  if (state.selectedCommentId === comment.id) {
    state.selectedCommentId = "";
  }
  saveAndFlushSync();
  renderAll();
  renderCommentSurfaces();
  toast("comment deleted");
}

function openCompose(entryId = "") {
  const trip = getTrip(state.currentTripId);
  if (!trip) return;
  assertTripWritable(trip);
  const entry = entryId ? getEntry(entryId) : null;
  if (entry && !canManageEntry(entry)) throw new Error("You cannot edit this entry.");
  state.composeEntryId = entryId;
  state.isChangingEntryLocation = false;
  state.entryLocationDraft = null;
  state.entryLocationEnabled = composeLocationEnabledFromEntry(entry);
  state.entryLocationQuery = "";
  state.entryLocationError = "";
  state.entryFormDraft = null;
  state.entryPhotoDrafts = [];
  state.entryPhotoRemovedIds = new Set();
  state.entryPhotoError = "";
  state.entryPhotoNote = "";
  resetEntryUrlMetadataState(entry);
  state.composeInitialSnapshot = composeSnapshotFromEntry(entry);
  clearConfirmation("compose");
  renderCompose();
  openOverlay("compose-overlay");
  if (!entry) requestLocationForNewEntry();
  if (entry?.url && !entryLinkPreview(entry)) {
    lookupEntryUrlMetadata(entry.url, { force: true }).catch(() => {});
  }
  requestAnimationFrame(() => $("entry-description-input")?.focus());
}

function requestCloseCompose() {
  if (hasUnsavedComposeChanges()) {
    openConfirmation("compose", "You have unsaved changes. Discard them?", "discard-compose");
    return;
  }

  closeCompose();
}

function closeCompose() {
  composeMap = destroyMap(composeMap);
  closeOverlay("compose-overlay");
  state.composeEntryId = null;
  state.isChangingEntryLocation = false;
  state.entryLocationDraft = null;
  state.entryLocationEnabled = true;
  state.entryLocationQuery = "";
  state.entryLocationError = "";
  state.entryFormDraft = null;
  state.entryPhotoDrafts = [];
  state.entryPhotoRemovedIds = new Set();
  state.entryPhotoError = "";
  state.entryPhotoNote = "";
  resetEntryUrlMetadataState(null);
  state.composeInitialSnapshot = null;
  clearConfirmation("compose");
}

function captureEntryFormDraft() {
  const titleInput = $("entry-title-input");
  const descriptionInput = $("entry-description-input");
  const visibilityInput = $("entry-visibility-input");
  const urlInput = $("entry-url-input");
  const timeInput = $("entry-time-input");
  if (!titleInput && !descriptionInput && !visibilityInput && !urlInput && !timeInput) return;

  state.entryFormDraft = {
    title: titleInput?.value || "",
    description: descriptionInput?.value || "",
    visibility: visibilityInput?.value || "public",
    url: urlInput?.value || "",
    timestampInput: timeInput?.value || ""
  };
}

function entryFormValue(entry, field, fallback = "") {
  if (state.entryFormDraft && Object.hasOwn(state.entryFormDraft, field)) {
    return state.entryFormDraft[field];
  }
  return fallback;
}

function composeLocationEnabledFromEntry(entry) {
  return entry?.geotagStatus !== "skipped";
}

function isComposeLocationEnabled(entry = state.composeEntryId ? getEntry(state.composeEntryId) : null) {
  return state.entryLocationEnabled ?? composeLocationEnabledFromEntry(entry);
}

function composeSnapshotFromEntry(entry) {
  const timestamp = entry?.timestamp || new Date().toISOString();
  const locationEnabled = composeLocationEnabledFromEntry(entry);
  return {
    title: String(entry?.title || "").trim(),
    description: entryDescription(entry).trim(),
    visibility: normalizeEntryVisibility(entry?.visibility),
    url: String(entry?.url || "").trim(),
    linkPreview: linkPreviewSignature(entryLinkPreview(entry)),
    timestampInput: toDateTimeInputValue(timestamp),
    locationEnabled,
    location: locationEnabled ? locationSignature(entry) : "",
    photos: photoListSignature(entryPhotos(entry))
  };
}

function currentComposeSnapshot() {
  captureEntryFormDraft();

  const initial = state.composeInitialSnapshot || composeSnapshotFromEntry(null);
  const title = String(state.entryFormDraft?.title || "").trim();
  const description = String(state.entryFormDraft?.description || "").trim();
  const visibility = normalizeEntryVisibility(state.entryFormDraft?.visibility || initial.visibility);
  const url = String(state.entryFormDraft?.url || "").trim();
  const entry = state.composeEntryId ? getEntry(state.composeEntryId) : null;
  const linkPreview = linkPreviewSignature(currentLinkPreview(entry, url));
  const timestampInput = String(state.entryFormDraft?.timestampInput || initial.timestampInput || "").trim();
  const locationEnabled = isComposeLocationEnabled(entry);
  const location = locationEnabled
    ? (state.entryLocationDraft ? locationSignature(state.entryLocationDraft) : initial.location)
    : "";
  const photos = photoListSignature(composePhotoList(entry));

  return {
    title,
    description,
    visibility,
    url,
    linkPreview,
    timestampInput,
    locationEnabled,
    location,
    photos
  };
}

function hasUnsavedComposeChanges() {
  const initial = state.composeInitialSnapshot;
  if (!initial) return false;

  const current = currentComposeSnapshot();
  return current.title !== initial.title ||
    current.description !== initial.description ||
    current.visibility !== initial.visibility ||
    current.url !== initial.url ||
    current.linkPreview !== initial.linkPreview ||
    current.timestampInput !== initial.timestampInput ||
    current.locationEnabled !== initial.locationEnabled ||
    current.location !== initial.location ||
    current.photos !== initial.photos;
}

function locationSignature(location) {
  if (!location) return "";
  return JSON.stringify({
    lat: Number.isFinite(location.lat) ? Number(location.lat).toFixed(6) : "",
    lng: Number.isFinite(location.lng) ? Number(location.lng).toFixed(6) : "",
    locationQuery: String(location.locationQuery || "").trim(),
    locationDisplayName: String(location.locationDisplayName || "").trim(),
    locationCity: String(location.locationCity || "").trim(),
    locationRegion: String(location.locationRegion || "").trim(),
    locationCountry: String(location.locationCountry || "").trim()
  });
}

function emptyEntryLocationFields(status = "") {
  return {
    lat: null,
    lng: null,
    locationQuery: "",
    locationDisplayName: "",
    locationCity: "",
    locationRegion: "",
    locationCountry: "",
    locationAccuracy: null,
    geotaggedAt: "",
    geotagStatus: status
  };
}

function locationFieldsFromDraft(location) {
  return {
    lat: location.lat,
    lng: location.lng,
    locationQuery: location.locationQuery,
    locationDisplayName: location.locationDisplayName,
    locationCity: location.locationCity,
    locationRegion: location.locationRegion,
    locationCountry: location.locationCountry,
    locationAccuracy: location.locationAccuracy,
    geotaggedAt: location.geotaggedAt,
    geotagStatus: location.geotagStatus
  };
}

function renderLocationField(entry, label) {
  const enabled = isComposeLocationEnabled(entry);
  const canChange = enabled;
  const changing = canChange && state.isChangingEntryLocation;
  const draft = state.entryLocationDraft;
  const displayLabel = draft ? entryLocationLabel(draft) : label;
  const query = state.entryLocationQuery || draft?.locationQuery || entry?.locationQuery || entry?.locationDisplayName || "";
  const helper = state.entryLocationError || displayLabel;

  return `
    <div class="field">
      <label class="checkbox-field">
        <input class="checkbox-input" id="entry-location-enabled-input" type="checkbox" ${enabled ? "checked" : ""}>
        <span class="checkbox-copy">
          <span class="field-label checkbox-label">Tag location</span>
          <span class="field-helper">On by default. Turn it off to save this post without a location.</span>
        </span>
      </label>
      ${enabled ? `
        <div class="location-field-body">
          <div class="field-label-row">
            <span class="field-label">Location</span>
            ${canChange && !changing ? '<button class="inline-link" data-action="change-entry-location" type="button">CHANGE</button>' : ""}
          </div>
          <span class="field-helper ${state.entryLocationError ? "accent" : ""}">${esc(helper)}</span>
          ${changing ? `
            <div class="location-edit-form">
              <input class="field-input" id="location-query-input" value="${esc(query)}" placeholder="address, place, or city" autocomplete="street-address">
              <div class="action-row compact">
                <button class="action-link" data-action="geocode-entry-location" type="button">FIND</button>
                <button class="action-link secondary" data-action="cancel-location-change" type="button">CANCEL</button>
              </div>
            </div>
          ` : ""}
        </div>
      ` : `
        <span class="field-helper">Location will not be attached to this entry.</span>
      `}
    </div>
  `;
}

function clearEntryUrlMetadataTimer() {
  clearTimeout(entryUrlMetadataTimer);
  entryUrlMetadataTimer = null;
}

function resetEntryUrlMetadataState(entry = null) {
  clearEntryUrlMetadataTimer();
  state.entryUrlMetadataDraft = entryLinkPreview(entry);
  state.entryUrlMetadataRemoved = false;
  state.entryUrlMetadataStatus = "";
  state.entryUrlMetadataError = "";
  state.entryUrlMetadataLastUrl = entry?.url || "";
  state.entryUrlMetadataRequestId += 1;
}

function refreshComposeAfterUrlMetadata() {
  if (!$("compose-overlay")?.classList.contains("active")) return;
  const activeId = $("compose-overlay").contains(document.activeElement) ? document.activeElement?.id : "";
  renderCompose();
  if (activeId) {
    requestAnimationFrame(() => $(activeId)?.focus({ preventScroll: true }));
  }
}

function handleEntryUrlInput(value) {
  captureEntryFormDraft();
  clearConfirmation("compose");
  const url = entryUrlReadyForLookup(value);

  if (!url) {
    const hadMetadataState = Boolean(state.entryUrlMetadataDraft || state.entryUrlMetadataStatus || state.entryUrlMetadataError);
    clearEntryUrlMetadataTimer();
    state.entryUrlMetadataDraft = null;
    state.entryUrlMetadataRemoved = false;
    state.entryUrlMetadataStatus = "";
    state.entryUrlMetadataError = "";
    state.entryUrlMetadataLastUrl = "";
    if (hadMetadataState) refreshComposeAfterUrlMetadata();
    return;
  }

  if (!sameEntryUrl(state.entryUrlMetadataLastUrl, url)) {
    state.entryUrlMetadataRemoved = false;
    state.entryUrlMetadataError = "";
    state.entryUrlMetadataStatus = "";
    state.entryUrlMetadataLastUrl = url;
    if (!sameEntryUrl(state.entryUrlMetadataDraft?.url, url)) {
      state.entryUrlMetadataDraft = null;
    }
  }

  clearEntryUrlMetadataTimer();
  entryUrlMetadataTimer = setTimeout(() => {
    lookupEntryUrlMetadata(url).catch(() => {});
  }, 450);
}

async function lookupEntryUrlMetadata(value, options = {}) {
  const url = validHttpEntryUrl(value);
  if (!url || state.entryUrlMetadataRemoved) return null;

  const entry = state.composeEntryId ? getEntry(state.composeEntryId) : null;
  const existing = currentLinkPreview(entry, url);
  if (!options.force && existing && sameEntryUrl(state.entryUrlMetadataLastUrl, url)) return existing;

  clearEntryUrlMetadataTimer();
  const requestId = state.entryUrlMetadataRequestId + 1;
  state.entryUrlMetadataRequestId = requestId;
  state.entryUrlMetadataStatus = "loading";
  state.entryUrlMetadataError = "";
  state.entryUrlMetadataLastUrl = url;
  if (!existing || !sameEntryUrl(existing.url, url)) state.entryUrlMetadataDraft = null;
  if (!options.quiet) refreshComposeAfterUrlMetadata();

  try {
    const payload = await inspectEntryUrl(url, state.settings);
    if (requestId !== state.entryUrlMetadataRequestId) return null;

    const preview = normalizeInspectedLinkPreview(payload, url);
    state.entryUrlMetadataDraft = preview;
    state.entryUrlMetadataRemoved = false;
    state.entryUrlMetadataStatus = preview ? "ready" : "empty";
    applyPlaceLocationFromUrlInspection(payload, url);
    if (!options.quiet) refreshComposeAfterUrlMetadata();
    return preview;
  } catch (error) {
    if (requestId !== state.entryUrlMetadataRequestId) return null;
    state.entryUrlMetadataStatus = "error";
    state.entryUrlMetadataError = error instanceof Error ? error.message : "URL could not be read";
    if (!options.quiet) refreshComposeAfterUrlMetadata();
    return null;
  }
}

async function ensureEntryUrlMetadataForSave(value, entry) {
  const url = validHttpEntryUrl(value);
  if (!url || state.entryUrlMetadataRemoved || currentLinkPreview(entry, url)) return;
  await lookupEntryUrlMetadata(url, { force: true, quiet: true });
}

function applyPlaceLocationFromUrlInspection(payload, url) {
  const location = locationDraftFromInspectedPlace(payload?.place);
  if (!isComposeLocationEnabled()) return;
  if (!location || !shouldApplyUrlPlaceLocation(url)) return;

  state.entryLocationDraft = location;
  state.entryLocationQuery = location.locationQuery;
  state.entryLocationError = "";
  state.isChangingEntryLocation = false;
}

function shouldApplyUrlPlaceLocation(url) {
  if (state.isChangingEntryLocation || state.entryLocationDraft) return false;
  const entry = state.composeEntryId ? getEntry(state.composeEntryId) : null;
  if (!entry) return true;
  if (!sameEntryUrl(url, entry.url)) return true;
  return !entryLocationLabel(entry);
}

function locationDraftFromInspectedPlace(place) {
  if (!place?.isRelevantPlace) return null;

  const lat = geoNumberFromValue(place.lat);
  const lng = geoNumberFromValue(place.lng);
  const name = cleanPreviewText(place.name);
  const address = cleanPreviewText(place.address);
  const city = cleanPreviewText(place.city);
  const region = cleanPreviewText(place.state);
  const country = cleanPreviewText(place.country);
  const display = [name, address].filter(Boolean).join(" | ") || address || name || city;
  const query = address || name || city || display;

  if (!query && (!Number.isFinite(lat) || !Number.isFinite(lng))) return null;

  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    locationQuery: query,
    locationDisplayName: display || (Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : ""),
    locationCity: city,
    locationRegion: region,
    locationCountry: country,
    locationAccuracy: null,
    geotaggedAt: new Date().toISOString(),
    geotagStatus: "ready"
  };
}

function geoNumberFromValue(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function renderUrlField(entry) {
  const value = entryFormValue(entry, "url", entry?.url || "");
  const preview = currentLinkPreview(entry, value);
  const helper = state.entryUrlMetadataError ||
    (state.entryUrlMetadataStatus === "loading" ? "reading URL..." : "") ||
    (state.entryUrlMetadataStatus === "empty" ? "no sharing preview found" : "") ||
    (preview ? "" : "optional");

  return `
    <div class="field">
      <div class="field-label-row">
        <span class="field-label">URL</span>
        ${preview ? '<button class="inline-link" data-action="remove-entry-url-metadata" type="button">REMOVE PREVIEW</button>' : ""}
      </div>
      <input class="field-input" id="entry-url-input" value="${esc(value)}" placeholder="https://example.com" autocomplete="url">
      ${preview ? renderLinkPreview(preview, { mode: "form" }) : ""}
      ${helper ? `<span class="field-helper ${state.entryUrlMetadataError ? "accent" : ""}">${esc(helper)}</span>` : ""}
    </div>
  `;
}

function renderVisibilityField(entry) {
  const value = normalizeEntryVisibility(entryFormValue(entry, "visibility", entry?.visibility || "public"));
  return `
    <label class="field">
      <span class="field-label">Visibility</span>
      <select class="field-input" id="entry-visibility-input">
        <option value="public" ${value === "public" ? "selected" : ""}>Public</option>
        <option value="collaborators" ${value === "collaborators" ? "selected" : ""}>Collaborators</option>
        <option value="private" ${value === "private" ? "selected" : ""}>Private</option>
      </select>
      <span class="field-helper">public: anyone | collaborators: trip collaborators | private: only you</span>
    </label>
  `;
}

function renderLinkPreview(preview, options = {}) {
  if (!hasLinkPreview(preview)) return "";
  const mode = options.mode || "summary";
  const image = preview.imageUrl
    ? `<img class="link-preview-image" src="${esc(preview.imageUrl)}" alt="${esc(preview.title || "link preview")}">`
    : "";
  const body = `
    ${image ? `<div class="link-preview-media">${image}</div>` : ""}
    <div class="link-preview-copy">
      ${preview.title ? `<div class="link-preview-title">${esc(preview.title)}</div>` : ""}
      ${preview.description ? `<div class="link-preview-description">${esc(preview.description)}</div>` : ""}
    </div>
  `;

  const classes = `link-preview ${mode}${preview.imageUrl ? " has-image" : ""}`;
  return options.href
    ? `<a class="${esc(classes)}" href="${esc(options.href)}" target="_blank" rel="noreferrer">${body}</a>`
    : `<div class="${esc(classes)}">${body}</div>`;
}

function renderEntryLinkPreview(entry, mode = "summary") {
  const preview = entryLinkPreview(entry);
  if (!preview || !entry?.url) return "";
  return renderLinkPreview(preview, { mode, href: entry.url });
}

function composePhotoList(entry) {
  const removed = state.entryPhotoRemovedIds || new Set();
  const existing = entryPhotos(entry).filter(photo => !removed.has(photo.photoAssetId));
  return [
    ...existing,
    ...(Array.isArray(state.entryPhotoDrafts) ? state.entryPhotoDrafts : [])
  ];
}

function renderPhotoField(entry) {
  const photos = composePhotoList(entry);
  const helperParts = [];
  if (photos.length) {
    helperParts.push(plural(photos.length, "photo"));
    const pending = photos
      .map(photoStatus)
      .map(status => status.label)
      .filter(Boolean);
    if (pending.length) helperParts.push(uniqueLabels(pending).join(" | "));
  } else {
    helperParts.push("optional");
  }
  if (state.entryPhotoNote) helperParts.push(state.entryPhotoNote);
  const helper = state.entryPhotoError || helperParts.filter(Boolean).join(" | ");

  for (const photo of photos) ensureEntryPhotoCached(photo).catch(() => {});

  return `
    <div class="field photo-field">
      <div class="field-label-row">
        <span class="field-label">Photos</span>
      </div>
      ${photos.length ? `
        <div class="photo-edit-grid">
          ${photos.map(renderEditablePhoto).join("")}
        </div>
      ` : ""}
      <input class="file-input" id="entry-photo-input" type="file" accept="image/*,video/*" multiple>
      <label class="action-link file-picker-link" for="entry-photo-input">${photos.length ? "ADD MEDIA" : "CHOOSE MEDIA"}</label>
      <span class="field-helper ${state.entryPhotoError ? "accent" : ""}">${esc(helper)}</span>
    </div>
  `;
}

function renderEditablePhoto(photo) {
  const url = getCachedPhotoUrl(photo.photoAssetId);
  const isVideo = (photo.photoMime || "").startsWith("video/");
  const status = photoStatus(photo);
  const kind = isVideo ? "video" : "photo";
  const label = status.label || `loading ${kind}...`;
  return `
    <div class="photo-edit-item">
      ${url
        ? (isVideo
            ? `<video class="photo-preview" src="${esc(url)}" controls playsinline preload="metadata"></video>`
            : `<img class="photo-preview" src="${esc(url)}" alt="selected photo">`)
        : `<div class="entry-photo-placeholder form">${esc(label)}</div>`}
      <button class="inline-link" data-action="remove-entry-photo" data-photo-asset-id="${esc(photo.photoAssetId)}" type="button">REMOVE</button>
    </div>
  `;
}

function renderCompose() {
  const trip = getTrip(state.currentTripId);
  const entry = state.composeEntryId ? getEntry(state.composeEntryId) : null;
  const title = entry ? "Edit entry" : "New entry";
  const locationLabel = entry
    ? entryLocationLabel(entry)
    : currentPositionLabel();
  const timestampFallback = state.composeInitialSnapshot?.timestampInput ||
    toDateTimeInputValue(entry?.timestamp || new Date().toISOString());
  const actions = [
    '<button class="action-link" data-action="save-entry" type="button">SAVE</button>',
    entry ? '<button class="action-link destructive" data-action="delete-entry" type="button">DELETE</button>' : ""
  ].filter(Boolean).join("");

  $("compose-body").innerHTML = `
    <div class="map-panel compact"><div class="map-canvas" id="compose-location-map"></div></div>
    <div class="overlay-topbar">
      <button class="back-btn" data-action="compose-back" type="button">BACK</button>
      <div class="compose-head-actions">${actions}</div>
    </div>
    <h2 class="screen-title">${esc(title)}</h2>
    <div class="trip-route" style="margin-bottom:20px;">in <em>${esc(trip?.title || "")}</em></div>

    <label class="field">
      <span class="field-label">Title optional</span>
      <input class="field-input" id="entry-title-input" value="${esc(entryFormValue(entry, "title", entry?.title || ""))}" placeholder="a thought, a place, a moment" autocomplete="off">
    </label>

    <label class="field">
      <span class="field-label">Description</span>
      <textarea class="field-textarea" id="entry-description-input" placeholder="write...">${esc(entryFormValue(entry, "description", entryDescription(entry)))}</textarea>
    </label>

    ${renderVisibilityField(entry)}

    ${renderUrlField(entry)}

    ${renderPhotoField(entry)}

    <label class="field">
      <span class="field-label">When</span>
      <input class="field-input" id="entry-time-input" type="datetime-local" value="${esc(entryFormValue(entry, "timestampInput", timestampFallback))}">
    </label>

    ${renderLocationField(entry, locationLabel)}
  `;

  requestAnimationFrame(renderComposeMap);
}

async function geocodeEntryLocationFromForm() {
  if (!isComposeLocationEnabled()) return;
  captureEntryFormDraft();
  const input = $("location-query-input");
  const query = input?.value || "";
  clearConfirmation("compose");
  state.entryLocationQuery = query;
  state.entryLocationError = "";

  try {
    const geocode = await geocodeAddress(query);
    state.entryLocationDraft = geocode;
    state.entryLocationQuery = geocode.locationQuery;
    state.isChangingEntryLocation = false;
    renderCompose();
    toast("location found");
  } catch (error) {
    state.entryLocationError = error instanceof Error ? error.message : "location not found";
    renderCompose();
    requestAnimationFrame(() => $("location-query-input")?.focus());
  }
}

async function selectEntryPhotos(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;

  captureEntryFormDraft();
  clearConfirmation("compose");
  state.entryPhotoNote = "";

  const imageFiles = list.filter(f => f.type.startsWith("image/"));
  const videoFiles = list.filter(f => f.type.startsWith("video/"));

  const processed = [];

  if (imageFiles.length) {
    state.entryPhotoError = `processing ${plural(imageFiles.length, "photo")}...`;
    renderCompose();
    for (const file of imageFiles) {
      processed.push(await processPhotoFile(file));
    }
  }

  for (const file of videoFiles) {
    state.entryPhotoError = "compressing video...";
    renderCompose();
    try {
      processed.push(await processVideoFile(file, pct => {
        state.entryPhotoError = `compressing video... ${Math.round(pct * 100)}%`;
        renderCompose();
      }));
    } catch (error) {
      state.entryPhotoError = "";
      renderCompose();
      throw error;
    }
  }

  state.entryPhotoDrafts = [
    ...(Array.isArray(state.entryPhotoDrafts) ? state.entryPhotoDrafts : []),
    ...processed.map(item => item.metadata)
  ];
  state.entryPhotoError = "";
  const photoNotes = [];
  const firstCaptured = processed.find(item => item.exif?.capturedAt);

  if (firstCaptured?.exif?.capturedAt && !state.composeEntryId) {
    state.entryFormDraft ||= {};
    state.entryFormDraft.timestampInput = toDateTimeInputValue(firstCaptured.exif.capturedAt);
    photoNotes.push("time from photo");
  }

  const firstLocated = processed.find(item => Number.isFinite(item.exif?.lat) && Number.isFinite(item.exif?.lng));
  if (firstLocated && !state.entryLocationDraft && isComposeLocationEnabled()) {
    const lat = firstLocated.exif.lat;
    const lng = firstLocated.exif.lng;
    try {
      state.entryLocationDraft = await reverseGeocodeCoordinates(lat, lng);
    } catch {
      state.entryLocationDraft = {
        lat,
        lng,
        locationQuery: "photo location",
        locationDisplayName: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        locationCity: "",
        locationRegion: "",
        locationCountry: "",
        locationAccuracy: null,
        geotaggedAt: new Date().toISOString(),
        geotagStatus: "ready"
      };
    }
    state.entryLocationQuery = state.entryLocationDraft.locationQuery;
    photoNotes.push("location from photo");
  }

  state.entryPhotoNote = photoNotes.join(" | ");
  renderCompose();

  const addedParts = [
    imageFiles.length ? plural(imageFiles.length, "photo") : "",
    videoFiles.length ? plural(videoFiles.length, "video") : ""
  ].filter(Boolean);
  toast(`${addedParts.join(" and ")} added`);
}

async function saveEntryFromForm() {
  const trip = getTrip(state.currentTripId);
  if (!trip) return;
  assertTripWritable(trip);
  if (!hasProfileName()) {
    openSetupScreen();
    return;
  }

  const currentEntry = state.composeEntryId
    ? state.entries.find(entry => entry.id === state.composeEntryId) || null
    : null;
  const title = $("entry-title-input")?.value || "";
  const description = $("entry-description-input")?.value.trim() || "";
  const url = $("entry-url-input")?.value || "";
  const photos = composePhotoList(currentEntry);
  const hasPhoto = photos.length > 0;

  if (!entryHasRequiredContent({ title, description, url, hasPhoto })) {
    toast("add a title, description, URL, or photo");
    return;
  }

  await ensureEntryUrlMetadataForSave(url, currentEntry);
  const linkPreview = currentLinkPreview(currentEntry, url);
  const fields = {
    title,
    description,
    body: description,
    visibility: normalizeEntryVisibility($("entry-visibility-input")?.value || "public"),
    url,
    ...linkPreviewFields(linkPreview),
    ...photoFieldsFromList(photos),
    timestamp: fromDateTimeInputValue($("entry-time-input")?.value || ""),
    dateUpdated: new Date().toISOString()
  };

  if (state.composeEntryId) {
    const index = state.entries.findIndex(entry => entry.id === state.composeEntryId);
    if (index < 0) return;
    if (!canManageEntry(state.entries[index])) throw new Error("You cannot edit this entry.");
    if (!isComposeLocationEnabled(state.entries[index])) {
      Object.assign(fields, emptyEntryLocationFields("skipped"));
    } else if (state.entryLocationDraft) {
      Object.assign(fields, locationFieldsFromDraft(state.entryLocationDraft));
    } else if (state.entries[index].geotagStatus === "skipped") {
      Object.assign(fields, emptyEntryLocationFields(""));
    }
    const nextEntry = normalizeEntry({
      ...state.entries[index],
      ...fields
    });
    queueEntityPatch("entry", state.entries[index], nextEntry, ENTRY_FIELDS);
    toast("entry updated");
  } else {
    if (!isComposeLocationEnabled()) {
      Object.assign(fields, emptyEntryLocationFields("skipped"));
    } else if (state.entryLocationDraft) {
      Object.assign(fields, locationFieldsFromDraft(state.entryLocationDraft));
    } else {
      const position = await positionForNewEntry();
      if (position) {
        fields.lat = position.lat;
        fields.lng = position.lng;
        fields.locationAccuracy = position.accuracy;
        fields.geotaggedAt = position.capturedAt;
        fields.geotagStatus = "ready";
        fields.locationCity = "";
        fields.locationRegion = "";
        fields.locationCountry = "";
      } else {
        fields.geotagStatus = state.geolocationStatus === "denied" ? "denied" : "unavailable";
      }
    }
    fields.authorProfileId = state.profile?.id || "";
    fields.authorName = state.profile?.name || "";
    const entry = createEntry(trip.id, fields);
    queueEntityCreate("entry", entry);
    toast("entry saved");
  }

  saveAndFlushSync();
  closeCompose();
  if (state.currentEntryId) renderEntry();
  if (state.currentTripId) renderTrip();
  renderAll();
  schedulePhotoWork();
}

function deleteCurrentEntry(entryId = state.currentEntryId) {
  const entry = getEntry(entryId);
  if (!entry) return;
  assertTripWritable(getTrip(entry.tripId));
  if (!canManageEntry(entry)) throw new Error("You cannot delete this entry.");

  queueLocalMutation("entry", entry.id, "_delete", true);

  saveAndFlushSync();
  clearConfirmation();
  if (state.composeEntryId === entry.id) closeCompose();
  if (state.currentEntryId === entry.id) closeEntry();
  if (state.currentTripId) renderTrip();
  renderAll();
  toast("entry deleted");
}

function openTripForm() {
  const trip = getTrip(state.currentTripId);
  if (!trip) return;
  assertTripWritable(trip);
  state.editingTripId = trip.id;
  renderTripForm();
  openOverlay("trip-form-overlay");
  requestAnimationFrame(() => $("trip-title-input")?.focus());
}

function closeTripForm() {
  closeOverlay("trip-form-overlay");
  state.editingTripId = null;
  clearConfirmation("trip-form");
}

function renderTripForm() {
  const trip = getTrip(state.editingTripId);
  if (!trip) return;
  const actions = [
    '<button class="action-link" data-action="save-trip" type="button">SAVE</button>',
    isTripOwner(trip) ? '<button class="action-link destructive" data-action="delete-trip" type="button">DELETE</button>' : ""
  ].filter(Boolean).join("");

  $("trip-form-body").innerHTML = `
    <div class="overlay-topbar">
      <button class="back-btn" data-action="trip-form-back" type="button">BACK</button>
      <div class="trip-form-head-actions">${actions}</div>
    </div>
    <h2 class="screen-title">Edit trip</h2>

    <label class="field">
      <span class="field-label">Title</span>
      <input class="field-input" id="trip-title-input" value="${esc(trip.title)}" autocomplete="off">
    </label>

    <div class="field-row">
      <label class="field">
        <span class="field-label">Start</span>
        <input class="field-input" id="trip-start-input" type="date" value="${esc(trip.startIso)}">
      </label>
      <label class="field">
        <span class="field-label">End</span>
        <input class="field-input" id="trip-end-input" type="date" value="${esc(trip.endIso)}">
      </label>
    </div>
  `;
}

function saveTripFromForm() {
  const trip = getTrip(state.editingTripId);
  if (!trip) return;
  assertTripWritable(trip);

  const title = $("trip-title-input")?.value.trim() || "";
  if (!title) {
    toast("title required");
    return;
  }

  const index = state.trips.findIndex(candidate => candidate.id === trip.id);
  if (index < 0) return;

  const currentTrip = state.trips[index];
  const nextTrip = normalizeTrip({
    ...state.trips[index],
    title,
    startIso: $("trip-start-input")?.value || trip.startIso,
    endIso: $("trip-end-input")?.value || trip.endIso,
    dateUpdated: new Date().toISOString()
  });
  queueEntityPatch("trip", currentTrip, nextTrip, TRIP_FIELDS);

  saveAndFlushSync();
  closeTripForm();
  renderTrip();
  renderAll();
  toast("trip updated");
}

function deleteCurrentTrip() {
  const trip = getTrip(state.editingTripId);
  if (!trip) return;
  assertTripWritable(trip);
  if (!isTripOwner(trip)) throw new Error("Only the trip owner can delete this trip.");

  for (const entry of visibleTripEntries(trip.id)) {
    queueLocalMutation("entry", entry.id, "_delete", true);
  }
  queueLocalMutation("trip", trip.id, "_delete", true);

  saveAndFlushSync();
  clearConfirmation("trip-form");
  closeTripForm();
  closeTrip();
  renderAll();
  toast("trip deleted");
}

function createTripFromInput(value) {
  const title = value.trim();
  if (!title) return;
  if (!hasProfileName()) {
    openSetupScreen();
    return;
  }

  const trip = createTrip(title);
  trip.ownerProfileId = state.profile?.id || "";
  trip.ownerName = state.profile?.name || "";
  queueEntityCreate("trip", trip);
  saveAndFlushSync();

  const input = $("main-input");
  input.value = "";
  state.search = "";
  $("input-status").textContent = "";
  renderAll();
  showTrip(trip.id);
  toast("trip created");
}

function openOverlay(id) {
  const overlay = $(id);
  if (overlay.classList.contains("active")) {
    overlay.style.zIndex = String(++overlayZIndex);
    syncBodyScroll();
    return;
  }

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlayFocusStack.push({ id, previousFocus });
  overlay.dataset.closeToken = "";
  overlay.style.zIndex = String(++overlayZIndex);
  overlay.inert = false;
  overlay.classList.add("active");
  overlay.setAttribute("aria-hidden", "false");
  overlay.scrollTop = 0;
  syncBodyScroll();
}

function closeOverlay(id) {
  const overlay = $(id);
  moveFocusBeforeHiding(overlay, id);
  forceFocusOutside(overlay);
  overlay.classList.remove("active");
  overlay.setAttribute("aria-hidden", "true");
  overlay.inert = true;
  const closeToken = createId("close");
  overlay.dataset.closeToken = closeToken;
  setTimeout(() => {
    if (!overlay.classList.contains("active") && overlay.dataset.closeToken === closeToken) {
      overlay.style.zIndex = "";
      overlay.dataset.closeToken = "";
    }
  }, 360);
  syncBodyScroll();
}

function moveFocusBeforeHiding(overlay, id) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !overlay.contains(active)) return;

  const previousFocus = previousFocusForOverlay(id);
  const target = isVisibleFocusTarget(previousFocus, overlay)
    ? previousFocus
    : safeFocusTargetAfterClose(overlay);

  focusElement(target);
}

function forceFocusOutside(overlay) {
  if (!overlay.contains(document.activeElement)) return;

  focusElement(safeFocusTargetAfterClose(overlay));
  if (overlay.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

function previousFocusForOverlay(id) {
  for (let index = overlayFocusStack.length - 1; index >= 0; index -= 1) {
    const item = overlayFocusStack[index];
    overlayFocusStack.splice(index, 1);
    if (item.id === id) return item.previousFocus;
  }
  return null;
}

function isVisibleFocusTarget(element, closingOverlay) {
  if (!(element instanceof HTMLElement) || !element.isConnected || closingOverlay.contains(element)) return false;
  if (element.closest("[aria-hidden='true']")) return false;
  if (element.closest("[inert]")) return false;
  return true;
}

function safeFocusTargetAfterClose(closingOverlay) {
  const activeOverlays = Array.from(document.querySelectorAll(".overlay.active"))
    .filter(overlay => overlay !== closingOverlay && !overlay.inert && overlay.getAttribute("aria-hidden") !== "true");
  const parentOverlay = activeOverlays[activeOverlays.length - 1];

  if (parentOverlay) {
    return parentOverlay.querySelector(".back-btn") ||
      firstVisibleFocusTarget(parentOverlay, closingOverlay) ||
      parentOverlay.querySelector(".overlay-body");
  }

  return $("main-input") || $("app");
}

function firstVisibleFocusTarget(root, closingOverlay) {
  const selector = "button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])";
  return Array.from(root.querySelectorAll(selector))
    .find(element => isVisibleFocusTarget(element, closingOverlay)) || null;
}

function focusElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

function syncBodyScroll() {
  const anyOpen = Array.from(document.querySelectorAll(".overlay")).some(overlay => overlay.classList.contains("active"));
  document.body.classList.toggle("no-scroll", anyOpen);
}

function closeTopOverlay() {
  if ($("setup-overlay").classList.contains("active")) return;
  const top = topActiveOverlay();
  if (!top) return;
  if (top.id === "activity-overlay") return closeActivityScreen();
  if (top.id === "share-overlay") return closeShareScreen();
  if (top.id === "link-overlay") return closeLinkScreen();
  if (top.id === "trip-form-overlay") return closeTripForm();
  if (top.id === "compose-overlay") return requestCloseCompose();
  if (top.id === "entry-overlay") return closeEntry();
  if (top.id === "trip-overlay") return closeTrip();
}

function topActiveOverlay() {
  return Array.from(document.querySelectorAll(".overlay.active"))
    .sort((left, right) => numericZIndex(right) - numericZIndex(left))[0] || null;
}

function numericZIndex(element) {
  const value = Number.parseInt(getComputedStyle(element).zIndex, 10);
  return Number.isFinite(value) ? value : 0;
}

function handleConfirmationAction(confirmed) {
  const confirmation = state.confirmation;
  if (!confirmation) return;

  if (!confirmed) {
    const view = confirmation.view;
    clearConfirmation(view);
    return;
  }

  clearConfirmation(confirmation.view);

  if (confirmation.action === "delete-entry") {
    state.currentEntryId = confirmation.contextId;
    runAction(deleteCurrentEntry);
    return;
  }

  if (confirmation.action === "delete-trip") {
    state.editingTripId = confirmation.contextId;
    runAction(deleteCurrentTrip);
    return;
  }

  if (confirmation.action === "delete-comment") {
    runAction(() => deleteComment(confirmation.contextId));
    return;
  }

  if (confirmation.action === "discard-compose") {
    closeCompose();
  }
}

function syncOpenViews() {
  if (state.currentEntryId && !getEntry(state.currentEntryId)) {
    closeEntry();
  }

  if (state.shareTripId && (!getTrip(state.shareTripId) || (state.shareEntryId && !getEntry(state.shareEntryId)))) {
    closeShareScreen();
  }

  if (state.editingTripId && !getTrip(state.editingTripId)) {
    closeTripForm();
  }

  if (state.currentTripId && !getTrip(state.currentTripId)) {
    closeTrip();
  }

  if ($("trip-overlay").classList.contains("active") && state.currentTripId) {
    renderTrip();
  }

  if ($("entry-overlay").classList.contains("active") && state.currentEntryId) {
    renderEntry();
  }

  if ($("compose-overlay").classList.contains("active") && state.currentTripId) {
    renderCompose();
  }

  if ($("trip-form-overlay").classList.contains("active") && state.editingTripId) {
    renderTripForm();
  }

  if ($("link-overlay").classList.contains("active")) {
    renderLinkScreen();
  }

  if ($("share-overlay").classList.contains("active")) {
    renderShareScreen();
  }

  if ($("activity-overlay").classList.contains("active")) {
    renderActivityScreen();
  }

  if ($("setup-overlay").classList.contains("active")) {
    renderSetupScreen();
  }
}

function handleSyncChange() {
  save();
  configureSync();
  renderAll();
  syncOpenViews();
}

function configureSync() {
  if (!state.settings.syncBaseUrl) {
    profileSync?.stop();
    profileSync = null;
    for (const sync of tripSyncs.values()) sync.stop();
    tripSyncs.clear();
    state.syncStatus = "local";
    renderSyncIndicator();
    return;
  }

  if (state.profile?.code) {
    if (!profileSync || profileSync.code !== state.profile.code) {
      profileSync?.stop();
      profileSync = new PassageSync({
        code: state.profile.code,
        state,
        save,
        onStatus(status) {
          state.syncStatus = status;
          renderSyncIndicator();
          if ($("link-overlay").classList.contains("active")) renderLinkScreen();
        },
        onChange: handleSyncChange,
        onRoom(room) {
          const profile = normalizeProfile(room?.profile);
          if (profile) {
            state.profile = mergeProfile(state.profile, profile, room.code || profile.code || "");
            save();
          } else if (room?.code && state.profile) {
            state.profile.code = room.code;
            save();
          }
          renderSyncIndicator();
        }
      });
      profileSync.start();
    }
  } else {
    profileSync?.stop();
    profileSync = null;
    state.syncStatus = "unlinked";
  }

  const desiredTripSyncs = new Map();
  for (const trip of visibleTrips(state.trips)) {
    if (!trip.sharedCode) continue;
    desiredTripSyncs.set(trip.sharedCode, trip.id);
    sharedSyncState(trip.sharedCode, trip.id);
  }

  for (const [code, sync] of tripSyncs.entries()) {
    if (!desiredTripSyncs.has(code)) {
      sync.stop();
      tripSyncs.delete(code);
    }
  }

  for (const [code, tripId] of desiredTripSyncs.entries()) {
    if (tripSyncs.has(code)) continue;
    const sync = new PassageSync({
      kind: "trips",
      code,
      state,
      syncState: () => sharedSyncState(code, tripId),
      viewer: () => sharedTripViewer(code),
      save,
      onStatus() {},
      onChange: handleSyncChange,
      onRoom(room) {
        const trip = getTrip(room?.tripId || tripId);
        if (trip && room?.code && trip.sharedCode !== room.code) {
          trip.sharedCode = room.code;
          handleSyncChange();
        }
      },
      onSnapshot(payload) {
        applySharedTripPayload(payload);
      }
    });
    tripSyncs.set(code, sync);
    sync.start();
  }

  renderSyncIndicator();
}

function bindEvents() {
  const input = $("main-input");
  const status = $("input-status");
  const linkDeviceButton = $("link-device-btn");
  const activityButton = $("activity-btn");
  $("confirm-root")?.addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "confirm-toast-yes") return handleConfirmationAction(true);
    if (action.dataset.action === "confirm-toast-no") return handleConfirmationAction(false);
  });

  input.addEventListener("input", () => {
    const value = input.value.trim();
    state.search = value;
    status.textContent = value ? "press enter to create a trip, or keep typing to search" : "";
    renderList();
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      createTripFromInput(input.value);
    }

    if (event.key === "Escape") {
      input.value = "";
      state.search = "";
      status.textContent = "";
      renderList();
      input.blur();
    }
  });

  $("trip-list").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (action?.dataset.action === "open-trip-activity") {
      event.preventDefault();
      event.stopPropagation();
      return openActivityScreen({ tripId: action.dataset.tripId });
    }

    const item = event.target.closest(".trip-item");
    if (item) showTrip(item.dataset.tripId);
  });

  linkDeviceButton?.addEventListener("click", () => {
    runAction(openLinkScreen);
  });

  activityButton?.addEventListener("click", () => {
    openActivityScreen();
  });

  $("trip-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "trip-back") return closeTrip();
      if (action.dataset.action === "toggle-trip-sort") {
        state.tripSort = state.tripSort === "oldest" ? "newest" : "oldest";
        return renderTrip();
      }
      if (action.dataset.action === "open-trip-activity") return openActivityScreen({ tripId: action.dataset.tripId || state.currentTripId });
      if (action.dataset.action === "compose-journal") return runAction(() => openCompose());
      if (action.dataset.action === "share-trip") return runAction(() => openShareScreen({ tripId: state.currentTripId }));
      if (action.dataset.action === "edit-trip") return runAction(() => openTripForm());
      if (action.dataset.action === "toggle-entry-comments") return toggleEntryComments(action.dataset.entryId);
      if (action.dataset.action === "edit-comment") return startEditComment(action.dataset.commentId);
      if (action.dataset.action === "save-comment-edit") return runAction(() => saveEditedComment(action.dataset.commentId));
      if (action.dataset.action === "cancel-comment-edit") return cancelEditComment();
      if (action.dataset.action === "delete-comment") return requestDeleteComment(action.dataset.commentId);
    }

    if (maybeSelectCommentFromEvent(event)) return;

    const entry = event.target.closest(".entry");
    if (entry && !event.target.closest("a, button, input, textarea, .comment")) openEntry(entry.dataset.entryId);
  });

  $("entry-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) {
      maybeSelectCommentFromEvent(event);
      return;
    }
    if (action.dataset.action === "entry-back") return closeEntry();
    if (action.dataset.action === "entry-nav") {
      const targetId = action.dataset.entryId;
      if (targetId && targetId !== state.currentEntryId) openEntry(targetId);
      return;
    }
    if (action.dataset.action === "entry-prev") {
      const prevEntries = visibleTripEntries(getEntry(state.currentEntryId)?.tripId);
      const prevIdx = prevEntries.findIndex(e => e.id === state.currentEntryId);
      if (prevIdx > 0) openEntry(prevEntries[prevIdx - 1].id);
      return;
    }
    if (action.dataset.action === "entry-next") {
      const nextEntries = visibleTripEntries(getEntry(state.currentEntryId)?.tripId);
      const nextIdx = nextEntries.findIndex(e => e.id === state.currentEntryId);
      if (nextIdx !== -1 && nextIdx < nextEntries.length - 1) openEntry(nextEntries[nextIdx + 1].id);
      return;
    }
    if (action.dataset.action === "share-entry") return runAction(() => openShareScreen({ entryId: state.currentEntryId }));
    if (action.dataset.action === "edit-entry") {
      const entry = getEntry(state.currentEntryId);
      if (!entry) return;
      state.currentTripId = entry.tripId;
      return runAction(() => openCompose(entry.id));
    }
    if (action.dataset.action === "delete-entry") {
      const entry = getEntry(state.currentEntryId);
      if (entry && isReadOnlyTrip(getTrip(entry.tripId))) return toast("Shared trips are read only for now.");
      return openConfirmation("entry", "Are you sure?", "delete-entry", state.currentEntryId);
    }
    if (action.dataset.action === "edit-comment") return startEditComment(action.dataset.commentId);
    if (action.dataset.action === "save-comment-edit") return runAction(() => saveEditedComment(action.dataset.commentId));
    if (action.dataset.action === "cancel-comment-edit") return cancelEditComment();
    if (action.dataset.action === "delete-comment") return requestDeleteComment(action.dataset.commentId);
  });

  $("entry-overlay").addEventListener("input", event => {
    if (event.target?.id === "comment-input") {
      state.commentDraft = event.target.value;
    } else if (event.target?.classList?.contains("comment-edit-input")) {
      state.commentEditDraft = event.target.value;
    }
  });

  $("entry-overlay").addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target?.id === "comment-input") {
      event.preventDefault();
      runAction(saveCommentFromForm);
      return;
    }

    if (event.target?.classList?.contains("comment-edit-input")) {
      if (event.key === "Enter") {
        event.preventDefault();
        runAction(() => saveEditedComment(event.target.dataset.commentId));
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEditComment();
      }
    }
  });

  $("trip-overlay").addEventListener("input", event => {
    if (event.target?.classList?.contains("inline-comment-input")) {
      state.inlineCommentDrafts.set(event.target.dataset.entryId, event.target.value);
    } else if (event.target?.classList?.contains("comment-edit-input")) {
      state.commentEditDraft = event.target.value;
    }
  });

  $("trip-overlay").addEventListener("keydown", event => {
    if (event.target?.classList?.contains("inline-comment-input")) {
      if (event.key === "Enter") {
        event.preventDefault();
        runAction(() => saveInlineCommentFromForm(event.target.dataset.entryId));
      }
      return;
    }

    if (!event.target?.classList?.contains("comment-edit-input")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      runAction(() => saveEditedComment(event.target.dataset.commentId));
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEditComment();
    }
  });

  $("compose-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "compose-back") return requestCloseCompose();
    if (action.dataset.action === "change-entry-location") {
      if (!isComposeLocationEnabled()) return;
      captureEntryFormDraft();
      clearConfirmation("compose");
      state.isChangingEntryLocation = true;
      state.entryLocationError = "";
      renderCompose();
      requestAnimationFrame(() => $("location-query-input")?.focus());
      return;
    }
    if (action.dataset.action === "cancel-location-change") {
      captureEntryFormDraft();
      clearConfirmation("compose");
      state.isChangingEntryLocation = false;
      state.entryLocationError = "";
      renderCompose();
      return;
    }
    if (action.dataset.action === "remove-entry-photo") {
      captureEntryFormDraft();
      clearConfirmation("compose");
      const assetId = action.dataset.photoAssetId || "";
      state.entryPhotoDrafts = (state.entryPhotoDrafts || []).filter(photo => photo.photoAssetId !== assetId);
      const entry = state.composeEntryId ? getEntry(state.composeEntryId) : null;
      if (entryPhotos(entry).some(photo => photo.photoAssetId === assetId)) {
        state.entryPhotoRemovedIds ||= new Set();
        state.entryPhotoRemovedIds.add(assetId);
      }
      state.entryPhotoError = "";
      state.entryPhotoNote = "";
      renderCompose();
      return;
    }
    if (action.dataset.action === "remove-entry-url-metadata") {
      captureEntryFormDraft();
      clearEntryUrlMetadataTimer();
      clearConfirmation("compose");
      state.entryUrlMetadataDraft = null;
      state.entryUrlMetadataRemoved = true;
      state.entryUrlMetadataStatus = "";
      state.entryUrlMetadataError = "";
      renderCompose();
      requestAnimationFrame(() => $("entry-url-input")?.focus({ preventScroll: true }));
      return;
    }
    if (action.dataset.action === "geocode-entry-location") {
      geocodeEntryLocationFromForm().catch(error => {
        state.entryLocationError = error instanceof Error ? error.message : "location not found";
        renderCompose();
      });
      return;
    }
    if (action.dataset.action === "save-entry") {
      saveEntryFromForm().catch(error => {
        toast(error instanceof Error ? error.message : "entry could not be saved");
      });
      return;
    }
    if (action.dataset.action === "delete-entry") {
      if (!state.composeEntryId) return;
      return openConfirmation("compose", "Are you sure?", "delete-entry", state.composeEntryId);
    }
  });

  $("compose-overlay").addEventListener("input", event => {
    if (event.target?.id === "entry-url-input") {
      handleEntryUrlInput(event.target.value);
    }
  });

  $("compose-overlay").addEventListener("change", event => {
    if (event.target?.id === "entry-location-enabled-input") {
      captureEntryFormDraft();
      clearConfirmation("compose");
      state.entryLocationEnabled = Boolean(event.target.checked);
      state.isChangingEntryLocation = state.entryLocationEnabled ? state.isChangingEntryLocation : false;
      state.entryLocationError = "";
      renderCompose();
      if (state.entryLocationEnabled && !state.composeEntryId) {
        requestLocationForNewEntry();
      }
      requestAnimationFrame(() => $("entry-location-enabled-input")?.focus());
      return;
    }

    if (event.target?.id !== "entry-photo-input") return;
    const files = event.target.files;
    if (!files?.length) return;
    runAction(() => selectEntryPhotos(files));
  });

  $("compose-overlay").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.target?.id !== "location-query-input") return;
    event.preventDefault();
    geocodeEntryLocationFromForm().catch(error => {
      state.entryLocationError = error instanceof Error ? error.message : "location not found";
      renderCompose();
    });
  });

  $("trip-form-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "trip-form-back") return closeTripForm();
    if (action.dataset.action === "save-trip") return runAction(saveTripFromForm);
    if (action.dataset.action === "delete-trip") {
      const trip = getTrip(state.editingTripId);
      if (isReadOnlyTrip(trip)) return toast("Shared trips are read only for now.");
      return openConfirmation("trip-form", "Are you sure?", "delete-trip", state.editingTripId);
    }
  });

  $("link-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "link-back") return closeLinkScreen();
    if (action.dataset.action === "copy-link") return runAction(copyDeviceLink);
    if (action.dataset.action === "confirm-link-device") return runAction(() => linkDevice(state.pendingLinkCode, { replaceLocal: true }));
    if (action.dataset.action === "cancel-link-device") {
      state.pendingLinkCode = "";
      state.linkError = "";
      stripLinkQuery();
      closeLinkScreen();
      renderAll();
    }
  });

  $("share-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "share-back") return closeShareScreen();
    if (action.dataset.action === "copy-share-link") return runAction(() => copyShareLink(action.dataset.shareKind));
  });

  $("activity-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "activity-back") return closeActivityScreen();
    if (action.dataset.action === "open-activity-entry") return openActivityEntry(action.dataset.entryId);
  });

  $("setup-overlay").addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "save-setup-name") return runAction(saveSetupName);
  });

  $("setup-overlay").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.target?.id !== "setup-name-input") return;
    event.preventDefault();
    runAction(saveSetupName);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeTopOverlay();
  });
}

function init() {
  document.querySelectorAll(".overlay").forEach(overlay => {
    overlay.inert = true;
  });
  bindEvents();
  renderAll();
  configureSync();
  handleIncomingQueries();
  initGeolocation();
  registerServiceWorker();
  watchForAppUpdates();
}

init();

function isLocalHost() {
  const host = globalThis.location?.hostname || "";
  return host === "localhost" || host === "127.0.0.1";
}

function shouldUseServiceWorker() {
  return "serviceWorker" in navigator && globalThis.location?.protocol === "https:" && !isLocalHost();
}

function registerServiceWorker() {
  if (!shouldUseServiceWorker()) return;

  let isReloadingForServiceWorker = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (isReloadingForServiceWorker) return;
    isReloadingForServiceWorker = true;
    globalThis.location.reload();
  });

  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then(registration => {
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;

        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });

      setInterval(() => {
        registration.update().catch(() => {});
      }, 60_000);
    })
    .catch(() => {});
}

function watchForAppUpdates() {
  if (isLocalHost()) return;

  let didReload = false;
  const currentBuildId = globalThis.PASSAGE_BUILD_ID || "";

  async function checkVersion() {
    if (didReload || !currentBuildId) return;

    try {
      const versionUrl = new URL("./version.js", globalThis.location.href);
      versionUrl.searchParams.set("t", Date.now().toString());
      const response = await fetch(versionUrl, { cache: "no-store" });
      if (!response.ok) return;

      const nextBuildId = parseBuildId(await response.text());
      if (!nextBuildId || nextBuildId === currentBuildId) return;

      didReload = true;
      const registration = await navigator.serviceWorker?.getRegistration?.();
      await registration?.update?.().catch(() => {});
      globalThis.location.reload();
    } catch {
      // Stay on the current version if the version check is unavailable.
    }
  }

  setInterval(checkVersion, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkVersion();
  });
}

function parseBuildId(scriptText) {
  return scriptText.match(/PASSAGE_BUILD_ID\s*=\s*["']([^"']+)["']/)?.[1] || "";
}
