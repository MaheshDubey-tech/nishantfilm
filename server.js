"use strict";

const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { URL } = require("node:url");
const Busboy = require("busboy");
const mysql = require("mysql2/promise");

const ROOT = __dirname;
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const DEFAULT_HERO = "/nishant-portrait.webp";
const PORT = Number.parseInt(process.env.PORT || "3000", 10) || 3000;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const VIDEO_MAX_BYTES = 80 * 1024 * 1024;
const REQUEST_MAX_BYTES = 160 * 1024 * 1024;
const MAX_GALLERY_FILES = 10;
const JSON_MAX_BYTES = 1024 * 1024;

const IMAGE_MIME = new Set(["image/webp", "image/jpeg"]);
const VIDEO_MIME = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const EXTENSION_FOR_MIME = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let pool = null;
let databaseReady = false;
let databaseError = null;

function safeHeaders(response, contentType = "application/json; charset=utf-8") {
  response.setHeader("Content-Type", contentType);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function sendJson(response, status, value) {
  safeHeaders(response);
  response.setHeader("Cache-Control", "no-store");
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

function sendNoContent(response, status = 204) {
  safeHeaders(response);
  response.setHeader("Cache-Control", "no-store");
  response.statusCode = status;
  response.end();
}

function isApiRequest(url) {
  return url.pathname.startsWith("/api/") || url.pathname === "/health";
}

function publicError(error) {
  if (error instanceof HttpError) return error;
  if (error && error.code === "LIMIT_FILE_SIZE") return new HttpError(413, "File is too large.");
  return new HttpError(500, "The server could not complete that request.");
}

function handleError(response, error) {
  const safe = publicError(error);
  sendJson(response, safe.status, { error: safe.message });
}

function requireDatabase() {
  if (!databaseReady || !pool) throw new HttpError(503, "The service is not ready yet.");
  return pool;
}

function bearerMatches(request) {
  const configured = process.env.NISHANT_GALLERY_ADMIN_KEY || "admin123";
  const header = request.headers.authorization || "";
  const match = /^Bearer[ \t]+([^ \t]+)$/.exec(header);
  if (!configured || !match) return false;
  const suppliedDigest = crypto.createHash("sha256").update(match[1], "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(configured, "utf8").digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}

function requireAdmin(request) {
  if (!bearerMatches(request)) throw new HttpError(401, "Unauthorized.");
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > JSON_MAX_BYTES) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function sanitizeDisplayName(filename, fallback) {
  const base = path.basename(String(filename || ""));
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || fallback).slice(0, 255);
}

function normalizeUploadMime(declaredMime, filename) {
  const declared = String(declaredMime || "").toLowerCase();
  const extension = path.extname(String(filename || "")).toLowerCase();
  if (declared === "image/jpg") return "image/jpeg";
  if (declared === "video/x-m4v") return "video/mp4";
  if (declared && declared !== "application/octet-stream") return declared;
  const byExtension = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".mp4": "video/mp4", ".m4v": "video/mp4",
    ".webm": "video/webm", ".mov": "video/quicktime",
  };
  return byExtension[extension] || declared;
}

async function saveStreamToFile(stream, filename, maxBytes, state) {
  const handle = await fsp.open(filename, "w");
  let size = 0;
  let tooLarge = false;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      state.totalBytes += chunk.length;
      if (size <= maxBytes && state.totalBytes <= REQUEST_MAX_BYTES) {
        await handle.write(chunk);
      } else {
        tooLarge = true;
      }
    }
  } finally {
    await handle.close();
  }
  if (tooLarge || stream.truncated) throw new HttpError(413, "One or more files exceed the upload limit.");
  return size;
}

