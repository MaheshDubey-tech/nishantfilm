"use strict";

const { requireAdmin } = require("../_lib");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    requireAdmin(req);
    res.status(204).end();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
};
