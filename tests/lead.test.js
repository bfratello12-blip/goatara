const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const handler = require("../api/save-lead.js");

const form = {
  submission_id: "fd69cfe0-6a1c-4f16-94a0-fbcc09379b90",
  current_stage: "I sell on Amazon or another marketplace",
  store_url: "https://example.test/products",
  product_category: "Home goods",
  sku_count: "12",
  revenue_range: "Under $5,000",
  fulfillment_method: "3PL / warehouse",
  launch_timeline: "Within 1 month",
  name: "Jordan Lee",
  company: "Example Goods",
  email: "jordan@example.test",
  phone: "+1 555 123 4567",
};

const canonical = {
  currentSituation: form.current_stage,
  storeUrl: form.store_url,
  products: form.product_category,
  productCount: form.sku_count,
  monthlyRevenue: form.revenue_range,
  shippingMethod: form.fulfillment_method,
  desiredStart: form.launch_timeline,
  fullName: form.name,
  businessName: form.company,
  email: form.email,
  phone: form.phone,
};

const receipt = () => Response.json({ companyId: "private-company-id", created: true, replayed: false });

function setup(testContext, environment = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: "test",
    CRM_INTAKE_URL: "https://crm.example.test",
    CRM_INTAKE_SECRET: "test-only-crm-secret-at-least-32-characters",
    CRM_VERCEL_PROTECTION_BYPASS: "",
    GOATARA_SHEETS_URL: "",
    GOATARA_SHEETS_SECRET: "",
  }, environment);
  testContext.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const logs = [];
  testContext.mock.method(console, "error", (...details) => logs.push(details));
  testContext.mock.method(console, "info", (...details) => logs.push(details));
  const calls = [];
  testContext.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return receipt();
  });
  return { calls, logs };
}

async function submit(body = form, overrides = {}) {
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://goatara.com", host: "goatara.com" },
    body,
    ...overrides,
  }, response);
  return response;
}

