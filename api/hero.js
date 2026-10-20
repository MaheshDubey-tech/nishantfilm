"use strict";

const { getPool, DEFAULT_HERO } = require("./_lib");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query(
      "SELECT value_text FROM site_settings WHERE setting_key = 'hero_path' LIMIT 1"
    );
    res.status(200).json({ url: rows[0]?.value_text || DEFAULT_HERO });
  } catch (err) {
    console.error(err);
    // Gracefully return default hero on DB error
    res.status(200).json({ url: DEFAULT_HERO });
  }
};
