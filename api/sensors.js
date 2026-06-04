export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // Map our sensor IDs to YoLink device IDs
  const PIPE_SENSOR_IDS = {
    "CHW-S": "d88b4c01000c37d0",
    "CHW-R": "d88b4c01000c37f8",
    "HHW-S": "d88b4c01000c381e",
    "HHW-R": "d88b4c01000c381a",
  };
  const AMBIENT_DEVICE_ID = "d88b4c01000c404d"; // Kitchen sensor — never sent to client

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
    if (!accessToken) return res.status(500).json({ error: "Token failed", detail: tokenData });

    // Step 2: Get device list to retrieve per-device tokens
    const deviceListRes = await fetch("https://api.yosmart.com/open/yolink/v2/api", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        method: "Home.getDeviceList",
        time: Math.floor(Date.now() / 1000),
      }),
    });
    const deviceListData = await deviceListRes.json();
    const devices = deviceListData?.data?.devices || [];

    // Build a map of deviceId -> device token
    const deviceTokenMap = {};
    devices.forEach(d => {
      deviceTokenMap[d.deviceId] = d.token;
    });

    // Step 3: Fetch state for a single device using its own token
    async function getDeviceState(deviceId) {
      const deviceToken = deviceTokenMap[deviceId];
      if (!deviceToken) return null;
      const r = await fetch("https://api.yosmart.com/open/yolink/v2/api", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          method: "THSensor.getState",
          time: Math.floor(Date.now() / 1000),
          targetDevice: deviceId,
          token: deviceToken,
        }),
      });
      return r.json();
    }

    // Step 4: Fetch all pipe sensors in parallel
    const pipeEntries = Object.entries(PIPE_SENSOR_IDS);
    const pipeResults = await Promise.all(pipeEntries.map(([, deviceId]) => getDeviceState(deviceId)));

    // Step 5: Fetch ambient sensor (server-side only)
    const ambientResult = await getDeviceState(AMBIENT_DEVICE_ID);

    // Step 6: Parse pipe readings — YoLink returns Celsius, convert to Fahrenheit
    const readings = {};
    pipeEntries.forEach(([sensorId], i) => {
      const state = pipeResults[i]?.data?.state;
      if (state?.temperature != null) {
        readings[sensorId] = +(state.temperature * 9 / 5 + 32).toFixed(1);
      }
    });

    // Step 7: Parse ambient temp (never leaves server)
    const ambientC = ambientResult?.data?.state?.temperature;
    const ambientF = ambientC != null ? +(ambientC * 9 / 5 + 32).toFixed(1) : null;

    // Step 8: Derive chiller status server-side
    const cwsTemp = readings["CHW-S"];
    const chillerOffline = cwsTemp != null && (
      (ambientF !== null && cwsTemp >= ambientF - 8) || cwsTemp >= 65
    );
    const cwsStatus = cwsTemp == null ? "nominal"
      : chillerOffline ? "offline"
      : cwsTemp >= 57 ? "degraded"
      : "nominal";

    res.status(200).json({
      readings,
      cwsStatus,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}