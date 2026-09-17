const { setTimeout: retryDelay } = require("node:timers/promises");
const { randomUUID } = require("node:crypto");

const MAX_STRING_LENGTH = 2048;
const MAX_BODY_BYTES = 64 * 1024;
const CRM_INTAKE_PATH = "/api/intake/leads";
const WEBSITE_HOSTS = new Set(["goatara.com", "www.goatara.com"]);

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

const CRM_FIELDS = [
  ["current_stage", "currentSituation", 10000, true],
  ["store_url", "storeUrl", 2000, false],
  ["product_category", "products", 10000, true],
  ["sku_count", "productCount", 200, false],
  ["revenue_range", "monthlyRevenue", 200, true],
  ["fulfillment_method", "shippingMethod", 2000, true],
  ["launch_timeline", "desiredStart", 1000, true],
  ["name", "fullName", 200, true],
  ["company", "businessName", 200, false],
  ["email", "email", 254, true],
  ["phone", "phone", 80, true],
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

async function saveToSheets(body) {
  const sheetsUrl = process.env.GOATARA_SHEETS_URL;
  const sheetsSecret = process.env.GOATARA_SHEETS_SECRET;
  if (!sheetsUrl || !sheetsSecret) return;

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
      signal: AbortSignal.timeout(5000),
    });

    if (!sheetsRes.ok) {
      console.error("Google Sheets lead sync rejected the request", { status: sheetsRes.status });
    }
    await sheetsRes.body?.cancel();
  } catch {
    console.error("Google Sheets lead sync request failed");
  }
}

async function sendLeadEmail(body, deliveryId) {
  const payload = Object.fromEntries(CRM_FIELDS.map(([field]) => [field, (body[field] || "").trim()]));
  Object.assign(payload, {
    _subject: "New partnership application \u2014 Goatara",
    _template: "table",
    _cc: "bfratello@goatara.com,hmdodds@goatara.com,emdodds@goatara.com",
    _honey: "",
  });
  try {
    const response = await fetch("https://formsubmit.co/ajax/contact@goatara.com", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.goatara.com",
        Referer: "https://www.goatara.com/",
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const receipt = response.ok ? await response.json().catch(() => null) : null;
    if (response.ok && (receipt?.success === true || receipt?.success === "true")) {
      console.info("Lead email delivery", { deliveryId, status: response.status, outcome: "success" });
      return { ok: true, status: 200 };
    }
    await response.body?.cancel().catch(() => {});
    console.error("Lead email delivery", {
      deliveryId, status: response.status, category: "provider_rejected", outcome: "failure",
    });
  } catch (error) {
    console.error("Lead email delivery", {
      deliveryId, category: requestErrorCategory(error), outcome: "failure",
    });
  }
  return { ok: false, status: 502, error: "Email delivery failed" };
}

function logCrmDelivery(diagnostic, event, details = {}) {
  const record = { ...diagnostic, event, status: null, category: null, ...details };
  if (record.category && record.category !== "accepted") console.error("CRM lead delivery", record);
  else console.info("CRM lead delivery", record);
}

function responseCategory(status) {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status === 409) return "conflict";
  if (status === 400) return "validation";
  if (status >= 500) return "upstream_5xx";
  if (status >= 300 && status < 400) return "redirect";
  return "http_rejection";
}

function requestErrorCategory(error) {
  const code = error?.cause?.code || error?.code;
  if (["TimeoutError", "AbortError"].includes(error?.name) ||
    ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) {
    return "timeout";
  }
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID", "SELF_SIGNED_CERT_IN_CHAIN"].includes(code)) return "tls";
  return "network";
}

function crmConfiguration() {
  const configuredUrl = process.env.CRM_INTAKE_URL?.trim();
  if (!configuredUrl) return { category: "missing_url" };
  let endpoint;
  try {
    const base = new URL(configuredUrl);
    const localHttp = process.env.NODE_ENV !== "production" && base.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if ((!localHttp && base.protocol !== "https:") || base.username || base.password ||
      base.search || base.hash || !["", CRM_INTAKE_PATH].includes(base.pathname.replace(/\/+$/, ""))) {
      return { category: "invalid_url" };
    }
    endpoint = new URL(CRM_INTAKE_PATH, base);
  } catch {
    return { category: "invalid_url" };
  }
  const secret = process.env.CRM_INTAKE_SECRET;
  if (!secret) return { endpoint, category: "missing_secret" };
  if (secret.length < 32 || !/^[\x21-\x7e]+$/.test(secret)) return { endpoint, category: "invalid_secret" };
  const protectionBypass = process.env.CRM_VERCEL_PROTECTION_BYPASS;
  if (protectionBypass && !/^[\x21-\x7e]+$/.test(protectionBypass)) {
    return { endpoint, category: "invalid_protection_bypass" };
  }
  return { endpoint, secret, protectionBypass, category: "valid_format" };
}

