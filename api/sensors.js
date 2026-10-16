// api/sensors.js — serves the latest reading to the dashboard
// Data is collected by api/cron.js every 5 minutes server-side.
// This endpoint also seeds the sparkline with the last 72 real readings (6h).

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const BUCKET_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  try {
    // Get latest reading, alert state, and settings in parallel
    const [latest, alertState, settings] = await Promise.all([
      redis.get("latest-reading"),
      redis.get("hvac-alert-state"),
      redis.get("hvac-settings"),
    ]);

    if (!latest) {
      return res.status(200).json({
        readings: {},
        cwsStatus: "nominal",
        sparklines: {},
        outdoorF: null,
        outageStartTime: null,
        timestamp: new Date().toISOString(),
      });
    }

    const parsed = typeof latest === "string" ? JSON.parse(latest) : latest;
    const { readings, cwsStatus, outdoorF, timestamp } = parsed;

    // Extract outageStartTime — persists through brief recoveries
    const state = alertState
      ? (typeof alertState === "string" ? JSON.parse(alertState) : alertState)
      : {};
    const outageStartTime = state.outageStartTime || null;
    const cfg = settings
      ? (typeof settings === "string" ? JSON.parse(settings) : settings)
      : {};
    const recoveringUntil = cfg.recoveringUntil || null;

    // Build sparklines from the last 72 buckets (6 hours at 5-min resolution)
    const now = Date.now();
    const currentBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const pipeline = redis.pipeline();
    for (let i = 71; i >= 0; i--) {
      pipeline.hgetall(`reading:${currentBucket - i * BUCKET_MS}`);
    }
    const results = await pipeline.exec();

    const sparklines = { "CHW-S": [], "CHW-R": [], "HHW-S": [], "HHW-R": [] };
    results.forEach((data, i) => {
      const ts = currentBucket - (71 - i) * BUCKET_MS;
      if (!data) return;
      ["CHW-S", "CHW-R", "HHW-S", "HHW-R"].forEach(id => {
        if (data[id] != null) {
          sparklines[id].push({ time: new Date(ts), value: parseFloat(data[id]) });
        }
      });
    });

    res.status(200).json({ readings, cwsStatus, sparklines, outdoorF: outdoorF ?? null, outageStartTime, recoveringUntil, timestamp });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
