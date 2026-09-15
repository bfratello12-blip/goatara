const MAX_STRING_LENGTH = 2048;

// Every field is optional/free-text from the lead form, so just cap length and coerce to string.
const FIELDS = [
  "current_stage",
  "store_url",
  "product_category",
  "sku_count",
  "revenue_range",
  "fulfillment_method",
  "launch_timeline",
  "name",
  "company",
  "email",
  "phone",
  "page_url",
  "referrer",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
];

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch (err) {
      return null;
    }
  }
  return {};
}

function sanitize(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.slice(0, MAX_STRING_LENGTH);
  return trimmed.length ? trimmed : undefined;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sheetsUrl = process.env.GOATARA_SHEETS_URL;
  const sheetsSecret = process.env.GOATARA_SHEETS_SECRET;
  if (!sheetsUrl || !sheetsSecret) {
    console.error("Google Sheets lead sync is not configured", { hasUrl: Boolean(sheetsUrl), hasSecret: Boolean(sheetsSecret) });
    // The lead form itself must never fail because of this integration.
    return res.status(200).json({ ok: false, error: "Not configured" });
  }

  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: "Malformed JSON body" });

  const payload = { secret: sheetsSecret };
  for (const field of FIELDS) {
    const value = sanitize(body[field]);
    if (value !== undefined) payload[field] = value;
  }

  try {
    const sheetsRes = await fetch(sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });

    if (!sheetsRes.ok) {
      console.error("Google Sheets lead sync rejected the request", sheetsRes.status, await sheetsRes.text());
      // Still 200 — saving to Sheets is a background action, not a blocker for the lead flow.
      return res.status(200).json({ ok: false, error: "Upstream error" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Google Sheets lead sync request failed", err && err.message);
    return res.status(200).json({ ok: false, error: "Request failed" });
  }
};
