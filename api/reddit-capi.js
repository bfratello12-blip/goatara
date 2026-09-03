const crypto = require("node:crypto");

const MAX_STRING_LENGTH = 2048;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

// Only Reddit's standard LEAD event is accepted; no custom event types.
const EVENT_MAP = {
  Lead: { tracking_type: "LEAD" },
};

function isValidString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Reddit's email rule: lowercase, drop the +alias, remove dots from the
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

// Reddit's phone canonicalization: drop extension, strip everything but
// digits, assume US country code for bare 10-digit numbers, then hash.
function normalizePhone(phone) {
  const withoutExtension = phone.replace(/\s*(ext\.?|x|#)\s*\d+\s*$/i, "");
  const digits = withoutExtension.replace(/\D/g, "");
  if (!digits) return undefined;
  const e164Digits = digits.length === 10 ? `1${digits}` : digits;
  return sha256(`+${e164Digits}`);
}

// Vercel terminates TLS upstream, so the socket address is the proxy, not the visitor.
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.length) return realIp.trim();
  return req.socket ? req.socket.remoteAddress : undefined;
}

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

function toDimension(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 20000 ? Math.round(n) : undefined;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.REDDIT_CAPI_TOKEN;
  const pixelId = process.env.REDDIT_PIXEL_ID;
  if (!token || !pixelId) {
    console.error("Reddit CAPI is not configured", { hasToken: Boolean(token), hasPixelId: Boolean(pixelId) });
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: "Malformed JSON body" });

  const eventDef = EVENT_MAP[body.event];
  if (!eventDef || !isValidString(body.conversionId, 128)) {
    return res.status(400).json({ error: "Invalid event or conversionId" });
  }

  const user = {
    ip_address: getClientIp(req),
    user_agent: isValidString(req.headers["user-agent"], MAX_STRING_LENGTH) ? req.headers["user-agent"] : undefined,
  };

  const width = toDimension(body.screenWidth);
  const height = toDimension(body.screenHeight);
  if (width && height) user.screen_dimensions = { width, height };

  if (isValidString(body.email, 254)) user.email = normalizeEmail(body.email);
  if (isValidString(body.phone, 32)) user.phone_number = normalizePhone(body.phone);
  if (isValidString(body.uuid, 128)) user.uuid = body.uuid;

  let eventSourceUrl;
  if (isValidString(body.eventSourceUrl, MAX_STRING_LENGTH)) {
    try {
      eventSourceUrl = new URL(body.eventSourceUrl).toString();
    } catch (err) {
      /* omit an unparsable URL rather than fail the whole event */
    }
  }

  // Trust the client clock only within a sane window, otherwise stamp on arrival.
  const now = Date.now();
  const clientEventAt = Number(body.eventAt);
  const eventAt =
    Number.isFinite(clientEventAt) && clientEventAt > now - MAX_EVENT_AGE_MS && clientEventAt <= now + MAX_CLOCK_SKEW_MS
      ? Math.round(clientEventAt)
      : now;

  const redditPayload = {
    data: {
      events: [
        {
          event_at: eventAt,
          action_source: "WEBSITE",
          event_source_url: eventSourceUrl,
          click_id: isValidString(body.clickId, 512) ? body.clickId : undefined,
          type: eventDef,
          metadata: { conversion_id: body.conversionId },
          user,
        },
      ],
    },
  };

  try {
    const redditRes = await fetch(
      `https://ads-api.reddit.com/api/v3/pixels/${encodeURIComponent(pixelId)}/conversion_events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(redditPayload),
      }
    );

    if (!redditRes.ok) {
      console.error("Reddit CAPI rejected event", redditRes.status, await redditRes.text());
      return res.status(502).json({ error: "Upstream error" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Reddit CAPI request failed", err && err.message);
    return res.status(502).json({ error: "Upstream error" });
  }
};
