"use strict";

const crypto = require("node:crypto");
const mysql = require("mysql2/promise");

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not configured");
    }
    pool = mysql.createPool({
      uri: process.env.DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 5,
      maxIdle: 5,
      idleTimeout: 60000,
      enableKeepAlive: true,
      ssl: { rejectUnauthorized: true },
    });
  }
  return pool;
}

function bearerMatches(req) {
  const configured = process.env.NISHANT_GALLERY_ADMIN_KEY || "admin123";
  const header = req.headers.authorization || "";
  const match = /^Bearer[ \t]+([^ \t]+)$/.exec(header);
  if (!configured || !match) return false;
  const suppliedDigest = crypto.createHash("sha256").update(match[1], "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(configured, "utf8").digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}

function requireAdmin(req) {
  if (!bearerMatches(req)) {
    const err = new Error("Unauthorized.");
    err.status = 401;
    throw err;
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

const DEFAULT_HERO = "/nishant-portrait.webp";

module.exports = { getPool, requireAdmin, galleryItem, DEFAULT_HERO };
