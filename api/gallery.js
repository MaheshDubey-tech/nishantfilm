"use strict";

const { getPool, galleryItem } = require("./_lib");

module.exports = async (req, res) => {
  // CORS for Vercel
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query(
      "SELECT id, object_key, kind, original_name, caption, sort_order FROM gallery_items WHERE visible = 1 ORDER BY sort_order ASC, id ASC"
    );
    res.status(200).json({ items: rows.map(galleryItem) });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: "Database is unavailable." });
  }
};