async function parseMultipart(request, options) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nishant-upload-"));
  const files = [];
  const jobs = [];
  const state = { totalBytes: 0, count: 0, error: null };
  const allowedField = options.field;
  const maxFiles = options.maxFiles;
  const maxBytesForMime = options.maxBytesForMime;

  const rememberError = (error) => {
    if (!state.error) state.error = error instanceof HttpError ? error : new HttpError(400, "Invalid multipart upload.");
  };

  let parser;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: { files: maxFiles + 1, fileSize: VIDEO_MAX_BYTES },
    });
  } catch {
    await fsp.rm(tempDir, { recursive: true, force: true });
    throw new HttpError(400, "Invalid multipart upload.");
  }

  const parsing = new Promise((resolve, reject) => {
    parser.on("file", (fieldname, stream, info) => {
      state.count += 1;
      const filename = String(info.filename || "");
      const mime = normalizeUploadMime(info.mimeType, filename);
      const isAllowedField = fieldname === allowedField;
      const kind = VIDEO_MIME.has(mime) ? "video" : IMAGE_MIME.has(mime) ? "image" : null;
      const fallback = kind === "video" ? "video" : "image.webp";
      const extension = EXTENSION_FOR_MIME[mime];
      const tempPath = path.join(tempDir, `${String(state.count).padStart(2, "0")}-${crypto.randomUUID()}.upload`);
      const job = (async () => {
        if (state.count > maxFiles) {
          stream.resume();
          throw new HttpError(400, "Too many files.");
        }
        if (!isAllowedField) {
          stream.resume();
          throw new HttpError(400, `Multipart files must use the ${allowedField} field.`);
        }
        if (!kind || !extension) {
          stream.resume();
          throw new HttpError(400, "Unsupported file type.");
        }
        const maxBytes = maxBytesForMime(kind);
        const size = await saveStreamToFile(stream, tempPath, maxBytes, state);
        files.push({
          tempPath,
          size,
          mime,
          kind,
          extension,
          originalName: sanitizeDisplayName(filename, fallback),
        });
      })().catch((error) => {
        rememberError(error);
      });
      jobs.push(job);
    });
    parser.on("filesLimit", () => rememberError(new HttpError(400, "Too many files.")));
    parser.on("error", (error) => reject(error));
    parser.on("finish", async () => {
      try {
        await Promise.all(jobs);
        if (state.error) reject(state.error);
        else if (state.count === 0) reject(new HttpError(400, "No file was provided."));
        else if (state.totalBytes > REQUEST_MAX_BYTES) reject(new HttpError(413, "The total upload is too large."));
        else if (options.requireExactlyOne && files.length !== 1) reject(new HttpError(400, "Provide exactly one image file."));
        else resolve(files);
      } catch (error) {
        reject(error);
      }
    });
    request.pipe(parser);
  });

  let parsedFiles;
  let succeeded = false;
  try {
    parsedFiles = await parsing;
    succeeded = true;
    return parsedFiles;
  } finally {
    if (!succeeded) await fsp.rm(tempDir, { recursive: true, force: true });
    Object.defineProperty(files, "tempDir", { value: tempDir, enumerable: false });
  }
}

async function removeUploadFiles(files) {
  if (!files) return;
  const tempDir = files.tempDir;
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
  else await Promise.all(files.map((file) => fsp.rm(file.tempPath, { force: true }).catch(() => {})));
}

async function presignAndUpload(file) {
  const storageApi = String(process.env.MANUS_API_URL || "").replace(/\/$/, "");
  const storageKey = `gallery/${crypto.randomUUID()}-${crypto.randomBytes(8).toString("hex")}.${file.extension}`;
  if (!storageApi || !process.env.MANUS_API_KEY) throw new HttpError(503, "Storage is not configured.");

  const presignUrl = `${storageApi}/v1/storage/presign/put?path=${encodeURIComponent(storageKey)}`;
  let presignResponse;
  try {
    presignResponse = await fetch(presignUrl, {
      headers: { Authorization: `Bearer ${process.env.MANUS_API_KEY}` },
    });
  } catch {
    throw new HttpError(503, "Storage is temporarily unavailable.");
  }
  if (!presignResponse.ok) throw new HttpError(503, "Storage is temporarily unavailable.");

  let presignBody;
  try {
    presignBody = await presignResponse.json();
  } catch {
    throw new HttpError(503, "Storage returned an invalid upload response.");
  }
  const uploadUrl = presignBody && (presignBody.url || presignBody.uploadUrl || presignBody.presignedUrl);
  if (typeof uploadUrl !== "string" || !uploadUrl) throw new HttpError(503, "Storage returned an invalid upload response.");

  let uploadResponse;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.mime, "Content-Length": String(file.size) },
      body: fs.createReadStream(file.tempPath),
      duplex: "half",
    });
  } catch {
    throw new HttpError(503, "Storage is temporarily unavailable.");
  }
  if (!uploadResponse.ok) throw new HttpError(503, "Storage could not accept the file.");
  return `/manus-storage/${storageKey}`;
}

