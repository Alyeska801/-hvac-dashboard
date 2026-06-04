export default async function handler(req, res) {
  // Set CORS headers so the frontend can call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  try {
    // Step 1: Get an access token using your credentials
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

    if (!token) {
      return res.status(500).json({ error: "Failed to get YoLink token", detail: tokenData });
    }

    // Step 2: Get the list of devices in your home
    const devicesRes = await fetch("https://api.yosmart.com/open/yolink/v2/api", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        method: "Home.getDeviceList",
        time: Math.floor(Date.now() / 1000),
      }),
    });
    const devicesData = await devicesRes.json();

    // Return the raw device list so we can see what YoLink gives us
    res.status(200).json(devicesData);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}