async function saveToCrm(payload, submissionId, diagnostic, configuration) {
  const finish = (result, category, status = null) => {
    logCrmDelivery(diagnostic, "complete", { outcome: result.ok ? "success" : "failure", category, status });
    return result;
  };
  const { endpoint, secret, protectionBypass, category } = configuration;
  diagnostic.hostname = endpoint?.hostname ?? null;
  if (category !== "valid_format") {
    return finish({ ok: false, status: 503, error: "CRM is not configured" }, category);
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${secret}`,
    "Idempotency-Key": submissionId,
  };
  if (protectionBypass) {
    headers["x-vercel-protection-bypass"] = protectionBypass;
  }
  const body = JSON.stringify(payload);
  let lastStatus = null;
  let lastCategory = "network";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    diagnostic.attempt = attempt;
    diagnostic.attempted = true;
    logCrmDelivery(diagnostic, "attempt");
    lastStatus = null;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      lastStatus = response.status;
      if (response.ok) {
        const receipt = await response.json().catch(() => null);
        if (receipt && typeof receipt.companyId === "string" && receipt.companyId &&
          typeof receipt.created === "boolean" && typeof receipt.replayed === "boolean") {
          logCrmDelivery(diagnostic, "response", { status: response.status, category: "accepted" });
          return finish({ ok: true, status: 200 }, "accepted", response.status);
        }
        lastCategory = "invalid_receipt";
      } else {
        lastCategory = responseCategory(response.status);
        await response.body?.cancel().catch(() => {});
      }
      logCrmDelivery(diagnostic, "response", { status: response.status, category: lastCategory });
      if (!response.ok && response.status !== 429 && response.status < 500) {
        return finish({ ok: false, status: [400, 409].includes(response.status) ? response.status : 502,
          error: "CRM delivery failed" }, lastCategory, response.status);
      }
    } catch (error) {
      lastCategory = requestErrorCategory(error);
      logCrmDelivery(diagnostic, "response", { status: lastStatus, category: lastCategory });
    }
    if (attempt < 3) await retryDelay(250 * 2 ** (attempt - 1));
  }
  return finish({ ok: false, status: lastStatus === 429 ? 429 : 502, error: "CRM delivery failed" }, lastCategory, lastStatus);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Goatara-Lead-Relay", "crm-v1");
  const configuration = crmConfiguration();
  res.setHeader("X-Goatara-CRM-Config", configuration.category);
  const diagnostic = { deliveryId: randomUUID(), attempted: false, hostname: null, path: CRM_INTAKE_PATH, attempt: 0 };
  res.setHeader("X-Goatara-Delivery-Id", diagnostic.deliveryId);
  const reject = (status, error, category) => {
    logCrmDelivery(diagnostic, "complete", { outcome: "failure", category });
    return res.status(status).json({ error });
  };
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reject(405, "Method not allowed", "method");
  }
  if ((req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    return reject(415, "Send a JSON body", "content_type");
  }
  try {
    const origin = req.headers?.origin ? new URL(req.headers.origin) : null;
    const trustedAlias = origin?.protocol === "https:" && WEBSITE_HOSTS.has(origin.host) &&
      WEBSITE_HOSTS.has(req.headers?.host);
    if (req.headers?.["sec-fetch-site"] === "cross-site" ||
      (origin && origin.host !== req.headers.host && !trustedAlias)) {
      return reject(403, "Origin not allowed", "origin");
    }
  } catch {
    return reject(403, "Origin not allowed", "origin");
  }
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return reject(413, "Request body is too large", "body_too_large");
  }
  const body = parseBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reject(400, "Malformed JSON body", "invalid_json");
  }
  if (body._honey) {
    logCrmDelivery(diagnostic, "complete", { outcome: "skipped", category: "honeypot" });
    return res.status(200).json({ ok: true });
  }
  const submissionId = body.submission_id === undefined ? randomUUID() : body.submission_id;
  if (typeof submissionId !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(submissionId)) {
    return reject(400, "Invalid submission ID", "invalid_submission_id");
  }
  const payload = {};
  for (const [field, crmField, maxLength, required] of CRM_FIELDS) {
    if (body[field] != null && typeof body[field] !== "string") {
      return reject(400, `Invalid ${field}`, "invalid_fields");
    }
    const value = (body[field] || "").trim();
    if ((required && !value) || value.length > maxLength) {
      return reject(400, `Invalid ${field}`, "invalid_fields");
    }
    payload[crmField] = value || null;
  }
  if (body.delivery === "email") {
    const email = await sendLeadEmail(body, diagnostic.deliveryId);
    return res.status(email.status).json({ ok: email.ok, delivery: "email", submissionId, ...(email.error ? { error: email.error } : {}) });
  }
  const [crm] = await Promise.all([saveToCrm(payload, submissionId, diagnostic, configuration), saveToSheets(body)]);
  return res.status(crm.status).json({ ok: crm.ok, submissionId, ...(crm.error ? { error: crm.error } : {}) });
};
