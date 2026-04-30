import { createId } from "./model.js";

const DB_NAME = "passage_photos";
const DB_VERSION = 1;
const STORE_NAME = "assets";
const MAX_PHOTO_EDGE = 1600;
const PHOTO_QUALITY = 0.78;
const PHOTO_MIME = "image/jpeg";
const MAX_VIDEO_EDGE = 1280;
const VIDEO_BITRATE = 1_500_000;
const AUDIO_BITRATE = 128_000;
const VIDEO_FPS = 30;
const MAX_VIDEO_DURATION_S = 180;

const objectUrls = new Map();
let dbPromise = null;

export function getCachedPhotoUrl(assetId) {
  return objectUrls.get(String(assetId || "")) || "";
}

export async function ensurePhotoObjectUrl(assetId) {
  const id = String(assetId || "");
  if (!id) return "";
  if (objectUrls.has(id)) return objectUrls.get(id);

  const asset = await getPhotoAsset(id);
  if (!asset?.blob) return "";

  const url = URL.createObjectURL(asset.blob);
  objectUrls.set(id, url);
  return url;
}

export async function putPhotoAsset(assetId, blob) {
  const id = String(assetId || "");
  if (!id || !(blob instanceof Blob)) return;

  const db = await openPhotoDb();
  await requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put({
    assetId: id,
    blob,
    mime: blob.type || PHOTO_MIME,
    size: blob.size || 0,
    updatedAt: new Date().toISOString()
  }));
}

export async function getPhotoAsset(assetId) {
  const id = String(assetId || "");
  if (!id) return null;

  const db = await openPhotoDb();
  return await requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id)) || null;
}

export async function hasPhotoAsset(assetId) {
  return Boolean(await getPhotoAsset(assetId));
}

export async function processPhotoFile(file) {
  if (!(file instanceof File) || !file.type.startsWith("image/")) {
    throw new Error("choose an image file");
  }

  const buffer = await file.arrayBuffer();
  const exif = readExif(buffer);
  const resized = await resizeImage(file);
  const assetId = createId("photo");

  await putPhotoAsset(assetId, resized.blob);
  objectUrls.set(assetId, URL.createObjectURL(resized.blob));

  return {
    assetId,
    blob: resized.blob,
    metadata: {
      photoAssetId: assetId,
      photoMime: resized.blob.type || PHOTO_MIME,
      photoWidth: resized.width,
      photoHeight: resized.height,
      photoSize: resized.blob.size || 0,
      photoUploadedAt: ""
    },
    exif
  };
}

export async function processVideoFile(file, onProgress) {
  if (!(file instanceof File) || !file.type.startsWith("video/")) {
    throw new Error("choose a video file");
  }

  const srcUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = srcUrl;
  video.playsInline = true;

  // play() is called synchronously before any await — still inside the
  // file-input change event's user gesture context. iOS requires a gesture
  // for unmuted playback; once granted, the element stays unlocked for
  // future plays even after the gesture context expires. AbortError is
  // expected because we pause immediately once metadata arrives.
  video.play().catch(e => { if (e.name !== "AbortError") video.muted = true; });

  const gps = await readVideoGps(file);

  await new Promise((resolve, reject) => {
    if (video.readyState >= 1) { resolve(); return; }
    video.onloadedmetadata = resolve;
    video.onerror = () => { URL.revokeObjectURL(srcUrl); reject(new Error("video could not be read")); };
  });

  // Pause and rewind regardless of whether the early play has resolved yet.
  // This may abort the early play (hence the AbortError catch above).
  video.pause();
  video.currentTime = 0;

  if (Number.isFinite(video.duration) && video.duration > MAX_VIDEO_DURATION_S) {
    URL.revokeObjectURL(srcUrl);
    throw new Error("video is too long (max 3 minutes)");
  }

  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  let blob = null;
  let width = sourceWidth || 0;
  let height = sourceHeight || 0;

  if (sourceWidth && sourceHeight) {
    try {
      ({ blob, width, height } = await transcodeVideo(video, onProgress));
    } catch (_) {
      // canvas+MediaRecorder not supported — fall through to raw
    }
  }

  URL.revokeObjectURL(srcUrl);

  if (!blob) {
    const MAX_RAW_BYTES = 50 * 1024 * 1024;
    if (file.size > MAX_RAW_BYTES) {
      throw new Error(`video could not be compressed and is too large (${Math.round(file.size / 1024 / 1024)} MB). Try a shorter clip.`);
    }
    blob = file;
  }

  const assetId = createId("video");
  await putPhotoAsset(assetId, blob);
  objectUrls.set(assetId, URL.createObjectURL(blob));

  return {
    assetId,
    blob,
    metadata: {
      photoAssetId: assetId,
      photoMime: blob.type || "video/mp4",
      photoWidth: width,
      photoHeight: height,
      photoSize: blob.size || 0,
      photoUploadedAt: ""
    },
    exif: { lat: gps.lat, lng: gps.lng }
  };
}

