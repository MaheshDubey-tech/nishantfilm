"use strict";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
};
