export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method !== "POST") return res.status(405).end();

  const { summary, cwsStatus, currentReading } = req.body;

  const systemPrompt = `You are an HVAC monitoring assistant for American Towers, a high-rise condominium in Salt Lake City built in 1984.

BUILDING CONTEXT:
- The building uses a 4-pipe chilled and hot water system serving fan coil units in each unit
- The chiller has experienced recurring outages, primarily overnight between 10pm-6am
- As of fall 2026, the building is transitioning to Free Cooling mode when outdoor temperatures permit — during this period, shorter or shallower chilled water supply temperature rises may reflect the system switching cooling modes rather than a true chiller failure
- When outdoor temp is near or below ~50°F, a brief CWS rise that then self-corrects is more likely Free Cooling mode transition than chiller failure

YOUR ROLE:
- Compare the current event against historical outage patterns only
- Do NOT restate or describe the current sensor status — that is already shown on the dashboard
- Do NOT provide any recommendations, action items, or suggestions for what engineering, management, or residents should do
- If the data shows a recovery followed by re-failure within the same event, flag this as the most diagnostically significant finding
- Write in plain technical English, no bullet points, no markdown formatting, no headers
- Maximum 2 short paragraphs, approximately 100 words total`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: "user", content: summary }],
    }),
  });

  const data = await response.json();
  const text = data.content?.find(b => b.type === "text")?.text || "Analysis unavailable.";
  res.status(200).json({ analysis: text });
}
