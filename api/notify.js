// api/notify.js — called internally by sensors.js, not directly by the browser

const RESEND_API_URL = "https://api.resend.com/emails";

export async function sendAlert({ type, cwsTemp, rate, eta, recipients, situationFlag }) {
  if (!process.env.RESEND_API_KEY || !recipients?.length) return;

  const subjects = {
    warning:    `⚠️ HVAC Warning — Chilled Water Rising | American Towers`,
    offline:    `🔴 HVAC Alert — Chiller Offline | American Towers`,
    recovery:   `✅ HVAC Recovery — Chilled Water Nominal | American Towers`,
  };

  const bodies = {
    warning: `
<p>The chilled water supply temperature at American Towers is rising and trending toward an outage.</p>
<table style="border-collapse:collapse;font-family:monospace;margin:16px 0">
  <tr><td style="padding:4px 16px 4px 0;color:#666">Current CWS Temp</td><td><strong>${cwsTemp}°F</strong></td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Rate of Rise</td><td><strong>${rate}°F / 10 min</strong></td></tr>
  ${eta ? `<tr><td style="padding:4px 16px 4px 0;color:#666">Est. Time to Outage</td><td><strong>${eta}</strong></td></tr>` : ""}
</table>
${situationFlag ? `<p><strong>Engineering note:</strong> ${situationFlag}</p>` : ""}
<p>Monitor live: <a href="https://hvac-dashboard-wheat.vercel.app">HVAC Dashboard</a></p>
    `,
    offline: `
<p>The chilled water supply at American Towers has stopped cooling. The building chiller may be offline.</p>
<table style="border-collapse:collapse;font-family:monospace;margin:16px 0">
  <tr><td style="padding:4px 16px 4px 0;color:#666">Current CWS Temp</td><td><strong>${cwsTemp}°F</strong></td></tr>
</table>
${situationFlag ? `<p><strong>Engineering note:</strong> ${situationFlag}</p>` : ""}
<p>Residents may be experiencing comfort issues. Monitor live: <a href="https://hvac-dashboard-wheat.vercel.app">HVAC Dashboard</a></p>
    `,
    recovery: `
<p>The chilled water supply at American Towers has returned to normal operating range.</p>
<table style="border-collapse:collapse;font-family:monospace;margin:16px 0">
  <tr><td style="padding:4px 16px 4px 0;color:#666">Current CWS Temp</td><td><strong>${cwsTemp}°F</strong></td></tr>
</table>
${situationFlag ? `<p><strong>Engineering note:</strong> ${situationFlag}</p>` : ""}
<p>Monitor live: <a href="https://hvac-dashboard-wheat.vercel.app">HVAC Dashboard</a></p>
    `,
  };

  await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "American Towers HVAC <hvac@resend.dev>",
      to: recipients,
      subject: subjects[type],
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="margin-top:0">${subjects[type]}</h2>
          ${bodies[type]}
          <hr style="margin:24px 0;border:none;border-top:1px solid #eee"/>
          <p style="color:#999;font-size:12px">American Towers · Salt Lake City · Automated HVAC Monitor</p>
        </div>
      `,
    }),
  });
}