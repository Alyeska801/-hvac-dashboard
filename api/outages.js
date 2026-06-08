// api/outages.js — computes outage events from historical CWS + ambient data
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const BUCKET_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  try {
    const now    = Date.now();
    const since  = now - 180 * 24 * 60 * 60 * 1000; // 6 months back
    const startB = Math.floor(since / BUCKET_MS) * BUCKET_MS;
    const endB   = Math.floor(now   / BUCKET_MS) * BUCKET_MS;

    // Fetch CWS readings in batches
    const allBuckets = [];
    for (let t = startB; t <= endB; t += BUCKET_MS) allBuckets.push(t);

    const BATCH = 100;
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
      const [cwsResults, ambResults] = await Promise.all([p1.exec(), p2.exec()]);
      batch.forEach((ts, j) => {
        if (cwsResults[j] != null) cwsMap.set(ts, parseFloat(cwsResults[j]));
        if (ambResults[j]  != null) ambMap.set(ts, parseFloat(ambResults[j]));
      });
    }

    // Build sorted time series
    const series = [...cwsMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, cws]) => ({ ts, cws, ambient: ambMap.get(ts) ?? null }));

    // Detect outage events
    const outages = [];
    let inOutage = false;
    let outageStart = null, outagePeak = 0, outageAmbient = [];
    let prevNominalEnd = null;

    for (const { ts, cws, ambient } of series) {
      if (cws >= 65 && !inOutage) {
        inOutage = true;
        outageStart = ts;
        outagePeak = cws;
        outageAmbient = ambient != null ? [ambient] : [];
      } else if (cws >= 65 && inOutage) {
        outagePeak = Math.max(outagePeak, cws);
        if (ambient != null) outageAmbient.push(ambient);
      } else if (cws < 57 && inOutage) {
        const avgAmbient = outageAmbient.length
          ? +(outageAmbient.reduce((a, b) => a + b, 0) / outageAmbient.length).toFixed(1)
          : null;
        outages.push({
          start:       outageStart,
          end:         ts,
          durationHrs: +((ts - outageStart) / 3600000).toFixed(1),
          peakTemp:    outagePeak,
          ambientAvg:  avgAmbient,
          ambientDelta: avgAmbient != null ? +(outagePeak - avgAmbient).toFixed(1) : null,
        });
        prevNominalEnd = ts;
        inOutage = false;
        outageAmbient = [];
      }
    }

    // If currently in outage
    if (inOutage) {
      const avgAmbient = outageAmbient.length
        ? +(outageAmbient.reduce((a, b) => a + b, 0) / outageAmbient.length).toFixed(1)
        : null;
      outages.push({
        start:       outageStart,
        end:         null,
        durationHrs: +((now - outageStart) / 3600000).toFixed(1),
        peakTemp:    outagePeak,
        ambientAvg:  avgAmbient,
        ambientDelta: avgAmbient != null ? +(outagePeak - avgAmbient).toFixed(1) : null,
        ongoing:     true,
      });
    }

    // Compute overall stats
    const totalHrs = (now - since) / 3600000;
    const offlineHrs = outages.reduce((sum, o) => sum + (o.ongoing ? o.durationHrs : o.durationHrs), 0);
    const uptimePct = +((1 - offlineHrs / totalHrs) * 100).toFixed(1);

    res.status(200).json({ outages, stats: { totalOutages: outages.length, offlineHrs: +offlineHrs.toFixed(1), uptimePct } });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}