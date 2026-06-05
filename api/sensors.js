import { Redis } from "@upstash/redis";
import { sendAlert } from "./notify.js";

const redis = Redis.fromEnv();

const PIPE_SENSORS = [
  { id: "CHW-S", deviceId: "d88b4c01000c37d0" },
  { id: "CHW-R", deviceId: "d88b4c01000c37f8" },
  { id: "HHW-S", deviceId: "d88b4c01000c381e" },
  { id: "HHW-R", deviceId: "d88b4c01000c381a" },
];
const AMBIENT_DEVICE_ID = "d88b4c01000c404d";
const AMBIENT_MATCH_DELTA = 8;
const BUCKET_MS = 5 * 60 * 1000;
const TTL_SECONDS = 60 * 60 * 24 * 190;

// Warning: rate of rise threshold (°F per 10 minutes)
const WARN_RATE = 1.0;
const WARN_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  try {
    // Step 1: Get access token
    const tokenRes = await fetch("https://api.yosmart.com/open/yolink/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.YOLINK_UAID,
        client_secret: process.env.YOLINK_SECRET_KEY,
      }),
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return res.status(500).json({ error: "Token failed" });

    // Step 2: Get device list for per-device tokens
    const deviceListRes = await fetch("https://api.yosmart.com/open/yolink/v2/api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify({ method: "Home.getDeviceList", time: Math.floor(Date.now() / 1000) }),
    });
    const deviceListData = await deviceListRes.json();
    const devices = deviceListData?.data?.devices || [];
    const deviceTokenMap = {};
    devices.forEach(d => { deviceTokenMap[d.deviceId] = d.token; });

    // Step 3: Fetch device state
    async function getDeviceState(deviceId) {
      const deviceToken = deviceTokenMap[deviceId];
      if (!deviceToken) return null;
      const r = await fetch("https://api.yosmart.com/open/yolink/v2/api", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
        body: JSON.stringify({
          method: "THSensor.getState",
          time: Math.floor(Date.now() / 1000),
          targetDevice: deviceId,
          token: deviceToken,
        }),
      });
      return r.json();
    }

    // Step 4: Fetch all sensors in parallel
    const [pipeResults, ambientResult] = await Promise.all([
      Promise.all(PIPE_SENSORS.map(s => getDeviceState(s.deviceId))),
      getDeviceState(AMBIENT_DEVICE_ID),
    ]);

    // Step 5: Parse readings
    const readings = {};
    PIPE_SENSORS.forEach((s, i) => {
      const state = pipeResults[i]?.data?.state;
      if (state?.temperature != null) {
        readings[s.id] = +(state.temperature * 9 / 5 + 32).toFixed(1);
      }
    });

    // Step 6: Ambient (server-side only)
    const ambientC = ambientResult?.data?.state?.temperature;
    const ambientF = ambientC != null ? +(ambientC * 9 / 5 + 32).toFixed(1) : null;

    // Step 7: CWS status
    const cwsTemp = readings["CHW-S"];
    const chillerOffline = cwsTemp != null && (
      (ambientF !== null && cwsTemp >= ambientF - AMBIENT_MATCH_DELTA) || cwsTemp >= 65
    );
    const cwsStatus = cwsTemp == null ? "nominal"
      : chillerOffline ? "offline"
      : cwsTemp >= 57 ? "degraded"
      : "nominal";

    // Step 8: Store reading in Upstash (CHW only, 5-min buckets)
    const now = Date.now();
    const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const readingKey = `reading:${bucket}`;
    const storeData = {};
    if (readings["CHW-S"] != null) storeData["CHW-S"] = readings["CHW-S"];
    if (readings["CHW-R"] != null) storeData["CHW-R"] = readings["CHW-R"];
    if (Object.keys(storeData).length) {
      await redis.hset(readingKey, storeData);
      await redis.expire(readingKey, TTL_SECONDS);
    }

    // Step 9: Alert logic
    try {
      const settings = await redis.get("hvac-settings") || {};
      const recipients = settings.alertRecipients || [];
      const situationFlag = settings.situationFlag || "";
      const alertState = await redis.get("hvac-alert-state") || {};

      if (recipients.length && cwsTemp != null) {
        const lastAlertType = alertState.type;
        const lastAlertTime = alertState.time || 0;
        const timeSinceLast = now - lastAlertTime;

        // Recovery — was alerting, now nominal
        if (cwsStatus === "nominal" && lastAlertType && lastAlertType !== "recovery") {
          await sendAlert({ type: "recovery", cwsTemp, recipients, situationFlag });
          await redis.set("hvac-alert-state", { type: "recovery", time: now });
        }

        // Outage — crossed into offline
        else if (cwsStatus === "offline" && lastAlertType !== "offline") {
          await sendAlert({ type: "offline", cwsTemp, recipients, situationFlag });
          await redis.set("hvac-alert-state", { type: "offline", time: now });
        }

        // Warning — degraded + rising fast
        else if (cwsStatus === "degraded" && lastAlertType !== "offline") {
          // Check rate of rise over last 6 buckets (30 min)
          const pipeline = redis.pipeline();
          for (let i = 1; i <= 6; i++) {
            pipeline.hget(`reading:${bucket - i * BUCKET_MS}`, "CHW-S");
          }
          const historical = await pipeline.exec();
          const pastTemps = historical
            .map(v => v != null ? parseFloat(v) : null)
            .filter(v => v != null);

          if (pastTemps.length >= 2) {
            const oldest = pastTemps[pastTemps.length - 1];
            const elapsed10min = (pastTemps.length * BUCKET_MS) / (10 * 60 * 1000);
            const rate = +((cwsTemp - oldest) / elapsed10min).toFixed(2);

            if (rate >= WARN_RATE && timeSinceLast > WARN_COOLDOWN_MS) {
              // Estimate time to outage
              const degToOutage = 65 - cwsTemp;
              const minsToOutage = rate > 0 ? Math.round(degToOutage / rate * 10) : null;
              const eta = minsToOutage ? `approximately ${minsToOutage} minutes` : null;
              await sendAlert({ type: "warning", cwsTemp, rate, eta, recipients, situationFlag });
              await redis.set("hvac-alert-state", { type: "warning", time: now });
            }
          }
        }
      }
    } catch (alertErr) {
      console.error("Alert error:", alertErr);
    }

    res.status(200).json({ readings, cwsStatus, timestamp: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}