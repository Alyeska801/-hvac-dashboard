import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const DEFAULT_SETTINGS = {
    // Public / engineering settings
    showHot: true,
    engState: "none",
    eta: "",
    situationFlag: "",
    alertRecipients: [],
    sendRecoveryEmails: true,
    // Owner-only settings
    warnCooldownHours: 4,
    degradedThreshold: 57,
    offlineThreshold: 65,
    warnRateOfRise: 1.0,
  };

  if (req.method === "GET") {
    const settings = await redis.get("hvac-settings");
    return res.status(200).json({ ...DEFAULT_SETTINGS, ...settings });
  }

  if (req.method === "POST") {
    const current = await redis.get("hvac-settings") || {};
    const updated = { ...DEFAULT_SETTINGS, ...current, ...req.body };
    await redis.set("hvac-settings", updated);
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: "Method not allowed" });
}