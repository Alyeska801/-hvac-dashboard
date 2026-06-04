import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // GET — read current settings
  if (req.method === "GET") {
    const settings = await redis.get("hvac-settings");
    return res.status(200).json(settings || {
      showHot: true,
      engState: "none",
      eta: "",
    });
  }

  // POST — save settings (admin only, password checked client-side)
  if (req.method === "POST") {
    const { showHot, engState, eta } = req.body;
    await redis.set("hvac-settings", { showHot, engState, eta });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: "Method not allowed" });
}