async function transcodeVideo(video, onProgress) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const scale = Math.min(1, MAX_VIDEO_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(2, Math.round(sourceWidth * scale / 2) * 2);
  const height = Math.max(2, Math.round(sourceHeight * scale / 2) * 2);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("canvas context unavailable");

  const canvasStream = canvas.captureStream(VIDEO_FPS);

  // The element was already unlocked with a user gesture in processVideoFile.
  // Route its audio through Web Audio so it goes to the stream, not speakers.
  let audioCtx = null;
  try {
    audioCtx = new AudioContext();
    // Give resume() up to 300ms; if audio was unlocked by the early play()
    // in processVideoFile it resolves instantly. Don't block transcoding on it.
    if (audioCtx.state === "suspended") {
      await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 300))]);
    }
    const source = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);
    for (const track of dest.stream.getAudioTracks()) canvasStream.addTrack(track);
  } catch (_) {
    audioCtx?.close();
    audioCtx = null;
  }

  const mimeTypes = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4;codecs=avc1",
    "video/mp4"
  ];
  const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || "";
  const recorderOptions = { videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE };
  if (mimeType) recorderOptions.mimeType = mimeType;

  const chunks = [];
  let recorder;
  try {
    recorder = new MediaRecorder(canvasStream, recorderOptions);
  } catch (_) {
    // Audio codec rejected — strip audio and retry video-only
    for (const track of canvasStream.getAudioTracks()) canvasStream.removeTrack(track);
    recorder = new MediaRecorder(canvasStream, recorderOptions);
  }

  recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
  recorder.start(100);

  const drawLoop = () => {
    if (video.ended) return;
    if (!video.paused) {
      ctx.drawImage(video, 0, 0, width, height);
      if (Number.isFinite(video.duration) && video.duration > 0) {
        onProgress?.(video.currentTime / video.duration);
      }
    }
    requestAnimationFrame(drawLoop);
  };

  await new Promise((resolve, reject) => {
    video.onended = resolve;
    video.onerror = () => reject(new Error("video processing failed"));
    video.play().then(() => requestAnimationFrame(drawLoop)).catch(reject);
  });

  recorder.stop();
  audioCtx?.close();

  const blob = await new Promise(resolve => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/mp4" }));
  });

  return { blob, width, height };
}

async function readVideoGps(file) {
  try {
    const chunkSize = 512 * 1024;
    const slices = [file.slice(0, chunkSize)];
    if (file.size > chunkSize) {
      slices.push(file.slice(Math.max(chunkSize, file.size - chunkSize)));
    }
    for (const slice of slices) {
      // Decode as latin-1 so every byte maps to a character — lets us regex-search
      // binary container data for the embedded ISO 6709 location string without
      // needing to parse the MP4 box structure.
      const text = new TextDecoder("latin1").decode(await slice.arrayBuffer());
      // ISO 6709: ±lat±lon[±alt]/ e.g. +37.785834-122.406417+000.000/
      const match = text.match(/([+-]\d{1,3}\.\d{3,10})([+-]\d{1,3}\.\d{3,10})[^/]*\//);
      if (match) {
        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        if (Number.isFinite(lat) && Number.isFinite(lng) &&
            Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          return { lat, lng };
        }
      }
    }
  } catch {
    // ignore
  }
  return { lat: null, lng: null };
}

function openPhotoDb() {
  if (!("indexedDB" in globalThis)) {
    return Promise.reject(new Error("Photo storage is unavailable in this browser."));
  }

  dbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "assetId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Photo storage could not be opened."));
  });

  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Photo storage failed."));
  });
}

async function resizeImage(file) {
  const image = await loadImage(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) throw new Error("photo could not be read");

  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("photo could not be resized");

  context.drawImage(image, 0, 0, width, height);
  URL.revokeObjectURL(image.dataset.objectUrl || "");

  const blob = await new Promise(resolve => canvas.toBlob(resolve, PHOTO_MIME, PHOTO_QUALITY));
  if (!blob) throw new Error("photo could not be resized");

  return { blob, width, height };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.dataset.objectUrl = url;
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("photo could not be read"));
    };
    image.src = url;
  });
}

function readExif(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {};

    let offset = 2;
    while (offset + 4 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;

      const marker = view.getUint8(offset + 1);
      const size = view.getUint16(offset + 2);
      if (marker === 0xe1 && hasExifHeader(view, offset + 4)) {
        return parseTiff(view, offset + 10, size - 8);
      }

      offset += 2 + size;
    }
  } catch {
    return {};
  }

  return {};
}

function hasExifHeader(view, offset) {
  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  return header.every((byte, index) => view.getUint8(offset + index) === byte);
}

