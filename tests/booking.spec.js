const { test: base, expect } = require("@playwright/test");
const { createServer } = require("node:http");
const { readFile } = require("node:fs/promises");
const { once } = require("node:events");
const { resolve, extname, sep } = require("node:path");
const handler = require("../api/save-lead.js");

const calendarUrl = "https://calendar.app.google/UX3xX5r2br14W3nP7";
const emailUrl = "https://formsubmit.co/ajax/contact@goatara.com";
const values = {
  current_stage: "I sell on Amazon or another marketplace",
  store_url: "https://booking.example.test",
  product_category: "Home goods",
  sku_count: "12",
  revenue_range: "Under $5,000",
  fulfillment_method: "3PL / warehouse",
  launch_timeline: "Within 1 month",
  name: "Booking Test",
  company: "Booking Test Company",
  email: "booking@example.test",
  phone: "+1 555 010 0999",
};

const test = base.extend({
  site: async ({}, use) => {
    const root = resolve(__dirname, "..");
    const originalFetch = globalThis.fetch;
    const originalEnvironment = { ...process.env };
    const site = {
      crmCalls: [],
      emailCalls: [],
      directEmails: [],
      conversions: [],
      calendarVisits: 0,
      directEmailFails: false,
      serverEmailSucceeds: true,
      crmStatus: 201,
      holdCrm: false,
      crmFinished: false,
      nativeEmailNavigations: 0,
    };
    const crmGate = Promise.withResolvers();
    site.releaseCrm = crmGate.resolve;
    Object.assign(process.env, {
      NODE_ENV: "test",
      CRM_INTAKE_URL: "https://crm.example.test",
      CRM_INTAKE_SECRET: "browser-test-only-secret-at-least-32-characters",
      CRM_VERCEL_PROTECTION_BYPASS: "",
      GOATARA_SHEETS_URL: "",
      GOATARA_SHEETS_SECRET: "",
    });
    globalThis.fetch = async (url, options) => {
      if (String(url) === "https://crm.example.test/api/intake/leads") {
        site.crmCalls.push({ body: JSON.parse(options.body), headers: options.headers });
        if (site.holdCrm) await crmGate.promise;
        site.crmFinished = true;
        if (site.crmStatus !== 201) return new Response("Test rejection", { status: site.crmStatus });
        return Response.json({ companyId: "test-company", created: true, replayed: false }, { status: 201 });
      }
      if (String(url) === emailUrl) {
        site.emailCalls.push(JSON.parse(options.body));
        return Response.json({ success: site.serverEmailSucceeds ? "true" : "false" });
      }
      throw new Error("Unexpected external request in isolated browser test");
    };
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      try {
        if (pathname === "/api/save-lead") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          request.body = Buffer.concat(chunks).toString("utf8");
          response.status = (code) => {
            response.statusCode = code;
            return response;
          };
          response.json = (body) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(body));
            return response;
          };
          await handler(request, response);
          return;
        }
        if (request.method !== "GET") {
          response.writeHead(405).end();
          return;
        }
        const file = resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
        if (!file.startsWith(root + sep)) {
          response.writeHead(403).end();
          return;
        }
        const mime = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        response.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
        response.end(await readFile(file));
      } catch {
        response.writeHead(500).end("Local test server error");
      }
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    site.origin = `http://127.0.0.1:${server.address().port}`;
    try {
      await use(site);
    } finally {
      crmGate.resolve();
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
      Object.assign(process.env, originalEnvironment);
    }
  },
});

async function fillForm(page) {
  const form = page.locator("#qualifyForm");
  for (const [name, value] of Object.entries(values)) {
    const field = form.locator(`[name="${name}"]`);
    if (["current_stage", "revenue_range", "fulfillment_method", "launch_timeline"].includes(name)) {
      await field.selectOption({ label: value });
    } else await field.fill(value);
  }
}

