// ─── Historical CSV Importer ───────────────────────────────────────────────
// Run once from your hvac-dashboard folder:
//   node import-history.mjs
//
// Reads all four sensor CSVs, downsamples to 5-minute buckets,
// and bulk-loads into Upstash Redis.
//
// Prerequisites:
//   1. Copy your four CSV files into the hvac-dashboard folder
//   2. Add a .env.local file with your Upstash credentials (see below)
//   3. Run: node import-history.mjs

import { createClient } from "@upstash/redis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Config ───────────────────────────────────────────────────────────────
// Load env from .env.local (Vercel's local env file)
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const [k, ...v] = line.split("=");
    if (k && v.length) process.env[k.trim()] = v.join("=").trim().replace(/^"|"$/g, "");
  }
}

const SENSOR_FILES = {
  "CHW-S": "d88b4c01000c37d0-20260604202332.csv",
  "CHW-R": "d88b4c01000c37f8-20260604202545.csv",
  "HHW-S": "d88b4c01000c381e-20260604202641.csv",
  "HHW-R": "d88b4c01000c381a-20260604202716.csv",
};

const BUCKET_MS = 5 * 60 * 1000; // 5-minute buckets
const TTL_SECONDS = 60 * 60 * 24 * 190; // 190 days

// ─── Parse CSV ────────────────────────────────────────────────────────────
function parseCSV(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  ⚠ File not found: ${filePath} — skipping`);
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n").slice(1); // skip header
  const points = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const timeStr = parts[1].trim();
    const tempStr = parts[2].trim().replace("℉", "");
    const temp = parseFloat(tempStr);
    if (isNaN(temp)) continue;
    // Parse "2026/04/07 13:16:00-0600"
    const normalized = timeStr
      .replace("/", "-").replace("/", "-") // 2026-04-07 13:16:00-0600
      .replace(" ", "T");                  // 2026-04-07T13:16:00-0600
    const ts = new Date(normalized).getTime();
    if (isNaN(ts)) continue;
    points.push({ ts, temp });
  }
  return points;
}

// ─── Downsample to 5-minute buckets (average) ────────────────────────────
function downsample(points) {
  const buckets = new Map();
  for (const { ts, temp } of points) {
    const bucket = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(temp);
  }
  const result = [];
  for (const [bucket, temps] of buckets) {
    const avg = +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1);
    result.push({ ts: bucket, temp: avg });
  }
  return result.sort((a, b) => a.ts - b.ts);
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("❌ Missing KV_REST_API_URL or KV_REST_API_TOKEN in .env.local");
    console.error("   Get these from your Vercel project → Environment Variables");
    process.exit(1);
  }

  const redis = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  console.log("🚀 Starting historical import...\n");

  for (const [sensorId, filename] of Object.entries(SENSOR_FILES)) {
    console.log(`📊 Processing ${sensorId} (${filename})...`);
    const raw = parseCSV(filename);
    if (!raw.length) continue;
    const samples = downsample(raw);
    console.log(`   ${raw.length} raw → ${samples.length} 5-min buckets`);

    // Write in batches of 100 to avoid rate limits
    let written = 0;
    for (let i = 0; i < samples.length; i += 100) {
      const batch = samples.slice(i, i + 100);
      const pipeline = redis.pipeline();
      for (const { ts, temp } of batch) {
        const key = `reading:${ts}`;
        // Each key holds readings for all sensors at that timestamp
        // We merge with existing data if present
        pipeline.hset(key, { [sensorId]: temp });
        pipeline.expire(key, TTL_SECONDS);
      }
      await pipeline.exec();
      written += batch.length;
      process.stdout.write(`\r   Written: ${written}/${samples.length}`);
    }
    console.log(`\n   ✓ Done\n`);
  }

  console.log("✅ Import complete!");
  console.log("   Your historical data is now in Upstash and will appear in the dashboard charts.");
}

main().catch(err => {
  console.error("❌ Import failed:", err.message);
  process.exit(1);
});
