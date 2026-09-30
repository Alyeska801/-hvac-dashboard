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
- As of fall 2026, the building is transitioning to Free Cooling mode when outside temperatures permit — during this period, shorter or shallower temperature rises may reflect the system switching cooling modes rather than a true chiller failure
- Building management and on-call engineering staff may or may not be aware of the current situation
- The resident's thermostat runs to 70°F overnight (9pm-7am), which places peak demand on the chilled water loop during the most vulnerable hours

YOUR ROLE:
- Provide a concise current situation assessment and pattern comparison only
- Do NOT provide operational or technical recommendations
- Do NOT suggest what engineering should do or escalate
- Write in plain English suitable for both residents and HOA board members
- Maximum 3 short paragraphs, no bullet points, no markdown formatting, no headers`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: summary }],
    }),
  });

  const data = await response.json();
  const text = data.content?.find(b => b.type === "text")?.text || "Analysis unavailable.";
  res.status(200).json({ analysis: text });
}