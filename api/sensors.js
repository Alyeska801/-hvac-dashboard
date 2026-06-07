// api/sensors.js — serves the latest reading to the dashboard
// Data is collected by api/cron.js every 5 minutes server-side.
// This endpoint also seeds the sparkline with the last 30 real readings.

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const BUCKET_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  try {
    // Get latest reading (written by cron every 5 min)
    const latest = await redis.get("latest-reading");
    if (!latest) {
      return res.status(200).json({
        readings: {},
        cwsStatus: "nominal",
        sparklines: {},
        timestamp: new Date().toISOString(),
      });
    }

    const { readings, cwsStatus, timestamp } = typeof latest === "string"
      ? JSON.parse(latest)
      : latest;

    // Fetch last 30 real data points for sparklines (last 2.5 hours)
    const now = Date.now();
    const currentBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const pipeline = redis.pipeline();
    for (let i = 29; i >= 0; i--) {
      pipeline.hgetall(`reading:${currentBucket - i * BUCKET_MS}`);
    }
    const results = await pipeline.exec();

    const sparklines = { "CHW-S": [], "CHW-R": [], "HHW-S": [], "HHW-R": [] };
    results.forEach((data, i) => {
      const ts = currentBucket - (29 - i) * BUCKET_MS;
      if (!data) return;
      ["CHW-S", "CHW-R", "HHW-S", "HHW-R"].forEach(id => {
        if (data[id] != null) {
          sparklines[id].push({ time: new Date(ts), value: parseFloat(data[id]) });
        }
      });
    });

    res.status(200).json({ readings, cwsStatus, sparklines, timestamp });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}