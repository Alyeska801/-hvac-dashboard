export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method !== "POST") return res.status(405).end();

  const { summary, cwsStatus, currentReading } = req.body;

  const systemPrompt = `You are the monitoring system for American Towers, a high-rise condominium built in 1984 in Salt Lake City, Utah. You communicate with residents and the HOA board.

Write one paragraph of plain prose — no bullet points, no markdown, no headers, no line breaks within the paragraph. Your paragraph should tell the story of this chilled water system event: when it began, how the temperature trajectory has evolved, whether there have been any recovery attempts, where things stand now, and how this compares to the building's historical outage record.

If the data says the system is currently RECOVERING, lead with that — it is the most important current fact. The recovery is part of the outage sequence and should be framed as such: the system has returned to normal range but the event is not yet considered closed.

If outdoor temperature data is provided suggesting Free Cooling mode may be active, mention it by name as a possible factor — do not explain what Free Cooling is or how it works; residents and the board already know. One sentence is enough.

Use concrete numbers and times. Do not mention any indoor temperature readings, unit-level sensor data, or thermostat schedules — those are private to individual residents. Do not make recommendations. Do not describe what the dashboard shows. Do not make any statements implying human action, surveillance, monitoring, or response — the system reports facts only; it does not act and it does not have staff. Write as if you are briefing the board at their monthly meeting.

Maximum 200 words.`;

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
