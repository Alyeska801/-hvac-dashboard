// ─── Historical CSV Importer (updated June 7) ─────────────────────────────
// Run once from your hvac-dashboard folder:
//   node import-history.mjs
//
// Imports CWS, CHW-R, and Ambient data into Upstash.
// Ambient is stored separately for the outage analysis visual.

import { Redis } from "@upstash/redis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const [k, ...v] = line.split("=");
    if (k && v.length) process.env[k.trim()] = v.join("=").trim().replace(/^"|"$/g, "");
  }
}

// Update these filenames to match your downloaded CSVs
const SENSOR_FILES = {
  "CHW-S":   "d88b4c01000c37d0-20260607205202.csv",
  "CHW-R":   "d88b4c01000c37f8-20260607210120.csv",
  "AMBIENT": "d88b4c01000c37d0-20260607211328.csv",
};

const BUCKET_MS   = 5 * 60 * 1000;
const TTL_SECONDS = 60 * 60 * 24 * 190;

function parseCSV(filePath, isAmbient = false) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  ⚠ File not found: ${filePath} — skipping`);
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n").slice(1);
  const points = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const timeStr = parts[1].trim();
    const tempStr = parts[2].trim().replace("℉", "");
    const temp    = parseFloat(tempStr);
    if (isNaN(temp)) continue;
    const normalized = timeStr.replace("/", "-").replace("/", "-").replace(" ", "T");
    const ts = new Date(normalized).getTime();
    if (isNaN(ts)) continue;
    const point = { ts, temp };
    // Also capture humidity for ambient
    if (isAmbient && parts[3]) {
      const hum = parseFloat(parts[3].trim().replace("%RH",""));
      if (!isNaN(hum)) point.humidity = hum;
    }
    points.push(point);
  }
  return points;
}

function downsample(points, bucketMs) {
  const buckets = new Map();
  for (const p of points) {
    const bucket = Math.floor(p.ts / bucketMs) * bucketMs;
    if (!buckets.has(bucket)) buckets.set(bucket, { temps: [], humidities: [] });
    buckets.get(bucket).temps.push(p.temp);
    if (p.humidity != null) buckets.get(bucket).humidities.push(p.humidity);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, { temps, humidities }]) => ({
      ts,
      temp: +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1),
      ...(humidities.length ? { humidity: +(humidities.reduce((a,b)=>a+b,0)/humidities.length).toFixed(1) } : {}),
    }));
}

async function main() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("❌ Missing KV_REST_API_URL or KV_REST_API_TOKEN in .env.local");
    process.exit(1);
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  console.log("🚀 Starting historical import...\n");

  // ── CHW-S and CHW-R into reading buckets ──────────────────────────────────
  const allBuckets = new Map();
  for (const [sensorId, filename] of [["CHW-S", SENSOR_FILES["CHW-S"]], ["CHW-R", SENSOR_FILES["CHW-R"]]]) {
    console.log(`📊 Parsing ${sensorId} (${filename})...`);
    const raw = parseCSV(filename);
    if (!raw.length) continue;
    const samples = downsample(raw, BUCKET_MS);
    console.log(`   ${raw.length} raw → ${samples.length} 5-min buckets`);
    for (const { ts, temp } of samples) {
      if (!allBuckets.has(ts)) allBuckets.set(ts, {});
      allBuckets.get(ts)[sensorId] = temp;
    }
  }

  const bucketList = [...allBuckets.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`\n💾 Writing ${bucketList.length} CHW buckets to Upstash...`);
  let written = 0;
  for (let i = 0; i < bucketList.length; i += 50) {
    const batch = bucketList.slice(i, i + 50);
    const pipeline = redis.pipeline();
    for (const [ts, data] of batch) {
      pipeline.hset(`reading:${ts}`, data);
      pipeline.expire(`reading:${ts}`, TTL_SECONDS);
    }
    await pipeline.exec();
    written += batch.length;
    process.stdout.write(`\r   Written: ${written}/${bucketList.length}`);
  }
  console.log("\n   ✓ Done\n");

  // ── Ambient into separate keys ────────────────────────────────────────────
  console.log(`🌡  Parsing AMBIENT (${SENSOR_FILES["AMBIENT"]})...`);
  const ambientRaw = parseCSV(SENSOR_FILES["AMBIENT"], true);
  if (ambientRaw.length) {
    const ambientSamples = downsample(ambientRaw, BUCKET_MS);
    console.log(`   ${ambientRaw.length} raw → ${ambientSamples.length} 5-min buckets`);
    let ambWritten = 0;
    for (let i = 0; i < ambientSamples.length; i += 50) {
      const batch = ambientSamples.slice(i, i + 50);
      const pipeline = redis.pipeline();
      for (const { ts, temp, humidity } of batch) {
        const data = { temp };
        if (humidity != null) data.humidity = humidity;
        pipeline.hset(`ambient:${ts}`, data);
        pipeline.expire(`ambient:${ts}`, TTL_SECONDS);
      }
      await pipeline.exec();
      ambWritten += batch.length;
      process.stdout.write(`\r   Written: ${ambWritten}/${ambientSamples.length}`);
    }
    console.log("\n   ✓ Done\n");
  }

  console.log("✅ Import complete!");
  console.log("   All historical data is now in Upstash.");
}

main().catch(err => {
  console.error("❌ Import failed:", err.message);
  process.exit(1);
});
