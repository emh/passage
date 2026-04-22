const PASSAGE_HOST = globalThis.location?.hostname || "";
const PASSAGE_IS_LOCAL = PASSAGE_HOST === "localhost" ||
  PASSAGE_HOST === "127.0.0.1" ||
  PASSAGE_HOST.endsWith(".local") ||
  /^10\./.test(PASSAGE_HOST) ||
  /^192\.168\./.test(PASSAGE_HOST) ||
  /^169\.254\./.test(PASSAGE_HOST) ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(PASSAGE_HOST);

globalThis.PASSAGE_CONFIG = globalThis.PASSAGE_CONFIG || {
  syncBaseUrl: PASSAGE_IS_LOCAL ? "" : "https://passage-sync.emh.workers.dev"
};
