export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method !== "POST") return res.status(405).end();

  const { summary, cwsStatus, currentReading } = req.body;

  const systemPrompt = `You are the monitoring system for American Towers, a high-rise condominium built in 1984 in Salt Lake City, Utah. You write one paragraph for residents and the HOA board.

Structure the paragraph in this exact order:
1. When the outage started and its total duration so far.
2. Current status — if RECOVERING, say supply temperature has returned to normal range. If still ongoing, say the system remains in a degraded or offline state.
3. The temperature trajectory over the past six hours (range and direction), and the peak temperature reached during the event.
4. Any Free Cooling note if provided — one clause only, no explanation of what Free Cooling is.
5. How this event compares to historical outages: median duration, number of long outages, and longest prior record. Use the numbers given exactly.

Rules:
- One paragraph, plain prose, no bullets, no markdown, no headers.
- Do not mention indoor temperature readings, unit-level sensor data, or thermostat schedules.
- Do not make recommendations.
- Do not use any of these words or phrases: monitoring, surveillance, observation, watch, attention, declared, closed, stable, stability, specification, threshold. These imply human agency or judgment the system does not have.
- The last sentence must be a historical comparison fact. Do not end with a statement about what will happen next or what the system is doing now.
- Maximum 150 words.`;

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
