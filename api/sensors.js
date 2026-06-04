export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    // Get token
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

    // Try fetching just one sensor and return the raw response
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
          targetDevice: "d88b4c01000c37d0",
          token: token,
        }
      }),
    });
    const raw = await r.json();

    // Return everything so we can see what YoLink is actually sending back
    res.status(200).json({ token: token.slice(0, 10) + "...", raw });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}