// api/outages.js — serves pre-computed outage cache written by api/cron.js
// One Redis read per request instead of 50,000+
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  try {
    const cached = await redis.get("outages-cache");

    if (!cached || !cached.outages?.length) {
      // Cache not built yet — do a one-time bootstrap from stored readings
      // This only runs once after deployment, then the cron takes over
      return await bootstrapOutages(req, res);
    }

    res.status(200).json({
      outages: cached.outages,
      stats: cached.stats,
      fromCache: true,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// One-time bootstrap: scan historical data to build initial cache
// After this runs once, the cron maintains it incrementally
async function bootstrapOutages(req, res) {
  const redis = new (await import("@upstash/redis")).Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const BUCKET_MS = 5 * 60 * 1000;
  const TTL_SECONDS = 60 * 60 * 24 * 190;
  const now   = Date.now();
  const since = now - 180 * 24 * 60 * 60 * 1000;

  const settings = await redis.get("hvac-settings") || {};
  const offlineT  = settings.offlineThreshold  ?? 65;
  const degradedT = settings.degradedThreshold ?? 57;

  const startB = Math.floor(since / BUCKET_MS) * BUCKET_MS;
  const endB   = Math.floor(now   / BUCKET_MS) * BUCKET_MS;
  const allBuckets = [];
  for (let t = startB; t <= endB; t += BUCKET_MS) allBuckets.push(t);

  // Fetch in batches of 200 (safe for Upstash free tier)
  const BATCH = 200;
  const cwsMap = new Map();
  const ambMap = new Map();

  for (let i = 0; i < allBuckets.length; i += BATCH) {
    const batch = allBuckets.slice(i, i + BATCH);
    const p1 = redis.pipeline();
    const p2 = redis.pipeline();
    for (const ts of batch) {
      p1.hget(`reading:${ts}`, "CHW-S");
      p2.hget(`ambient:${ts}`, "temp");
    }
    const [r1, r2] = await Promise.all([p1.exec(), p2.exec()]);
    batch.forEach((ts, j) => {
      if (r1[j] != null) cwsMap.set(ts, parseFloat(r1[j]));
      if (r2[j] != null) ambMap.set(ts, parseFloat(r2[j]));
    });
  }

  const series = [...cwsMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, cws]) => ({ ts, cws, ambient: ambMap.get(ts) ?? null }));

  const outages = [];
  let inOutage = false, outageStart = null, outagePeak = 0, ambientSum = 0, ambientCount = 0;

  for (const { ts, cws, ambient } of series) {
    if (cws >= offlineT && !inOutage) {
      inOutage = true; outageStart = ts; outagePeak = cws;
      ambientSum = ambient ?? 0; ambientCount = ambient != null ? 1 : 0;
    } else if (cws >= offlineT && inOutage) {
      outagePeak = Math.max(outagePeak, cws);
      if (ambient != null) { ambientSum += ambient; ambientCount++; }
    } else if (cws < degradedT && inOutage) {
      const ambientAvg = ambientCount ? +(ambientSum / ambientCount).toFixed(1) : null;
      outages.push({
        start: outageStart, end: ts,
        durationHrs: +((ts - outageStart) / 3600000).toFixed(1),
        peakTemp: outagePeak, ambientAvg,
        ambientDelta: ambientAvg != null ? +(outagePeak - ambientAvg).toFixed(1) : null,
      });
      inOutage = false;
    }
  }
  if (inOutage) {
    const ambientAvg = ambientCount ? +(ambientSum / ambientCount).toFixed(1) : null;
    outages.push({
      start: outageStart, end: null, ongoing: true,
      durationHrs: +((now - outageStart) / 3600000).toFixed(1),
      peakTemp: outagePeak, ambientAvg,
      ambientDelta: ambientAvg != null ? +(outagePeak - ambientAvg).toFixed(1) : null,
      _ambientSum: ambientSum, _ambientCount: ambientCount,
    });
  }

  const totalHrs = (now - since) / 3600000;
  const offlineHrs = outages.reduce((s, o) => s + o.durationHrs, 0);
  const stats = {
    totalOutages: outages.length,
    offlineHrs: +offlineHrs.toFixed(1),
    uptimePct: +((1 - offlineHrs / totalHrs) * 100).toFixed(1),
  };

  // Store cache so this never runs again
  await redis.set("outages-cache", { outages, stats, lastUpdated: now }, { ex: TTL_SECONDS });

  res.status(200).json({ outages, stats, bootstrapped: true });
}