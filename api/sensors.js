export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // Sensor map — pipe sensors are public, ambient is back-of-house only
  const PIPE_SENSORS = [
    { id: "CHW-S", deviceId: "d88b4c01000c37d0" },
    { id: "CHW-R", deviceId: "d88b4c01000c37f8" },
    { id: "HHW-S", deviceId: "d88b4c01000c381e" },
    { id: "HHW-R", deviceId: "d88b4c01000c381a" },
  ];
  const AMBIENT_DEVICE_ID = "d88b4c01000c404d"; // Temp Hum 2 (kitchen) — never sent to client

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
    const token = tokenData.access_token;
    if (!token) return res.status(500).json({ error: "Token failed", detail: tokenData });

    // Step 2: Fetch a single device's state
    async function getDeviceState(deviceId) {
      const r = await fetch("https://api.yosmart.com/open/yolink/v2/api", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
body: JSON.stringify({
  method: "THSensor.getState",
  time: Math.floor(Date.now() / 1000),
  data: {
    targetDevice: deviceId,
    token: token,
  }
}),
      });
      return r.json();
    }

    // Step 3: Fetch all pipe sensors in parallel
    const pipeResults = await Promise.all(
      PIPE_SENSORS.map(s => getDeviceState(s.deviceId))
    );

    // Step 4: Fetch ambient sensor (kept server-side)
    const ambientResult = await getDeviceState(AMBIENT_DEVICE_ID);

    // Step 5: Parse pipe sensor readings
    const readings = {};
    PIPE_SENSORS.forEach((s, i) => {
      const state = pipeResults[i]?.data?.state;
      if (state) {
        // YoLink returns Celsius — convert to Fahrenheit
        const tempF = +(state.temperature * 9/5 + 32).toFixed(1);
        readings[s.id] = tempF;
      }
    });

    // Step 6: Parse ambient (server-side only — derive offline status here)
    const ambientC = ambientResult?.data?.state?.temperature;
    const ambientF = ambientC != null ? +(ambientC * 9/5 + 32).toFixed(1) : null;

    // Step 7: Determine chiller offline status server-side
    // CWS within 8°F of ambient = chiller offline
    const cwsTemp = readings["CHW-S"];
    const chillerOffline = ambientF !== null && cwsTemp != null
      ? cwsTemp >= ambientF - 8
      : cwsTemp >= 65;

    const cwsStatus = chillerOffline ? "offline"
      : cwsTemp >= 57 ? "degraded"
      : "nominal";

    // Return public data only — ambient never leaves the server
    res.status(200).json({
      readings,
      cwsStatus,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}