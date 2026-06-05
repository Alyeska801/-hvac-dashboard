export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method !== "POST") return res.status(405).end();

  const { summary, cwsStatus, currentReading } = req.body;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: `You are analyzing HVAC chilled water supply (CWS) temperature data for American Towers, a high-rise condo in Salt Lake City. The building chiller has been experiencing issues.\n\nCURRENT STATUS: ${cwsStatus.toUpperCase()} — CWS is currently ${currentReading}°F\n(Nominal = below 57°F, Degraded = 57-65°F, Offline = above 65°F)\n\nHISTORICAL CWS DATA (hourly samples):\n${summary}\n\nProvide:\n1. Confirmed outage events — start time, peak temp, duration, recovery\n2. Pattern analysis — time of day, day of week, conditions preceding outages\n3. Current situation assessment vs historical pre-outage signatures\n4. Predictive assessment — likely trajectory\n5. Brief recommendation for building engineering\n\nBe specific with dates and temperatures. Plain English for both engineers and HOA board members.` }],
    }),
  });

  const data = await response.json();
  const text = data.content?.find(b => b.type === "text")?.text || "Analysis unavailable.";
  res.status(200).json({ analysis: text });
}