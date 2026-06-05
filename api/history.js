import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const BUCKET_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { window = "24h" } = req.query;

  const windowMs = {
    "24h": 24 * 60 * 60 * 1000,
    "1m":  30 * 24 * 60 * 60 * 1000,
    "3m":  90 * 24 * 60 * 60 * 1000,
    "6m": 180 * 24 * 60 * 60 * 1000,
  }[window] || 24 * 60 * 60 * 1000;

  const now = Date.now();
  const since = now - windowMs;

  // Downsample factor — how many 5-min buckets to merge into one point
  const downsampleFactor = {
    "24h": 1,   // every 5 min = 288 points
    "1m":  12,  // every hour = 720 points
    "3m":  12,  // every hour = ~2160 points
    "6m":  24,  // every 2 hours = ~2160 points
  }[window] || 1;

  const bucketSize = BUCKET_MS * downsampleFactor;

  try {
    // Build the list of expected bucket timestamps directly
    // Much faster than scanning — O(n) where n = number of expected points
    const startBucket = Math.floor(since / BUCKET_MS) * BUCKET_MS;
    const endBucket   = Math.floor(now  / BUCKET_MS) * BUCKET_MS;

    // Collect all 5-min bucket timestamps in range
    const allBuckets = [];
    for (let t = startBucket; t <= endBucket; t += BUCKET_MS) {
      allBuckets.push(t);
    }

    // Fetch in batches of 100 to avoid hitting pipeline limits
    const BATCH = 100;
    const rawMap = new Map();

    for (let i = 0; i < allBuckets.length; i += BATCH) {
      const batch = allBuckets.slice(i, i + BATCH);
      const pipeline = redis.pipeline();
      for (const ts of batch) pipeline.hgetall(`reading:${ts}`);
      const results = await pipeline.exec();
      batch.forEach((ts, j) => {
        const data = results[j];
        if (data && (data["CHW-S"] != null || data["CHW-R"] != null)) {
          rawMap.set(ts, {
            "CHW-S": data["CHW-S"] != null ? parseFloat(data["CHW-S"]) : null,
            "CHW-R": data["CHW-R"] != null ? parseFloat(data["CHW-R"]) : null,
          });
        }
      });
    }

    // Downsample into display buckets
    const displayBuckets = new Map();
    for (const [ts, vals] of rawMap) {
      const bucket = Math.floor(ts / bucketSize) * bucketSize;
      if (!displayBuckets.has(bucket)) displayBuckets.set(bucket, { "CHW-S": [], "CHW-R": [] });
      if (vals["CHW-S"] != null) displayBuckets.get(bucket)["CHW-S"].push(vals["CHW-S"]);
      if (vals["CHW-R"] != null) displayBuckets.get(bucket)["CHW-R"].push(vals["CHW-R"]);
    }

    const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;

    const points = [...displayBuckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucket, vals]) => ({
        ts: bucket,
        "CHW-S": avg(vals["CHW-S"]),
        "CHW-R": avg(vals["CHW-R"]),
      }))
      .filter(p => p["CHW-S"] != null || p["CHW-R"] != null);

    // Uptime stats for CHW-S over last 7 days
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const uptimeRaw = [...rawMap.entries()]
      .filter(([ts]) => ts >= sevenDaysAgo)
      .sort((a, b) => a[0] - b[0]);

    let nominal = 0, degraded = 0, offline = 0;
    for (const [, vals] of uptimeRaw) {
      if (vals["CHW-S"] == null) continue;
      if (vals["CHW-S"] >= 65) offline++;
      else if (vals["CHW-S"] >= 57) degraded++;
      else nominal++;
    }
    const total = nominal + degraded + offline || 1;
    const uptime = {
      nominal:  +(nominal  / total * 100).toFixed(1),
      degraded: +(degraded / total * 100).toFixed(1),
      offline:  +(offline  / total * 100).toFixed(1),
      segments: uptimeRaw.map(([ts, vals]) => ({
        ts,
        status: vals["CHW-S"] == null ? "unknown"
              : vals["CHW-S"] >= 65 ? "offline"
              : vals["CHW-S"] >= 57 ? "degraded"
              : "nominal",
      })),
    };

    res.status(200).json({ points, uptime, window });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}