test.describe("booking", () => {
  test.beforeEach(async ({ page, site }) => {
    await page.addInitScript(() => {
      window.rdt = () => {};
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === site.origin) {
        if (url.pathname === "/api/reddit-capi") {
          site.conversions.push(request.postDataJSON());
          return route.fulfill({ json: { ok: true } });
        }
        return route.continue();
      }
      if (url.hostname === "formsubmit.co") {
        if (request.isNavigationRequest()) site.nativeEmailNavigations += 1;
        if (request.method() === "OPTIONS")
          return route.fulfill({
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "content-type",
              "Access-Control-Allow-Methods": "POST",
            },
          });
        site.directEmails.push(request.postDataJSON());
        if (site.directEmailFails) return route.abort("failed");
        return route.fulfill({ json: { success: "true" }, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      if (request.url() === calendarUrl) {
        site.calendarVisits += 1;
        expect(site.crmFinished).toBe(true);
        return route.fulfill({ contentType: "text/html", body: "<h1>Choose an appointment</h1>" });
      }
      return route.abort();
    });
  });

  for (const action of [
    { name: "homepage Book a Call", path: "/", selector: ".nav__book" },
    { name: "contact call request", path: "/contact.html", selector: "#contactForm [data-book-call]" },
    {
      name: "contact booking link",
      path: "/contact.html",
      selector: '.contact-method[href*="calendar.app.google"]',
    },
  ]) {
    test(`${action.name} submits before opening the requested calendar`, async ({ page, site }, testInfo) => {
      site.directEmailFails = testInfo.project.name === "mobile Safari";
      site.holdCrm = true;
      await page.goto(site.origin + action.path);
      await page.locator(action.selector).click();
      await expect(page.locator('#qualifyForm button[type="submit"]')).toHaveText(
        "Submit & Choose a Call Time",
      );
      await fillForm(page);
      await page.screenshot({ path: testInfo.outputPath("booking-form.png") });
      await page.locator('#qualifyForm button[type="submit"]').click();
      await expect(page.locator("#qualifySuccess.show")).toBeVisible();
      await expect(page).toHaveURL(site.origin + action.path);
      expect(site.calendarVisits).toBe(0);
      site.releaseCrm();
      await expect(page).toHaveURL(calendarUrl);
      expect(site.crmCalls).toHaveLength(1);
      expect(site.directEmails).toHaveLength(1);
      expect(site.emailCalls).toHaveLength(site.directEmailFails ? 1 : 0);
      const deliveredEmail = site.directEmailFails ? site.emailCalls[0] : site.directEmails[0];
      for (const [field, value] of Object.entries(values)) expect(deliveredEmail[field]).toBe(value);
      expect(deliveredEmail._cc).toBe("bfratello@goatara.com,hmdodds@goatara.com,emdodds@goatara.com");
      expect(site.crmCalls[0].body.fullName).toBe(values.name);
      expect(site.crmCalls[0].body.products).toBe(values.product_category);
      expect(site.conversions).toHaveLength(1);
      expect(site.nativeEmailNavigations).toBe(0);
      expect(page.context().pages()).toHaveLength(1);
    });
  }

  test("enquiry-only submission stays on the thank-you state and can book afterward", async ({
    page,
    site,
  }) => {
    site.directEmailFails = true;
    await page.goto(site.origin + "/");
    await page.locator(".hero [data-open-qualify]").click();
    await fillForm(page);
    await page.locator('#qualifyForm button[type="submit"]').click();
    await expect(page.locator("#qualifySuccess.show")).toBeVisible();
    await expect(page.locator("[data-calendar-direct]")).toBeHidden();
    await expect(page).toHaveURL(site.origin + "/");
    await page.locator(".modal__close").click();
    await page.locator(".nav__book").click();
    await expect(page).toHaveURL(calendarUrl);
    expect(site.crmCalls).toHaveLength(1);
    expect(site.emailCalls).toHaveLength(1);
    expect(site.conversions).toHaveLength(1);
  });

  test("email failure keeps the form and its answers for a safe retry", async ({ page, site }) => {
    site.directEmailFails = true;
    site.serverEmailSucceeds = false;
    await page.goto(site.origin + "/contact.html");
    await page.locator("#contactForm [data-book-call]").click();
    await fillForm(page);
    await page.locator('#qualifyForm button[type="submit"]').click();
    await expect(page.locator(".form-error")).toBeVisible();
    await expect(page.locator("#q_email")).toHaveValue(values.email);
    await expect(page).toHaveURL(site.origin + "/contact.html");
    expect(site.calendarVisits).toBe(0);
    expect(site.nativeEmailNavigations).toBe(0);
    expect(site.conversions).toHaveLength(0);
    site.serverEmailSucceeds = true;
    await page.locator('#qualifyForm button[type="submit"]').click();
    await expect(page).toHaveURL(calendarUrl);
    expect(site.crmCalls).toHaveLength(2);
    expect(site.crmCalls[0].headers["Idempotency-Key"]).toBe(site.crmCalls[1].headers["Idempotency-Key"]);
    expect(site.conversions).toHaveLength(1);
  });

  test("CRM rejection cannot block the existing email or the booking calendar", async ({ page, site }) => {
    site.crmStatus = 401;
    await page.goto(site.origin + "/");
    await page.locator(".nav__book").click();
    await fillForm(page);
    await page.locator('#qualifyForm button[type="submit"]').click();
    await expect(page).toHaveURL(calendarUrl);
    expect(site.directEmails).toHaveLength(1);
    expect(site.conversions).toHaveLength(1);
    expect(site.nativeEmailNavigations).toBe(0);
  });

  test("homepage booking button fits narrow viewports and preserves validation", async ({
    page,
    site,
  }, testInfo) => {
    for (const width of testInfo.project.name === "mobile Safari" ? [320, 375, 390, 430] : [1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(site.origin + "/");
      const booking = page.locator(".nav__book");
      await expect(booking).toBeInViewport();
      expect(await booking.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const brandBox = await page.locator(".nav > .brand").boundingBox();
      const ctaBox = await page.locator(".nav__cta").boundingBox();
      expect(brandBox.x + brandBox.width).toBeLessThanOrEqual(ctaBox.x);
      expect(ctaBox.x + ctaBox.width).toBeLessThanOrEqual(width);
      const logo = page.locator(".nav .brand__logo");
      expect(await logo.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
      await page.locator(".site-header").screenshot({ path: testInfo.outputPath(`header-${width}.png`) });
      await booking.click();
      await page.locator('#qualifyForm button[type="submit"]').click();
      await expect(page.locator("#qualifyForm")).toBeVisible();
      expect(site.crmCalls).toHaveLength(0);
      expect(site.directEmails).toHaveLength(0);
    }
  });
});