test("CRM receives all eleven fields, server credentials and a stable non-attribution ID", async (testContext) => {
  const { calls } = setup(testContext, { CRM_VERCEL_PROTECTION_BYPASS: "test-only-bypass" });
  const response = await submit({
    ...form, utm_source: "discard", page_url: "discard", referrer: "discard",
    gclid: "discard", fbclid: "discard", rdt_cid: "discard", source: "discard",
    secret: "untrusted", CRM_INTAKE_URL: "https://untrusted.example",
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].url), "https://crm.example.test/api/intake/leads");
  assert.deepEqual(JSON.parse(calls[0].options.body), canonical);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${process.env.CRM_INTAKE_SECRET}`);
  assert.equal(calls[0].options.headers["Idempotency-Key"], form.submission_id);
  assert.equal(calls[0].options.headers["x-vercel-protection-bypass"], "test-only-bypass");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(response.body).includes("private-company-id"), false);
  assert.equal(JSON.stringify(response.body).includes(process.env.CRM_INTAKE_SECRET), false);
});

test("retired server email requests cannot claim email success or repeat CRM delivery", async (testContext) => {
  const { calls } = setup(testContext);
  const response = await submit({ ...form, delivery: "email" });
  assert.equal(response.statusCode, 410);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.delivery, "email");
  assert.equal(calls.length, 0);
  assert.equal((await submit()).body.ok, true);
  assert.equal(calls.length, 1);
});

test("business name, product count and store URL stay optional", async (testContext) => {
  const { calls } = setup(testContext);
  assert.equal((await submit({ ...form, company: "", sku_count: "", store_url: "" })).body.ok, true);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.businessName, null);
  assert.equal(payload.productCount, null);
  assert.equal(payload.storeUrl, null);
});

test("existing Sheets delivery continues independently of CRM configuration", async (testContext) => {
  const { calls } = setup(testContext, {
    CRM_INTAKE_SECRET: "",
    GOATARA_SHEETS_URL: "https://sheets.example.test/submit",
    GOATARA_SHEETS_SECRET: "test-only-sheets-secret",
  });
  const response = await submit({ ...form, page_url: "existing-page", utm_source: "existing-value" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.ok, false);
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.secret, process.env.GOATARA_SHEETS_SECRET);
  assert.equal(payload.name, form.name);
  assert.equal(payload.page_url, "existing-page");
  assert.equal(payload.utm_source, "existing-value");
  assert.equal("submission_id" in payload, false);
});

test("CRM still succeeds when Sheets fails", async (testContext) => {
  setup(testContext, {
    GOATARA_SHEETS_URL: "https://sheets.example.test/submit",
    GOATARA_SHEETS_SECRET: "test-only-sheets-secret",
  });
  let sheetsCalls = 0;
  testContext.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("sheets.example")) {
      sheetsCalls += 1;
      throw new Error("Sheets offline");
    }
    return receipt();
  });
  assert.equal((await submit()).body.ok, true);
  assert.equal(sheetsCalls, 1);
});

test("transient CRM failures retry the identical payload and idempotency key", async (testContext) => {
  setup(testContext);
  const attempts = [];
  testContext.mock.method(globalThis, "fetch", async (_url, options) => {
    attempts.push(options);
    if (attempts.length === 1) throw new Error("Connection lost after commit");
    if (attempts.length === 2) return new Response("Unavailable", { status: 503 });
    return Response.json({ companyId: "private-company-id", created: false, replayed: true });
  });
  assert.equal((await submit()).body.ok, true);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((attempt) => attempt.headers["Idempotency-Key"] === form.submission_id));
  assert.ok(attempts.every((attempt) => attempt.body === attempts[0].body));
});

test("permanent CRM conflicts are not retried or leaked, and Sheets still runs", async (testContext) => {
  const { logs } = setup(testContext, {
    GOATARA_SHEETS_URL: "https://sheets.example.test/submit",
    GOATARA_SHEETS_SECRET: "test-only-sheets-secret",
  });
  const calls = [];
  testContext.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    return new Response("Private contact details", { status: 409 });
  });
  const response = await submit();
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.ok, false);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify([logs, response.body]).includes("Private contact details"), false);
  assert.equal(JSON.stringify(logs).includes(form.email), false);
  assert.equal(JSON.stringify(logs).includes(process.env.CRM_INTAKE_SECRET), false);
});

test("persistent CRM failure is reported after bounded retries", async (testContext) => {
  setup(testContext);
  let attempts = 0;
  testContext.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    return new Response("Unavailable", { status: 503 });
  });
  const response = await submit();
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.submissionId, form.submission_id);
  assert.equal(attempts, 3);
});

test("an HTML deployment-protection page cannot masquerade as a CRM receipt", async (testContext) => {
  setup(testContext);
  testContext.mock.method(globalThis, "fetch", async () => new Response("<html>Sign in</html>"));
  const response = await submit();
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.ok, false);
});

test("invalid, oversized and cross-origin requests cannot reach either upstream", async (testContext) => {
  const { calls } = setup(testContext);
  for (const body of ["{", null, [], {}, { ...form, name: "" }, { ...form, email: {} },
    { ...form, submission_id: "bad" }, { ...form, company: "x".repeat(201) }]) {
    assert.equal((await submit(body)).statusCode, 400);
  }
  assert.equal((await submit({ ...form, extra: "x".repeat(65536) })).statusCode, 413);
  assert.equal((await submit(form, { method: "GET" })).statusCode, 405);
  assert.equal((await submit(form, { headers: { "content-type": "text/plain" } })).statusCode, 415);
  assert.equal((await submit(form, { headers: {
    "content-type": "application/json", host: "goatara.com", origin: "https://untrusted.example",
  } })).statusCode, 403);
  assert.equal((await submit({ ...form, _honey: "spam" })).body.ok, true);
  assert.equal(calls.length, 0);
});

test("read-only relay diagnostics expose only configuration categories and a log correlation ID", async (testContext) => {
  const { calls, logs } = setup(testContext);
  const validUrl = "https://goatara-lead-tracker.vercel.app";
  const validSecret = process.env.CRM_INTAKE_SECRET;
  for (const [url, secret, category] of [
    ["", validSecret, "missing_url"],
    ["not-a-url", validSecret, "invalid_url"],
    [validUrl, "", "missing_secret"],
    [validUrl, "invalid-private-secret", "invalid_secret"],
    [validUrl, validSecret, "valid_format"],
  ]) {
    process.env.CRM_INTAKE_URL = url;
    process.env.CRM_INTAKE_SECRET = secret;
    const response = await submit(form, { method: "GET" });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers["x-goatara-crm-config"], category);
    assert.match(response.headers["x-goatara-delivery-id"], /^[a-f0-9-]{36}$/);
    assert.equal(deliveryLogs(logs).at(-1).deliveryId, response.headers["x-goatara-delivery-id"]);
    assert.equal(deliveryLogs(logs).at(-1).attempted, false);
    const serialized = JSON.stringify(response);
    for (const value of [url, secret, form.email, form.phone, form.submission_id].filter(Boolean)) {
      assert.equal(serialized.includes(value), false);
    }
  }
  assert.equal(calls.length, 0);
});

test("production hostname aliases do not reject legitimate Goatara lead requests", async (testContext) => {
  const { calls } = setup(testContext, { NODE_ENV: "production" });
  for (const [origin, host] of [
    ["https://goatara.com", "www.goatara.com"],
    ["https://www.goatara.com", "goatara.com"],
  ]) {
    const response = await submit(form, { headers: {
      "content-type": "application/json", origin, host, "sec-fetch-site": "same-site",
    } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
  }
  assert.equal(calls.length, 2);
});

test("hostname aliases do not allow untrusted or cross-site origins", async (testContext) => {
  const { calls } = setup(testContext, { NODE_ENV: "production" });
  for (const [origin, host, fetchSite] of [
    ["https://goatara.com.evil.test", "www.goatara.com", "same-site"],
    ["https://www.goatara.com.evil.test", "goatara.com", "same-site"],
    ["https://untrusted.example", "www.goatara.com", "same-site"],
    ["http://goatara.com", "www.goatara.com", "same-site"],
    ["https://goatara.com", "untrusted.example", "same-site"],
    ["https://goatara.com", "www.goatara.com", "cross-site"],
    ["null", "www.goatara.com", "same-site"],
  ]) {
    const response = await submit(form, { headers: {
      "content-type": "application/json", origin, host, "sec-fetch-site": fetchSite,
    } });
    assert.equal(response.statusCode, 403);
  }
  assert.equal(calls.length, 0);
});

test("public CRM URLs require HTTPS and secrets cannot be sent to URL credentials or redirects", async (testContext) => {
  const { calls } = setup(testContext);
  for (const url of ["http://crm.example.test", "https://user:password@crm.example.test", "not-a-url"]) {
    process.env.CRM_INTAKE_URL = url;
    assert.equal((await submit()).statusCode, 503);
  }
  assert.equal(calls.length, 0);
});

const deliveryLogs = logs => logs.filter(([message]) => message === "CRM lead delivery").map(([, details]) => details);

test("delivery diagnostics record the production endpoint, awaited attempt and final success", async (testContext) => {
  const { logs } = setup(testContext, {
    NODE_ENV: "production",
    CRM_INTAKE_URL: "https://goatara-lead-tracker.vercel.app",
  });
  const upstream = Promise.withResolvers();
  let requestOptions;
  testContext.mock.method(globalThis, "fetch", (_url, options) => {
    requestOptions = options;
    return upstream.promise;
  });
  let completed = false;
  const pending = submit().then(response => { completed = true; return response; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(deliveryLogs(logs)[0]?.event, "attempt");
  upstream.resolve(Response.json({ companyId: "private-company-id", created: true, replayed: false }, { status: 201 }));
  const response = await pending;
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-goatara-lead-relay"], "crm-v1");
  assert.equal(requestOptions.headers.Authorization, `Bearer ${process.env.CRM_INTAKE_SECRET}`);
  const entries = deliveryLogs(logs);
  assert.deepEqual(entries.map(entry => entry.event), ["attempt", "response", "complete"]);
  for (const entry of entries) {
    assert.equal(entry.hostname, "goatara-lead-tracker.vercel.app");
    assert.equal(entry.path, "/api/intake/leads");
    assert.equal(entry.attempted, true);
    assert.equal(entry.attempt, 1);
    assert.match(entry.deliveryId, /^[a-f0-9-]{36}$/);
    assert.notEqual(entry.deliveryId, form.submission_id);
  }
  assert.equal(entries[1].status, 201);
  assert.equal(entries[2].outcome, "success");
  const serialized = JSON.stringify(logs);
  for (const value of [form.email, form.phone, form.name, form.company, form.submission_id,
    process.env.CRM_INTAKE_SECRET, "private-company-id", "Authorization"]) {
    assert.equal(serialized.includes(value), false);
  }
});

test("delivery diagnostics distinguish absent configuration from invalid URL and secret values", async (testContext) => {
  const { calls, logs } = setup(testContext);
  const validUrl = "https://goatara-lead-tracker.vercel.app";
  const validSecret = process.env.CRM_INTAKE_SECRET;
  for (const [url, secret, category] of [
    ["", validSecret, "missing_url"],
    ["not-a-url", validSecret, "invalid_url"],
    [validUrl + "/wrong/path", validSecret, "invalid_url"],
    [validUrl, "", "missing_secret"],
    [validUrl, "short", "invalid_secret"],
    [validUrl, validSecret + "\n", "invalid_secret"],
  ]) {
    process.env.CRM_INTAKE_URL = url;
    process.env.CRM_INTAKE_SECRET = secret;
    logs.length = 0;
    const response = await submit();
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.ok, false);
    const [entry] = deliveryLogs(logs);
    assert.equal(entry?.event, "complete");
    assert.equal(entry.attempted, false);
    assert.equal(entry.attempt, 0);
    assert.equal(entry.category, category);
    assert.equal(entry.outcome, "failure");
  }
  assert.equal(calls.length, 0);
});

test("production origins and full endpoint URLs resolve to the same single intake path", async (testContext) => {
  const { calls } = setup(testContext, { NODE_ENV: "production" });
  const origin = "https://goatara-lead-tracker.vercel.app";
  for (const suffix of ["", "/", "/api/intake/leads", "/api/intake/leads/"]) {
    process.env.CRM_INTAKE_URL = origin + suffix;
    assert.equal((await submit()).body.ok, true);
  }
  assert.ok(calls.every(call => String(call.url) === origin + "/api/intake/leads"));
});

test("delivery diagnostics classify authentication failures without retrying or logging response bodies", async (testContext) => {
  const { logs } = setup(testContext);
  let attempts = 0;
  testContext.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    return new Response(`Unauthorized ${form.email} ${process.env.CRM_INTAKE_SECRET}`, { status: 401 });
  });
  assert.equal((await submit()).body.ok, false);
  assert.equal(attempts, 1);
  const entries = deliveryLogs(logs);
  assert.equal(entries.find(entry => entry.event === "response")?.status, 401);
  assert.equal(entries.at(-1)?.category, "authentication");
  assert.equal(entries.at(-1)?.outcome, "failure");
  assert.equal(JSON.stringify(logs).includes(form.email), false);
  assert.equal(JSON.stringify(logs).includes(process.env.CRM_INTAKE_SECRET), false);
});

test("delivery diagnostics classify DNS, timeout and rate limiting while reusing the request", async (testContext) => {
  const { logs } = setup(testContext);
  const attempts = [];
  testContext.mock.method(globalThis, "fetch", async (_url, options) => {
    attempts.push(options);
    if (attempts.length === 1) throw new TypeError(`Private ${form.email}`, { cause: { code: "ENOTFOUND" } });
    if (attempts.length === 2) throw new DOMException(form.phone, "TimeoutError");
    return new Response(form.name, { status: 429 });
  });
  assert.equal((await submit()).statusCode, 429);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(attempt => attempt.headers["Idempotency-Key"] === form.submission_id));
  assert.ok(attempts.every(attempt => attempt.body === attempts[0].body));
  const entries = deliveryLogs(logs);
  assert.deepEqual(entries.filter(entry => entry.event === "attempt").map(entry => entry.attempt), [1, 2, 3]);
  assert.deepEqual(entries.filter(entry => entry.event === "response").map(entry => entry.category), ["dns", "timeout", "rate_limited"]);
  assert.equal(entries.at(-1)?.outcome, "failure");
  for (const value of [form.email, form.phone, form.name]) assert.equal(JSON.stringify(logs).includes(value), false);
});

test("already-open website forms without submission IDs still deliver with a server-generated retry key", async (testContext) => {
  const { calls } = setup(testContext);
  const { submission_id, ...legacyForm } = form;
  const response = await submit(legacyForm);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.match(calls[0].options.headers["Idempotency-Key"], /^[a-f0-9-]{36}$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), canonical);
});

test("delivery diagnostics explain request rejection and honeypot skips without logging submitted values", async (testContext) => {
  const { calls, logs } = setup(testContext);
  assert.equal((await submit({ ...form, _honey: form.email })).body.ok, true);
  assert.equal(deliveryLogs(logs).at(-1)?.category, "honeypot");
  assert.equal(deliveryLogs(logs).at(-1)?.attempted, false);
  assert.equal((await submit({ ...form, submission_id: "bad" })).statusCode, 400);
  assert.equal(deliveryLogs(logs).at(-1)?.category, "invalid_submission_id");
  const response = await submit(form, { method: "GET" });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers["x-goatara-lead-relay"], "crm-v1");
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(logs).includes(form.email), false);
});

function emailForm(testContext, emailStatus = 200) {
  const dom = new JSDOM(readFileSync(join(__dirname, "../index.html"), "utf8"), {
    url: "https://goatara.com/",
    runScripts: "outside-only",
  });
  testContext.after(() => dom.window.close());
  const { window } = dom;
  const emails = [];
  const emailRelays = [];
  const deliveries = [];
  const pending = [];
  const fallbacks = [];
  const conversions = [];
  const beacons = [];
  const browserErrors = [];
  window.addEventListener("error", event => browserErrors.push(event.message));
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLFormElement.prototype.submit = function () {
    fallbacks.push({ action: this.action, values: Object.fromEntries(new window.FormData(this)) });
  };
  window.rdt = (...details) => conversions.push(details);
  window.navigator.sendBeacon = (...details) => { beacons.push(details); return true; };
  window.fetch = (url, options) => {
    if (url === "/api/save-lead") {
      const payload = JSON.parse(options.body);
      (payload.delivery === "email" ? emailRelays : deliveries).push({ payload, options });
      const delivery = submit(payload).then(response => Response.json(response.body, { status: response.statusCode }));
      pending.push(delivery);
      return delivery;
    }
    assert.equal(url, "https://formsubmit.co/ajax/contact@goatara.com");
    emails.push({ url, options, payload: Object.fromEntries(new URLSearchParams(options.body.toString())) });
    if (emailStatus === 0) return Promise.reject(new TypeError("Simulated mobile DNS failure"));
    return Promise.resolve(Response.json({ success: emailStatus === 200 }, { status: emailStatus }));
  };
  window.eval(readFileSync(join(__dirname, "../js/main.js"), "utf8"));
  const leadForm = window.document.querySelector("#qualifyForm");
  for (const [field, value] of Object.entries(form)) {
    const control = leadForm.elements.namedItem(field);
    if (control) control.value = value;
  }
  return {
    window, leadForm, emails, emailRelays, deliveries, fallbacks, conversions, beacons, browserErrors,
    async send() {
      const button = leadForm.querySelector('button[type="submit"]');
      let complete;
      const finished = new Promise(resolve => { complete = resolve; });
      const observer = new window.MutationObserver(() => {
        if (!button.disabled) { observer.disconnect(); complete(); }
      });
      observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });
      leadForm.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
      if (!button.disabled) { observer.disconnect(); complete(); }
      await finished;
      await Promise.all(pending);
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test("the real form preserves email and success when CRM succeeds, is unconfigured or fails", async (testContext) => {
  for (const scenario of ["success", "missing_configuration", "authentication_failure", "network_failure"]) {
    await testContext.test(scenario, async scenarioContext => {
      setup(scenarioContext, scenario === "missing_configuration" ? { CRM_INTAKE_SECRET: "" } : {});
      if (scenario === "authentication_failure") {
        scenarioContext.mock.method(globalThis, "fetch", async () => new Response("Unauthorized", { status: 401 }));
      }
      if (scenario === "network_failure") {
        scenarioContext.mock.method(globalThis, "fetch", async () => { throw new TypeError("Test connection failure"); });
      }
      const browser = emailForm(scenarioContext);
      assert.equal(browser.leadForm.checkValidity(), true);
      await browser.send();
      assert.equal(browser.emails.length, 1);
      assert.equal(browser.fallbacks.length, 0);
      for (const field of CRM_FIELDS_FOR_TEST()) assert.equal(browser.emails[0].payload[field], form[field]);
      assert.equal(browser.emails[0].payload._cc, "bfratello@goatara.com,hmdodds@goatara.com,emdodds@goatara.com");
      assert.equal(browser.emails[0].payload._template, "table");
      assert.equal(browser.emails[0].payload._subject, "New partnership application \u2014 Goatara");
      assert.equal(browser.leadForm.hidden, true);
      assert.equal(browser.window.document.querySelector("#qualifySuccess").classList.contains("show"), true);
      assert.equal(browser.leadForm.querySelector('button[type="submit"]').disabled, false);
      assert.equal(browser.conversions.filter(entry => entry[0] === "track" && entry[1] === "Lead").length, 1);
      assert.equal(browser.beacons.length, 1);
      assert.equal(browser.beacons[0][0], "/api/reddit-capi");
      assert.equal(browser.deliveries.length, 1);
      assert.equal(browser.deliveries[0].options.keepalive, true);
      assert.equal("Authorization" in browser.deliveries[0].options.headers, false);
      assert.equal("submission_id" in browser.emails[0].payload, false);
      assert.notEqual(browser.deliveries[0].payload.submission_id, browser.conversions[0][2].conversionId);
      assert.deepEqual(browser.browserErrors, []);
    });
  }
});

function CRM_FIELDS_FOR_TEST() {
  return Object.keys(form).filter(field => field !== "submission_id");
}

test("blocked mobile AJAX falls back to the original native FormSubmit request with calendar return", async (testContext) => {
  const { calls } = setup(testContext);
  const browser = emailForm(testContext, 0);
  browser.window.document.querySelector(".nav__book").click();
  await browser.send();
  assert.equal(browser.emails.length, 1);
  assert.equal(browser.fallbacks.length, 1);
  assert.equal(browser.fallbacks[0].action, "https://formsubmit.co/contact@goatara.com");
  assert.equal(browser.fallbacks[0].values._next, "https://calendar.app.google/UX3xX5r2br14W3nP7");
  assert.equal(browser.fallbacks[0].values._cc, "bfratello@goatara.com,hmdodds@goatara.com,emdodds@goatara.com");
  for (const field of CRM_FIELDS_FOR_TEST()) assert.equal(browser.fallbacks[0].values[field], form[field]);
  assert.equal(browser.emailRelays.length, 0);
  assert.equal(browser.conversions.length, 0);
  assert.equal(browser.leadForm.hidden, false);
  assert.equal(browser.deliveries.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(browser.emails[0].options.headers["Content-Type"], undefined);
  assert.ok(browser.emails[0].options.body instanceof browser.window.URLSearchParams);
  assert.deepEqual(browser.browserErrors, []);
});

test("failed native navigation retains answers for a retry without a duplicate CRM submission ID", async (testContext) => {
  setup(testContext);
  const browser = emailForm(testContext, 0);
  const nativeSubmit = browser.window.HTMLFormElement.prototype.submit;
  browser.window.HTMLFormElement.prototype.submit = () => { throw new Error("Test navigation unavailable"); };
  await browser.send();
  assert.equal(browser.leadForm.hidden, false);
  assert.equal(browser.leadForm.querySelector(".form-error").hidden, false);
  assert.equal(browser.window.document.querySelector("#qualifySuccess").classList.contains("show"), false);
  assert.equal(browser.leadForm.elements.namedItem("email").value, form.email);
  assert.equal(browser.fallbacks.length, 0);
  assert.equal(browser.conversions.length, 0);
  browser.window.HTMLFormElement.prototype.submit = nativeSubmit;
  await browser.send();
  assert.equal(browser.fallbacks.length, 1);
  assert.equal(browser.emailRelays.length, 0);
  assert.equal(browser.conversions.length, 0);
  assert.equal(browser.deliveries[0].payload.submission_id, browser.deliveries[1].payload.submission_id);
});

test("the real form still rejects invalid required fields before email or CRM delivery", async (testContext) => {
  const { calls } = setup(testContext);
  const browser = emailForm(testContext);
  browser.leadForm.elements.namedItem("email").value = "";
  await browser.send();
  assert.equal(browser.emails.length, 0);
  assert.equal(browser.deliveries.length, 0);
  assert.equal(browser.fallbacks.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(browser.window.document.querySelector("#qualifySuccess").classList.contains("show"), false);
});

test("static Vercel configuration includes the Node relay and its validation build", () => {
  const config = JSON.parse(readFileSync(join(__dirname, "../vercel.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, ".");
  assert.equal(config.buildCommand, "npm run build");
  assert.equal(config.functions["api/save-lead.js"].maxDuration, 30);
  assert.equal(packageJson.scripts.build, "npm run check");
  assert.ok(packageJson.scripts.check.includes("api/save-lead.js"));
  assert.ok(packageJson.scripts.check.includes("js/main.js"));
  for (const page of ["index", "contact", "services", "how-it-works", "faq"]) {
    const dom = new JSDOM(readFileSync(join(__dirname, `../${page}.html`), "utf8"));
    assert.equal(dom.window.document.querySelectorAll('script[src="js/main.js"]').length, 1);
    const bookings = [...dom.window.document.querySelectorAll('a[href*="calendar.app.google"]')];
    assert.ok(bookings.length > 0);
    assert.ok(bookings.every(link => link.href === "https://calendar.app.google/UX3xX5r2br14W3nP7"));
    assert.equal(dom.window.document.querySelector(".nav__book")?.textContent, "Book a Call");
    if (page === "contact") assert.ok(dom.window.document.querySelector("#contactForm [data-book-call]"));
    dom.window.close();
  }
});