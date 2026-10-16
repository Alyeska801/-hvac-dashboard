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

// SLC coordinates for Open-Meteo outdoor temperature
const OUTDOOR_LAT = 40.7608;
const OUTDOOR_LON = -111.8910;

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

    // Step 1: Get YoLink access token + fetch outdoor temp in parallel
    const [tokenRes, outdoorRes] = await Promise.all([
      fetch("https://api.yosmart.com/open/yolink/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: process.env.YOLINK_UAID,
          client_secret: process.env.YOLINK_SECRET_KEY,
        }),
      }),
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${OUTDOOR_LAT}&longitude=${OUTDOOR_LON}&current=temperature_2m&temperature_unit=fahrenheit&forecast_days=1`
      ).catch(() => null),
    ]);

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return res.status(500).json({ error: "Token failed" });

    // Parse outdoor temperature (public weather data only)
    let outdoorF = null;
    try {
      if (outdoorRes && outdoorRes.ok) {
        const outdoorData = await outdoorRes.json();
        const raw = outdoorData?.current?.temperature_2m;
        if (raw != null) outdoorF = +raw.toFixed(1);
      }
    } catch (_) {
      // Outdoor temp fetch failed — continue without it
    }

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

    // Step 9b: Store outdoor temperature (public weather data)
    if (outdoorF != null) {
      await redis.hset(`outdoor:${bucket}`, { temp: outdoorF });
      await redis.expire(`outdoor:${bucket}`, TTL_SECONDS);
    }

    // Step 10: Cache latest reading (includes outdoor temp for analysis context)
    await redis.set("latest-reading", JSON.stringify({
      readings, cwsStatus, ambientF, outdoorF, timestamp: new Date().toISOString(),
    }), { ex: 600 });

    // Step 10b: Update outage cache incrementally
    // Tracks both "offline" and "degraded" as an active outage event.
    // Brief dips to nominal within recoveryGraceMins do NOT close the event —
    // this lets a sustained degraded period like Oct 11→now show as one outage.
    try {
      const cached = await redis.get("outages-cache") || { outages: [], lastUpdated: 0 };
      let outages = cached.outages || [];
      const last = outages[outages.length - 1];
      const graceMergeMs = (settings.recoveryGraceMins ?? 120) * 60 * 1000;
      const isOutageActive = cwsStatus === "offline" || cwsStatus === "degraded";

      if (isOutageActive) {
        // Check if we should merge with a recently-closed outage (brief nominal dip)
        const shouldMerge = last && !last.ongoing && last.end && (now - last.end) < graceMergeMs;
        if (last && (last.ongoing || shouldMerge)) {
          // Extend or re-open existing outage (merge brief nominal gap)
          last.ongoing = true;
          last.end = null;
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
      } else if (!isOutageActive && last && last.ongoing) {
        // Nominal reading — tentatively close the outage.
        // It will be re-opened if degraded/offline resumes within graceMergeMs.
        last.ongoing = false;
        last.end = now;
        last.durationHrs = +((now - last.start) / 3600000).toFixed(1);
        // Keep _ambientSum/_ambientCount for potential merge; clean up only on final close
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
    // outageStartTime is set once when an outage begins and carried through ALL
    // state transitions (recovery, re-failure) until a new genuine nominal period.
    try {
      if (recipients.length && cwsTemp != null) {
        const alertState = await redis.get("hvac-alert-state") || {};
        const lastAlertType = alertState.type;
        const lastAlertTime = alertState.time || 0;
        const timeSinceLast = now - lastAlertTime;

        if (cwsStatus === "nominal" && lastAlertType && lastAlertType !== "recovery" && sendRecovery) {
          // Set recovering state in settings
          const graceMins = settings.recoveryGraceMins ?? 120;
          const recoveringUntil = now + graceMins * 60 * 1000;
          const current = await redis.get("hvac-settings") || {};
          await redis.set("hvac-settings", { ...current, recoveringUntil, engState: current.engState || "none" });

          // Build outage summary from alert state
          // Use outageStartTime if present (persists through brief recoveries), else fall back to alertState.time
          const outageStart = alertState.outageStartTime || alertState.time || null;
          const durationHrs = outageStart ? +((now - outageStart) / 3600000).toFixed(1) : null;
          const peakTemp = alertState.peakTemp || cwsTemp;
          const startStr = outageStart ? new Date(outageStart).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}) : "unknown";
          const endStr = new Date(now).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false});

          await sendAlert({ type: "recovery", cwsTemp, recipients, situationFlag, durationHrs, peakTemp, startStr, endStr });
          // Carry outageStartTime through recovery — cleared only when graceMins elapse
          await redis.set("hvac-alert-state", {
            type: "recovery",
            time: now,
            outageStartTime: alertState.outageStartTime || alertState.time,
            peakTemp: alertState.peakTemp || cwsTemp,
          });
        } else if (cwsStatus === "offline" && lastAlertType !== "offline") {
          // Starting a new offline period.
          // If we were already tracking an outage (degraded or recovery), keep the ORIGINAL outageStartTime.
          // Otherwise this is a fresh outage — set outageStartTime to now.
          const isEscalation = (lastAlertType === "recovery" || lastAlertType === "degraded") && alertState.outageStartTime;
          const outageStartTime = isEscalation ? alertState.outageStartTime : now;
          await sendAlert({ type: "offline", cwsTemp, recipients, situationFlag });
          await redis.set("hvac-alert-state", {
            type: "offline",
            time: now,
            outageStartTime,
            peakTemp: cwsTemp,
          });
        } else if (cwsStatus === "offline" && lastAlertType === "offline") {
          // Still offline — update peak temp if higher, preserve outageStartTime
          if (cwsTemp > (alertState.peakTemp || 0)) {
            await redis.set("hvac-alert-state", { ...alertState, peakTemp: cwsTemp });
          }
        } else if (cwsStatus === "degraded") {
          // Degraded: set outageStartTime if not already tracking an outage
          const alreadyTracking = alertState.outageStartTime &&
            (lastAlertType === "degraded" || lastAlertType === "offline" || lastAlertType === "recovery");
          if (!alreadyTracking) {
            // First tick into degraded — record outage start time
            await redis.set("hvac-alert-state", {
              ...alertState,
              type: "degraded",
              outageStartTime: alertState.outageStartTime || now,
              peakTemp: Math.max(alertState.peakTemp || 0, cwsTemp),
            });
          } else {
            // Still degraded — keep outageStartTime, update peak temp
            if (cwsTemp > (alertState.peakTemp || 0)) {
              await redis.set("hvac-alert-state", { ...alertState, type: "degraded", peakTemp: cwsTemp });
            }
          }

          // Check rate of rise for warning alert (only when not already offline)
          if (lastAlertType !== "offline") {
            const rorPipeline = redis.pipeline();
            for (let i = 1; i <= 6; i++) rorPipeline.hget(`reading:${bucket - i * BUCKET_MS}`, "CHW-S");
            const historical = await rorPipeline.exec();
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
              }
            }
          }
        } else if (cwsStatus === "nominal" && lastAlertType === "recovery") {
          // Check if grace period has elapsed — if so, clear outageStartTime (genuine recovery)
          const graceMins = settings.recoveryGraceMins ?? 120;
          const graceMs = graceMins * 60 * 1000;
          if (now - lastAlertTime >= graceMs) {
            // Grace period complete — genuine recovery, clear state
            await redis.set("hvac-alert-state", { type: "nominal", time: now });
          }
          // Otherwise leave recovery state as-is (still within grace window)
        }
      }
    } catch (alertErr) {
      console.error("Alert error:", alertErr);
    }

    res.status(200).json({ ok: true, readings, cwsStatus, outdoorF });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
