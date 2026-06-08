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

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Load settings — thresholds and alert config all live here now
    const settings = await redis.get("hvac-settings") || {};
    const degradedThreshold = settings.degradedThreshold ?? 57;
    const offlineThreshold  = settings.offlineThreshold  ?? 65;
    const warnRateOfRise    = settings.warnRateOfRise    ?? 1.0;
    const warnCooldownMs    = (settings.warnCooldownHours ?? 4) * 60 * 60 * 1000;
    const recipients        = settings.alertRecipients   || [];
    const situationFlag     = settings.situationFlag     || "";
    const sendRecovery      = settings.sendRecoveryEmails ?? true;

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

    // Step 2: Get device list
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

    // Step 4: Fetch all sensors
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

    // Step 6: Ambient
    const ambientC = ambientResult?.data?.state?.temperature;
    const ambientF = ambientC != null ? +(ambientC * 9 / 5 + 32).toFixed(1) : null;

    // Step 7: CWS status using configurable thresholds
    const cwsTemp = readings["CHW-S"];
    const chillerOffline = cwsTemp != null && (
      (ambientF !== null && cwsTemp >= ambientF - AMBIENT_MATCH_DELTA) ||
      cwsTemp >= offlineThreshold
    );
    const cwsStatus = cwsTemp == null ? "nominal"
      : chillerOffline ? "offline"
      : cwsTemp >= degradedThreshold ? "degraded"
      : "nominal";

    // Step 8: Store CHW readings
    const now = Date.now();
    const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const storeData = {};
    if (readings["CHW-S"] != null) storeData["CHW-S"] = readings["CHW-S"];
    if (readings["CHW-R"] != null) storeData["CHW-R"] = readings["CHW-R"];
    if (Object.keys(storeData).length) {
      await redis.hset(`reading:${bucket}`, storeData);
      await redis.expire(`reading:${bucket}`, TTL_SECONDS);
    }

    // Step 9: Store ambient
    if (ambientF != null) {
      const ambHumidity = ambientResult?.data?.state?.humidity;
      const ambData = { temp: ambientF };
      if (ambHumidity != null) ambData.humidity = +ambHumidity.toFixed(1);
      await redis.hset(`ambient:${bucket}`, ambData);
      await redis.expire(`ambient:${bucket}`, TTL_SECONDS);
    }

    // Step 10: Cache latest reading
    await redis.set("latest-reading", JSON.stringify({
      readings, cwsStatus, ambientF, timestamp: new Date().toISOString(),
    }), { ex: 600 });

    // Step 10b: Update outage cache incrementally
    // This avoids expensive full scans in api/outages.js
    try {
      const cached = await redis.get("outages-cache") || { outages: [], lastUpdated: 0 };
      let outages = cached.outages || [];
      const last = outages[outages.length - 1];

      if (cwsStatus === "offline") {
        if (last && last.ongoing) {
          // Extend current outage
          last.durationHrs = +((now - last.start) / 3600000).toFixed(1);
          last.peakTemp = Math.max(last.peakTemp, cwsTemp ?? 0);
          if (ambientF != null) {
            last._ambientSum = (last._ambientSum || 0) + ambientF;
            last._ambientCount = (last._ambientCount || 0) + 1;
            last.ambientAvg = +(last._ambientSum / last._ambientCount).toFixed(1);
            last.ambientDelta = +(last.peakTemp - last.ambientAvg).toFixed(1);
          }
        } else {
          // Start new outage
          outages.push({
            start: now, end: null, ongoing: true,
            durationHrs: 0, peakTemp: cwsTemp ?? 0,
            ambientAvg: ambientF, ambientDelta: null,
            _ambientSum: ambientF ?? 0, _ambientCount: ambientF != null ? 1 : 0,
          });
        }
      } else if (cwsStatus !== "offline" && last && last.ongoing) {
        // Close outage
        last.ongoing = false;
        last.end = now;
        last.durationHrs = +((now - last.start) / 3600000).toFixed(1);
        // Clean up internal tracking fields
        delete last._ambientSum;
        delete last._ambientCount;
      }

      // Recompute stats
      const totalHrs = (now - (now - 180 * 24 * 60 * 60 * 1000)) / 3600000;
      const offlineHrs = outages.reduce((s, o) => s + o.durationHrs, 0);
      const stats = {
        totalOutages: outages.length,
        offlineHrs: +offlineHrs.toFixed(1),
        uptimePct: +((1 - offlineHrs / totalHrs) * 100).toFixed(1),
      };

      await redis.set("outages-cache", { outages, stats, lastUpdated: now }, { ex: TTL_SECONDS });
    } catch (cacheErr) {
      console.error("Outage cache error:", cacheErr);
    }

    // Step 11: Alert logic using configurable thresholds
    try {
      if (recipients.length && cwsTemp != null) {
        const alertState = await redis.get("hvac-alert-state") || {};
        const lastAlertType = alertState.type;
        const lastAlertTime = alertState.time || 0;
        const timeSinceLast = now - lastAlertTime;

        if (cwsStatus === "nominal" && lastAlertType && lastAlertType !== "recovery" && sendRecovery) {
          await sendAlert({ type: "recovery", cwsTemp, recipients, situationFlag });
          await redis.set("hvac-alert-state", { type: "recovery", time: now });
        } else if (cwsStatus === "offline" && lastAlertType !== "offline") {
          await sendAlert({ type: "offline", cwsTemp, recipients, situationFlag });
          await redis.set("hvac-alert-state", { type: "offline", time: now });
        } else if (cwsStatus === "degraded" && lastAlertType !== "offline") {
          // Check rate of rise
          const pipeline = redis.pipeline();
          for (let i = 1; i <= 6; i++) pipeline.hget(`reading:${bucket - i * BUCKET_MS}`, "CHW-S");
          const historical = await pipeline.exec();
          const pastTemps = historical.map(v => v != null ? parseFloat(v) : null).filter(v => v != null);
          if (pastTemps.length >= 2) {
            const oldest = pastTemps[pastTemps.length - 1];
            const elapsed10min = (pastTemps.length * BUCKET_MS) / (10 * 60 * 1000);
            const rate = +((cwsTemp - oldest) / elapsed10min).toFixed(2);
            if (rate >= warnRateOfRise && timeSinceLast > warnCooldownMs) {
              const degToOutage = offlineThreshold - cwsTemp;
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

    res.status(200).json({ ok: true, readings, cwsStatus });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}