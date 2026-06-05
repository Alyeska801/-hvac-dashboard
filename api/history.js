import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

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

  try {
    // Scan for all reading keys in the time window
    // Keys are stored as "reading:{timestamp}"
    const BUCKET_MS = 5 * 60 * 1000;

    // For longer windows, downsample to hourly averages to keep response small
    const targetPoints = window === "24h" ? 288 : 720;
    const bucketSize = window === "24h" ? BUCKET_MS : Math.ceil(windowMs / targetPoints);

    // Scan keys
    let cursor = 0;
    const keys = [];
    do {
      const [nextCursor, batch] = await redis.scan(cursor, {
        match: "reading:*",
        count: 200,
      });
      cursor = parseInt(nextCursor);
      for (const key of batch) {
        const ts = parseInt(key.split(":")[1]);
        if (ts >= since && ts <= now) keys.push({ key, ts });
      }
    } while (cursor !== 0);

    if (!keys.length) return res.status(200).json({ points: [], window });

    // Sort by time
    keys.sort((a, b) => a.ts - b.ts);

    // Fetch all values in batches
    const pipeline = redis.pipeline();
    for (const { key } of keys) pipeline.hgetall(key);
    const results = await pipeline.exec();

    // Build raw points
    const raw = [];
    keys.forEach(({ ts }, i) => {
      const data = results[i];
      if (!data) return;
      raw.push({
        ts,
        "CHW-S": data["CHW-S"] != null ? parseFloat(data["CHW-S"]) : null,
        "CHW-R": data["CHW-R"] != null ? parseFloat(data["CHW-R"]) : null,
      });
    });

    // Downsample into buckets
    const buckets = new Map();
    for (const point of raw) {
      const bucket = Math.floor(point.ts / bucketSize) * bucketSize;
      if (!buckets.has(bucket)) buckets.set(bucket, { "CHW-S": [], "CHW-R": [] });
      if (point["CHW-S"] != null) buckets.get(bucket)["CHW-S"].push(point["CHW-S"]);
      if (point["CHW-R"] != null) buckets.get(bucket)["CHW-R"].push(point["CHW-R"]);
    }

    const points = [];
    for (const [bucket, vals] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;
      points.push({
        ts: bucket,
        "CHW-S": avg(vals["CHW-S"]),
        "CHW-R": avg(vals["CHW-R"]),
      });
    }

    // Compute uptime stats for CHW-S (last 7 days)
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const uptimePoints = points.filter(p => p.ts >= sevenDaysAgo);
    let nominal = 0, degraded = 0, offline = 0;
    for (const p of uptimePoints) {
      if (p["CHW-S"] == null) continue;
      if (p["CHW-S"] >= 65) offline++;
      else if (p["CHW-S"] >= 57) degraded++;
      else nominal++;
    }
    const total = nominal + degraded + offline || 1;
    const uptime = {
      nominal:  +(nominal  / total * 100).toFixed(1),
      degraded: +(degraded / total * 100).toFixed(1),
      offline:  +(offline  / total * 100).toFixed(1),
      segments: uptimePoints.map(p => ({
        ts: p.ts,
        status: p["CHW-S"] == null ? "unknown"
              : p["CHW-S"] >= 65 ? "offline"
              : p["CHW-S"] >= 57 ? "degraded"
              : "nominal",
      })),
    };

    res.status(200).json({ points, uptime, window });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}