async function migrateDatabase() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  pool = mysql.createPool({
    uri: process.env.DATABASE_URL,
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60000,
    enableKeepAlive: true,
    ssl: { rejectUnauthorized: true },
  });
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (migration_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin
    `);
    const names = (await fsp.readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of names) {
      const [rows] = await connection.query("SELECT migration_id FROM schema_migrations WHERE migration_id = ?", [name]);
      if (rows.length) continue;
      const sql = await fsp.readFile(path.join(MIGRATIONS_DIR, name), "utf8");
      const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
      await connection.beginTransaction();
      try {
        for (const statement of statements) await connection.query(statement);
        await connection.query("INSERT INTO schema_migrations (migration_id) VALUES (?)", [name]);
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      }
    }
  } finally {
    connection.release();
  }
}

function galleryItem(row) {
  return {
    id: row.id,
    url: `/manus-storage/${row.object_key}`,
    kind: row.kind,
    name: row.original_name,
    caption: row.caption,
    sortOrder: Number(row.sort_order),
  };
}

async function listGallery() {
  const [rows] = await requireDatabase().query(
    "SELECT id, object_key, kind, original_name, caption, sort_order FROM gallery_items WHERE visible = 1 ORDER BY sort_order ASC, id ASC",
  );
  return rows.map(galleryItem);
}

async function postGallery(request, response) {
  requireAdmin(request);
  const files = await parseMultipart(request, {
    field: "files",
    maxFiles: MAX_GALLERY_FILES,
    maxBytesForMime: (kind) => (kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES),
  });
  try {
    const uploaded = [];
    for (const file of files) uploaded.push({ file, url: await presignAndUpload(file) });
    const addedItems = [];
    const database = requireDatabase();
    const connection = await database.getConnection();
    try {
      await connection.beginTransaction();
      const [maxRows] = await connection.query("SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM gallery_items");
      let sortOrder = Number(maxRows[0].max_order) + 1;
      for (const entry of uploaded) {
        const id = crypto.randomUUID();
        const objectKey = entry.url.slice("/manus-storage/".length);
        const itemOrder = sortOrder++;
        await connection.query(
          "INSERT INTO gallery_items (id, object_key, mime_type, kind, original_name, caption, sort_order, visible) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
          [id, objectKey, entry.file.mime, entry.file.kind, entry.file.originalName, "", itemOrder],
        );
        addedItems.push({ id, url: entry.url, kind: entry.file.kind, name: entry.file.originalName, caption: "", sortOrder: itemOrder });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
    sendJson(response, 201, { items: addedItems });
  } finally {
    await removeUploadFiles(files);
  }
}

async function patchGallery(request, response, id) {
  requireAdmin(request);
  const body = await readJson(request);
  const updates = [];
  const values = [];
  if (Object.hasOwn(body, "caption")) {
    if (typeof body.caption !== "string" || body.caption.length > 180) {
      throw new HttpError(400, "Caption must be a string no longer than 180 characters.");
    }
    updates.push("caption = ?"); values.push(body.caption.trim());
  }
  if (Object.hasOwn(body, "name")) {
    if (typeof body.name !== "string") throw new HttpError(400, "Display name must be text.");
    const name = body.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
    if (!name) throw new HttpError(400, "Display name cannot be empty.");
    updates.push("original_name = ?"); values.push(name);
  }
  if (!updates.length) throw new HttpError(400, "Provide a display name or caption to update.");
  values.push(id);
  const [result] = await requireDatabase().query(
    `UPDATE gallery_items SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND visible = 1`,
    values,
  );
  if (!result.affectedRows) throw new HttpError(404, "Gallery item not found.");
  const [rows] = await pool.query(
    "SELECT id, object_key, kind, original_name, caption, sort_order FROM gallery_items WHERE id = ?",
    [id],
  );
  sendJson(response, 200, { item: galleryItem(rows[0]) });
}

async function reorderGallery(request, response) {
  requireAdmin(request);
  const body = await readJson(request);
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string") || new Set(body.ids).size !== body.ids.length) {
    throw new HttpError(400, "ids must be an array of unique gallery IDs.");
  }
  const database = requireDatabase();
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT id FROM gallery_items WHERE visible = 1");
    const existing = new Set(rows.map((row) => row.id));
    if (existing.size !== body.ids.length || body.ids.some((id) => !existing.has(id))) {
      throw new HttpError(400, "ids must contain every visible gallery item exactly once.");
    }
    for (let index = 0; index < body.ids.length; index += 1) {
      await connection.query("UPDATE gallery_items SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND visible = 1", [index, body.ids[index]]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
  sendJson(response, 200, { items: await listGallery() });
}

async function deleteGallery(request, response, id) {
  requireAdmin(request);
  const [result] = await requireDatabase().query(
    "UPDATE gallery_items SET visible = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND visible = 1",
    [id],
  );
  if (!result.affectedRows) throw new HttpError(404, "Gallery item not found.");
  sendNoContent(response);
}

async function putHero(request, response) {
  requireAdmin(request);
  const files = await parseMultipart(request, {
    field: "file",
    maxFiles: 1,
    requireExactlyOne: true,
    maxBytesForMime: () => IMAGE_MAX_BYTES,
  });
  try {
    const url = await presignAndUpload(files[0]);
    await requireDatabase().query(
      "INSERT INTO site_settings (setting_key, value_text) VALUES ('hero_path', ?) ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), updated_at = CURRENT_TIMESTAMP",
      [url],
    );
    sendJson(response, 200, { url });
  } finally {
    await removeUploadFiles(files);
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/gallery") {
    sendJson(response, 200, { items: await listGallery() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/verify") {
    requireAdmin(request);
    sendNoContent(response, 204);
    return;
  }
  if (url.pathname === "/api/gallery" && request.method === "POST") {
    await postGallery(request, response);
    return;
  }
  const galleryMatch = /^\/api\/gallery\/([^/]+)$/.exec(url.pathname);
  if (galleryMatch && request.method === "PATCH") {
    await patchGallery(request, response, decodeURIComponent(galleryMatch[1]));
    return;
  }
  if (galleryMatch && request.method === "DELETE") {
    await deleteGallery(request, response, decodeURIComponent(galleryMatch[1]));
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/gallery/order") {
    await reorderGallery(request, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/hero") {
    const [rows] = await requireDatabase().query("SELECT value_text FROM site_settings WHERE setting_key = 'hero_path' LIMIT 1");
    sendJson(response, 200, { url: rows[0]?.value_text || DEFAULT_HERO });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/hero") {
    await putHero(request, response);
    return;
  }
  if (request.method === "DELETE" && url.pathname === "/api/hero") {
    requireAdmin(request);
    await requireDatabase().query("DELETE FROM site_settings WHERE setting_key = 'hero_path'");
    sendJson(response, 200, { url: DEFAULT_HERO });
    return;
  }
  throw new HttpError(404, "Not found.");
}

const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/manus-routes.json": ["manus-routes.json", "application/json; charset=utf-8"],
  "/nishant-portrait.webp": ["nishant-portrait.webp", "image/webp"],
};

async function serveStatic(response, pathname) {
  const file = STATIC_FILES[pathname];
  if (!file) throw new HttpError(404, "Not found.");
  const filePath = path.join(ROOT, file[0]);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new HttpError(404, "Not found.");
  }
  safeHeaders(response, file[1]);
  response.setHeader("Cache-Control", pathname === "/" || pathname === "/index.html" ? "no-cache" : "public, max-age=300");
  response.statusCode = 200;
  response.setHeader("Content-Length", String(stat.size));
  fs.createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
}

async function requestHandler(request, response) {
  let url;
  try {
    url = new URL(request.url || "/", "http://localhost");
  } catch {
    sendJson(response, 400, { error: "Invalid request URL." });
    return;
  }
  try {
    if (url.pathname === "/health") {
      if (!databaseReady) throw new HttpError(503, "The service is not ready yet.");
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    await serveStatic(response, url.pathname);
  } catch (error) {
    if (!response.headersSent) handleError(response, error);
    else response.destroy();
  }
}

const server = http.createServer(requestHandler);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Nishant portfolio server listening on port ${PORT}`);
});

(async () => {
  try {
    await migrateDatabase();
    databaseReady = true;
  } catch (error) {
    databaseError = error;
    console.error("Database readiness failed; API will remain unavailable until restart.");
  }
})();

async function shutdown() {
  server.close();
  if (pool) await pool.end().catch(() => {});
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

void databaseError;