function parseTiff(view, tiffStart, tiffLength) {
  const littleEndian = view.getUint16(tiffStart) === 0x4949;
  const bigEndian = view.getUint16(tiffStart) === 0x4d4d;
  if (!littleEndian && !bigEndian) return {};

  const firstIfdOffset = readUint32(view, tiffStart + 4, littleEndian);
  const firstIfd = readIfd(view, tiffStart, tiffStart + firstIfdOffset, tiffLength, littleEndian);
  const exifIfd = firstIfd.tags.get(0x8769)
    ? readIfd(view, tiffStart, tiffStart + firstIfd.tags.get(0x8769), tiffLength, littleEndian)
    : { tags: new Map() };
  const gpsIfd = firstIfd.tags.get(0x8825)
    ? readIfd(view, tiffStart, tiffStart + firstIfd.tags.get(0x8825), tiffLength, littleEndian)
    : { tags: new Map() };

  const capturedAt = parseExifDate(exifIfd.tags.get(0x9003) || exifIfd.tags.get(0x9004) || firstIfd.tags.get(0x0132));
  const lat = gpsCoordinate(gpsIfd.tags.get(0x0002), gpsIfd.tags.get(0x0001));
  const lng = gpsCoordinate(gpsIfd.tags.get(0x0004), gpsIfd.tags.get(0x0003));

  return {
    orientation: Number(firstIfd.tags.get(0x0112)) || 1,
    capturedAt,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null
  };
}

function readIfd(view, tiffStart, ifdOffset, tiffLength, littleEndian) {
  const tags = new Map();
  if (ifdOffset < tiffStart || ifdOffset + 2 > tiffStart + tiffLength) return { tags };

  const count = readUint16(view, ifdOffset, littleEndian);
  for (let index = 0; index < count; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > tiffStart + tiffLength) break;

    const tag = readUint16(view, entryOffset, littleEndian);
    const type = readUint16(view, entryOffset + 2, littleEndian);
    const itemCount = readUint32(view, entryOffset + 4, littleEndian);
    const value = readExifValue(view, tiffStart, tiffLength, entryOffset + 8, type, itemCount, littleEndian);
    if (value != null) tags.set(tag, value);
  }

  return { tags };
}

function readExifValue(view, tiffStart, tiffLength, valueOffset, type, count, littleEndian) {
  const typeSize = exifTypeSize(type);
  if (!typeSize || count <= 0) return null;

  const byteLength = typeSize * count;
  const inline = byteLength <= 4;
  const dataOffset = inline ? valueOffset : tiffStart + readUint32(view, valueOffset, littleEndian);
  if (dataOffset < tiffStart || dataOffset + byteLength > tiffStart + tiffLength) return null;

  if (type === 2) {
    let text = "";
    for (let index = 0; index < count; index += 1) {
      const code = view.getUint8(dataOffset + index);
      if (!code) break;
      text += String.fromCharCode(code);
    }
    return text.trim();
  }

  const values = [];
  for (let index = 0; index < count; index += 1) {
    const offset = dataOffset + index * typeSize;
    if (type === 1 || type === 7) values.push(view.getUint8(offset));
    if (type === 3) values.push(readUint16(view, offset, littleEndian));
    if (type === 4) values.push(readUint32(view, offset, littleEndian));
    if (type === 5) values.push(readRational(view, offset, littleEndian));
    if (type === 9) values.push(view.getInt32(offset, littleEndian));
    if (type === 10) values.push(readSignedRational(view, offset, littleEndian));
  }

  return values.length === 1 ? values[0] : values;
}

function exifTypeSize(type) {
  return {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    7: 1,
    9: 4,
    10: 8
  }[type] || 0;
}

function readUint16(view, offset, littleEndian) {
  return view.getUint16(offset, littleEndian);
}

function readUint32(view, offset, littleEndian) {
  return view.getUint32(offset, littleEndian);
}

function readRational(view, offset, littleEndian) {
  const numerator = view.getUint32(offset, littleEndian);
  const denominator = view.getUint32(offset + 4, littleEndian);
  return denominator ? numerator / denominator : 0;
}

function readSignedRational(view, offset, littleEndian) {
  const numerator = view.getInt32(offset, littleEndian);
  const denominator = view.getInt32(offset + 4, littleEndian);
  return denominator ? numerator / denominator : 0;
}

function gpsCoordinate(values, ref) {
  if (!Array.isArray(values) || values.length < 3) return null;
  const coordinate = values[0] + values[1] / 60 + values[2] / 3600;
  return String(ref || "").toUpperCase() === "S" || String(ref || "").toUpperCase() === "W"
    ? -coordinate
    : coordinate;
}

function parseExifDate(value) {
  const match = String(value || "").match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return "";

  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
