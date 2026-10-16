/**
 * One-time Redis repair script
 *
 * Run ONCE after deploying the cron.js outage tracking fix:
 *   node --env-file=.env.local scripts/seed-outage.mjs
 *
 * What it does:
 *  1. Sets hvac-alert-state.outageStartTime = Oct 11 2:40am MDT
 *     so the outage timer shows correct elapsed time immediately.
 *  2. Rewrites outages-cache: merges all fragmented Oct 11+ entries
 *     into one ongoing outage entry.
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// Oct 11 2026 2:40am MDT (UTC-6) = 08:40 UTC
const OUTAGE_START = new Date("2026-10-11T08:40:00Z").getTime();

async function main() {
  // 1. Patch alert state to set outageStartTime
  const alertState = await redis.get("hvac-alert-state");
  const state = (typeof alertState === "string" ? JSON.parse(alertState) : alertState) || {};
  console.log("Current alert state:", JSON.stringify(state));

  await redis.set("hvac-alert-state", { ...state, outageStartTime: OUTAGE_START });
  console.log("OK - patched hvac-alert-state.outageStartTime:", new Date(OUTAGE_START).toLocaleString("en-US", { timeZone: "America/Denver" }), "MDT");

  // 2. Rebuild outages-cache
  const cache = await redis.get("outages-cache");
  const outages = cache?.outages || [];
  console.log("\nCurrent outage entries:", outages.length);

  // Keep entries that closed before Oct 11
  const before = outages.filter(o => o.end && o.end < OUTAGE_START);
  const oct11plus = outages.filter(o => !o.end || o.end >= OUTAGE_START || o.start >= OUTAGE_START);
  console.log("Keeping", before.length, "historical | merging", oct11plus.length, "into 1 sustained");

  const peakTemp = oct11plus.reduce((mx, o) => Math.max(mx, o.peakTemp || 0), 63);
  const ambSamples = oct11plus.filter(o => o.ambientAvg).map(o => o.ambientAvg);
  const ambientAvg = ambSamples.length
    ? +(ambSamples.reduce((s, v) => s + v, 0) / ambSamples.length).toFixed(1)
    : null;

  const now = Date.now();
  const sustained = {
    start: OUTAGE_START,
    end: null,
    ongoing: true,
    durationHrs: +((now - OUTAGE_START) / 3600000).toFixed(1),
    peakTemp,
    ambientAvg,
    ambientDelta: ambientAvg ? +(peakTemp - ambientAvg).toFixed(1) : null,
  };

  const rebuilt = [...before, sustained];
  const totalHrs = 180 * 24;
  const offlineHrs = rebuilt.reduce((s, o) => s + o.durationHrs, 0);
  const stats = {
    totalOutages: rebuilt.length,
    offlineHrs: +offlineHrs.toFixed(1),
    uptimePct: +((1 - offlineHrs / totalHrs) * 100).toFixed(1),
  };

  await redis.set("outages-cache", { outages: rebuilt, stats, lastUpdated: now }, { ex: 60 * 60 * 24 * 190 });
  console.log("OK - rebuilt outages-cache:", rebuilt.length, "entries total");
  console.log("   Ongoing Oct 11 outage: peak", sustained.peakTemp + "F,", sustained.durationHrs + "h so far");
  console.log("   7-day uptime stats:", stats.uptimePct + "%,", stats.offlineHrs + "h offline");
  console.log("\nDone! Refresh the dashboard to see the timer and corrected history.");
}

main().catch(e => { console.error(e); process.exit(1); });
