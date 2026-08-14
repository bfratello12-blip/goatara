const crypto = require("node:crypto");

const PIXEL_ID = process.env.REDDIT_PIXEL_ID || "a2_jiauuur40mwb";
const CAPI_URL = `https://ads-api.reddit.com/api/v3/pixels/${PIXEL_ID}/conversion_events`;
const MAX_STRING_LENGTH = 2048;

// Maps our client-side event names to Reddit's CAPI type object.
const EVENT_MAP = {
  Lead: { tracking_type: "LEAD" },
  BookCallClick: { tracking_type: "CUSTOM", custom_event_name: "BookCallClick" },
  CallClick: { tracking_type: "CUSTOM", custom_event_name: "CallClick" },
};

function isValidString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Reddit's exact email rule: lowercase, drop the +alias, remove dots from the
// local part only (other characters kept as-is), then hash.
function normalizeEmail(email) {
  const lower = email.trim().toLowerCase();
  const atIndex = lower.indexOf("@");
  if (atIndex === -1) return sha256(lower);
  const domain = lower.slice(atIndex + 1);
  let localPart = lower.slice(0, atIndex);
  const plusIndex = localPart.indexOf("+");
  if (plusIndex !== -1) localPart = localPart.slice(0, plusIndex);
  localPart = localPart.replace(/\./g, "");
  return sha256(`${localPart}@${domain}`);
}

// Reddit's exact phone canonicalization: drop extension, strip everything
// but digits, assume US country code for bare 10-digit numbers, then hash.
function normalizePhone(phone) {
  const withoutExtension = phone.replace(/\s*(ext\.?|x|#)\s*\d+\s*$/i, "");
  const digits = withoutExtension.replace(/\D/g, "");
  const e164Digits = digits.length === 10 ? `1${digits}` : digits;
  return sha256(`+${e164Digits}`);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return req.socket ? req.socket.remoteAddress : undefined;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.REDDIT_CAPI_TOKEN;
  if (!token) {
    console.error("REDDIT_CAPI_TOKEN is not configured");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  const body = req.body || {};
  const eventDef = EVENT_MAP[body.event];
  if (!eventDef || !isValidString(body.conversionId, 128)) {
    return res.status(400).json({ error: "Invalid event or conversionId" });
  }

  const user = {
    ip_address: getClientIp(req),
    user_agent: isValidString(req.headers["user-agent"], MAX_STRING_LENGTH) ? req.headers["user-agent"] : undefined,
  };

  if (body.event === "Lead") {
    if (isValidString(body.email, 254)) user.email = normalizeEmail(body.email);
    if (isValidString(body.phone, 32)) user.phone_number = normalizePhone(body.phone);
  }

  let eventSourceUrl;
  if (isValidString(body.eventSourceUrl, MAX_STRING_LENGTH)) {
    try {
      eventSourceUrl = new URL(body.eventSourceUrl).toString();
    } catch (err) {
      /* omit an unparsable URL rather than fail the whole event */
    }
  }

  const clickId = isValidString(body.clickId, 128) ? body.clickId : undefined;

  const redditPayload = {
    data: {
      // Temporary: routes events as test-only in Reddit's Events Manager when set.
      test_id: process.env.REDDIT_CAPI_TEST_ID || undefined,
      events: [
        {
          event_at: Date.now(),
          action_source: "WEBSITE",
          event_source_url: eventSourceUrl,
          click_id: clickId,
          type: eventDef,
          metadata: { conversion_id: body.conversionId },
          user,
        },
      ],
    },
  };

  try {
    const redditRes = await fetch(CAPI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(redditPayload),
    });

    if (!redditRes.ok) {
      console.error("Reddit CAPI rejected event", redditRes.status, await redditRes.text());
      return res.status(502).json({ error: "Upstream error" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Reddit CAPI request failed", err);
    return res.status(502).json({ error: "Upstream error" });
  }
};
