# Goatara website lead integration

The local website project is `northbound` (workspace directory/package name: `northbound-commerce`). Its Vercel project is **`goatara`**, serving **https://goatara.com**. The separate CRM Vercel project is **`goatara-lead-tracker`**, serving **https://goatara-lead-tracker.vercel.app**. Do not configure the website integration variables in the CRM project or vice versa.

## Production diagnosis: September 16, 2026

At inspection, website `main` and its local `origin/main` reference pointed to `eb8c680`. Its committed `api/save-lead.js` contained only Google Sheets delivery, no CRM fetch or CRM environment-variable lookup. That handler returned HTTP 200 even when Sheets was unconfigured or failed. A 200 response was therefore not evidence of CRM delivery.

The public `https://goatara.com/js/main.js` still contained `saveLeadToSheets` and no `submission_id`. The previously implemented CRM relay and browser changes were only working-tree edits; `vercel.json`, tests and this guide were untracked. This stale deployed/committed code explains why the website could return 200 without any CRM intake POST.

The relay and browser files are tracked paths, but Git-triggered deployments use committed content, not unsaved Git worktree changes or untracked files. No repository ignore rule excludes the relay, and there is no `.vercelignore`. The updated `vercel.json` explicitly uses the Other/static framework, `npm run build`, output directory `.`, and a 30-second function budget. `api/save-lead.js` stays in the project-root `api` directory for Vercel's Node function discovery; it is not a browser script or an output file under `dist`.

The Vercel CLI was not authenticated during diagnosis, so live project settings, deployed commit metadata and Production environment values could not be inspected. The current local CRM branch already contains the earlier JSONB/idempotency/concurrency fixes. This website fix does not modify the CRM and has not been committed, pushed or deployed by the assistant.

## Delivery flow

Requests may originate from either `https://goatara.com` or `https://www.goatara.com`. The relay permits only those two exact HTTPS hostname aliases when the origin and destination differ; unrelated hosts, lookalike domains and cross-site requests remain blocked. This avoids an origin rejection when an apex-host request is redirected to `www`.

All five website pages (`index.html`, `contact.html`, `services.html`, `how-it-works.html`, `faq.html`) load the same `js/main.js`. It creates the single `#qualifyForm` partnership modal and binds `wireEmailForm`; booking links open that same form. The form still submits directly to FormSubmit:

- Recipient: `contact@goatara.com`.
- CC: `bfratello@goatara.com,hmdodds@goatara.com,emdodds@goatara.com`.
- Subject, table template, honeypot, HTML validation and the primary FormSubmit AJAX request are retained.
- If the browser cannot reach FormSubmit, a same-origin server-side email fallback replaces the old native navigation to the unreachable provider. Both attempts require a positive acknowledgement. The existing success state and one conversion follow acknowledged email delivery; a CRM failure cannot prevent them.

For each valid submission, the browser also starts an independent, same-origin request:

```text
Partnership form
  -> FormSubmit email (existing AJAX; website server fallback on failure)
  -> POST /api/save-lead (website Vercel function)
       -> POST /api/intake/leads (CRM, server-authenticated)
       -> Google Sheets (existing optional copy)
```

Starting the relay independently also covers email-provider failures. `keepalive` allows delivery to continue during navigation. A browser transport failure gets one retry with the identical request and submission ID, within a 20-second client deadline. Retrying unchanged form answers after an email failure reuses the submission ID; changing answers or starting a new successful submission creates a new one. No lead payload is persisted in browser storage.

The relay validates JSON, field types/lengths, required fields, the submission ID, same-origin browser requests and the existing honeypot. It forwards only the eleven lead fields to the CRM. Existing attribution/conversion code is unchanged; no attribution, source, click ID, page URL or referrer fields are added to the CRM.

The function awaits `Promise.all` for CRM and optional Sheets delivery before responding. The exact production destination is **`https://goatara-lead-tracker.vercel.app/api/intake/leads`**. It constructs this with `new URL('/api/intake/leads', configuredUrl)`, not string concatenation. Origins or full intake URLs, with or without a trailing slash, resolve to that same single path. Other paths, URL credentials, query strings, fragments and non-HTTPS public URLs are rejected before fetch.

Only the server adds `Authorization: Bearer <CRM_INTAKE_SECRET>` and `Idempotency-Key: <submission_id>`. The optional Vercel bypass is also a server-only header. Missing or invalid CRM configuration returns `503` with `ok: false` and an explicit diagnostic; it cannot silently become a successful CRM acknowledgement. The separate browser email request still controls the visible success state.

## Booking and mobile forms

Every **Book a Call** link and the contact page's **Send & Request My Call** button first opens the existing lead form in booking mode. After email acknowledgement and the independent CRM/Sheets relay attempt settles, the browser navigates in the **same tab** to:

```text
https://calendar.app.google/UX3xX5r2br14W3nP7
```

There is no asynchronous popup that Safari can block. The success state includes a direct **Choose a Call Time** link as a navigation fallback. A completed enquiry can also use a booking button afterward without resending its email or creating another submission. **Check If You're a Fit** remains an enquiry-only action and keeps the existing thank-you state rather than navigating to the calendar. The header's Book a Call button is visible on desktop and mobile, alongside the existing phone and menu controls.

The old error path navigated the browser to FormSubmit with a native POST when its AJAX request failed. On a device unable to resolve or reach that provider, this led to Safari's server-not-found page. The updated form keeps the original primary email AJAX attempt, with an eight-second deadline, then sends a validated same-origin `POST /api/save-lead` with `delivery: "email"` if necessary. This mode sends **only email**, not another CRM or Sheets delivery. The server calls the same FormSubmit recipient with all eleven fields, fixed subject/template/CCs, and a ten-second timeout. Browser fallback requests have a fifteen-second deadline.

The email-mode response includes `delivery: "email"`; it is an email acknowledgement, not a CRM acknowledgement. Server logs use `Lead email delivery` with a random correlation ID and status/category, never form values or credentials. Client-supplied recipient, CC, subject, redirect or tracking fields cannot override the server's email payload. The same body-size, origin, honeypot and field checks apply to both modes. No new environment variable or email provider is required. Apply the existing public-route firewall/rate-limit policy to all `POST /api/save-lead` requests.

If both email attempts fail, an inline error keeps the answers in the form, enables retry, and does not show success or open the calendar. CRM delivery remains independent. There is no automatic retry of the server email fallback: as with the previous native fallback, an email accepted before a lost acknowledgement can still produce a duplicate notification. This flow does not add an email queue or change the CRM's duplicate prevention.

Automated tests simulate unreachable FormSubmit in mobile WebKit and intercept every provider and calendar request. A real iPhone/network-specific DNS fault and live inbox receipt must still be checked manually after deployment; tests do not send real email or book appointments.

## Field mapping

| Existing form question | Website field | CRM field |
| --- | --- | --- |
| Where are you at right now? | `current_stage` | `currentSituation` |
| Link to your store, listings, or products | `store_url` | `storeUrl` |
| What do you sell? | `product_category` | `products` |
| Roughly how many products? | `sku_count` | `productCount` |
| Current monthly revenue across all channels | `revenue_range` | `monthlyRevenue` |
| How would orders get shipped? | `fulfillment_method` | `shippingMethod` |
| When would you want to start? | `launch_timeline` | `desiredStart` |
| Full name | `name` | `fullName` |
| Business name | `company` | `businessName` |
| Email | `email` | `email` |
| Phone | `phone` | `phone` |

Business name, store URL and product count remain optional. Blank optional values become `null`; without a business name the CRM uses `Unconfirmed - Full Name`. Store URLs support bare domains but must be valid HTTP(S) URLs. CRM field limits are enforced without silently truncating lead details; existing Sheets sanitization remains separate.

## Vercel environment variables

Set these in **Vercel project `goatara`**, using the correct Production or Preview environment, then redeploy:

| Variable | Value |
| --- | --- |
| `CRM_INTAKE_URL` | `https://goatara-lead-tracker.vercel.app`. No query parameters, credentials or redirecting login URL. A full URL ending in `/api/intake/leads` also works without duplicating the path. |
| `CRM_INTAKE_SECRET` | The exact value of `goatara-lead-tracker`'s `LEAD_WEBHOOK_SECRET`, at least 32 cryptographically random characters. No surrounding quotes, spaces or newlines. The secret is not silently trimmed. |
| `CRM_VERCEL_PROTECTION_BYPASS` | Only when the CRM is behind Vercel Deployment Protection: its **Protection Bypass for Automation** secret. Passed only as a server-to-server header. |
| `GOATARA_SHEETS_URL` | Keep the existing value if Sheets is enabled. Not required for CRM delivery. |
| `GOATARA_SHEETS_SECRET` | Keep the existing value if Sheets is enabled. Not required for CRM delivery. |

No new FormSubmit configuration or credentials are needed. Leave the existing email and conversion provider settings in place.

In **Vercel project `goatara-lead-tracker`**, set or verify `LEAD_WEBHOOK_SECRET` matches `goatara`'s `CRM_INTAKE_SECRET`. Keep the existing server-only `SUPABASE_DB_URL` and production settings: `APP_ORIGIN=https://goatara-lead-tracker.vercel.app`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `DEMO_MODE=false`. Do not change the existing authentication mode for this integration. `SUPABASE_DB_URL` must never be added to `goatara`.

Never put these secrets in HTML, browser JavaScript, `VITE_*` variables or a public client bundle. The website needs no Supabase database password, service-role key or direct database connection.

The CRM's current default is direct workspace access (`AUTH_DISABLED=true`); anyone who can reach an unprotected deployment can read and edit it. Keep external deployment protection enabled, or retain application authentication where already configured. The intake still requires its bearer secret, even when application authentication is disabled.

The CRM's previous example environment file contained live-looking database and webhook credentials. Those example values have been removed, but **rotate the database password and webhook secret if they were used**. Removing them from a file does not remove them from Git history. Update the CRM database URL and both sides of the shared intake secret when rotating.

## Deploy and test

1. In `goatara-lead-tracker`, verify the Production `LEAD_WEBHOOK_SECRET` and `SUPABASE_DB_URL`, then deploy the current committed CRM code to Production. Its existing Supabase schema is sufficient; this fix requires no new migration. Keep access protection enabled and configure an automation bypass if needed.
2. In `goatara`, set Production `CRM_INTAKE_URL=https://goatara-lead-tracker.vercel.app`, `CRM_INTAKE_SECRET` and the optional bypass. Preserve all existing email, Sheets and conversion settings. Environment changes apply to a new deployment, not retroactively to an old one. Use a separate test CRM/database for Preview.
3. Run `npm ci`, `npm test` and `npm run build` locally. Commit and push all website integration files listed below; merely redeploying the existing `eb8c680` commit cannot include them. Do not commit real `.env` files.
4. Deploy that new commit in **`goatara`**, not a similarly named project. Confirm the connected Git repository/Production branch, commit SHA, and Root Directory containing this `package.json`, `index.html`, `js` and `api`. The repository config selects Other/static, `npm run build`, output `.`, and the Node 24 function. Confirm build logs run the syntax checks and the deployment contains the `api/save-lead` function. Promote/alias the new deployment to `goatara.com` if it is not the Production deployment.
5. Before sending any lead, GET `https://www.goatara.com/api/save-lead` in an HTTP client or DevTools. Expect `405`, `Allow: POST` and **`X-Goatara-Lead-Relay: crm-v1`**. The **`X-Goatara-CRM-Config`** header reports `missing_url`, `invalid_url`, `missing_secret`, `invalid_secret`, `invalid_protection_bypass` or `valid_format`, never the configuration values. `valid_format` does not prove secret equality or CRM connectivity. GET performs no CRM, Sheets or email request. Load `https://www.goatara.com/js/main.js` with cache disabled and confirm `submission_id` and `saveLead`, not the old `saveLeadToSheets`.
6. Configure Vercel Firewall rate limiting/bot rules for `POST /api/save-lead`. Origin checks and a honeypot are useful filters, not a distributed abuse limit. The CRM independently limits intake to 60 requests per minute per IP.
7. Perform a coordinated **manual** production submission with a unique test email and distinguishable values in all eleven fields. This sends a real email; automated tests must not perform it. Confirm the original success state and delivery to the recipient and CC inboxes, including spam folders.
8. In browser DevTools, confirm the FormSubmit email request and the CRM-mode `/api/save-lead` request returning `200` with `ok: true` and the relay-version header. If FormSubmit is unreachable from the device, a second request with `delivery: "email"` should acknowledge the server email fallback. The browser must not call the CRM origin or contain any bearer/bypass secret. Verify one existing Lead conversion for acknowledged email delivery, without adding tracking. Booking actions must then open the exact calendar URL above in the same tab; enquiry-only actions remain on the thank-you state.
9. In **`goatara`** function logs, find `CRM lead delivery` with `event: attempt`, `attempted: true`, hostname `goatara-lead-tracker.vercel.app`, path `/api/intake/leads`, followed by a `200`/`201` response and `event: complete, outcome: success`. In **`goatara-lead-tracker`** logs, confirm the incoming POST. Open the company and verify all qualification fields, contact name/email/phone, complete submission history and the optional Sheets copy.
10. Replay **only the `/api/save-lead` request** with its original body and `submission_id` using DevTools or a local API client. CRM company/history counts must not increase; never replay FormSubmit just to test CRM. Sheets is not idempotent and may receive another copy. A new form submission with the same email should create a new history entry on the same company without overwriting populated fields.
11. Test optional fields and failure scenarios in isolated tests or Preview: missing/incorrect CRM configuration must not block email/success/conversion/Sheets; failed browser email AJAX must use the server fallback without navigating to FormSubmit. If the fallback fails too, the inline retry must retain answers and the CRM idempotency key. On mobile, verify the homepage header Book a Call button is visible and both it and the contact-page call request reach the calendar after submission. Keep email, advertising and calendar endpoints intercepted during automated tests, and restore any Preview configuration changes afterward.

From the website repository root, the explicit Git commands for publishing the pending integration are:

```powershell
git add .env.example .gitignore api/save-lead.js js/main.js package.json package-lock.json vercel.json tests/lead.test.js README.md
git commit -m "Connect website leads to CRM with safe delivery diagnostics"
git push origin main
```

Review these changes before committing. These commands are instructions for the operator; the assistant did not run them. If `goatara` uses a different Production branch, merge the commit into that branch before deploying.

Live inbox delivery, Supabase connectivity, the deployed shared secret and Vercel protection bypass must be verified after deployment. Local tests intercept FormSubmit and existing advertising requests, so they do not prove receipt in real inboxes.

## Idempotency and recovery

`submission_id` is a random delivery identifier, generated independently of existing conversion IDs. The server forwards it as `Idempotency-Key`. It is not lead-source or advertising attribution. CRM matching remains based on case-insensitive email or normalized store URL, not business name. Shared marketplace URLs include the seller/listing path so unrelated sellers are not merged.

Already-open pages running the previous script do not send `submission_id`. The relay accepts otherwise valid legacy submissions and generates a server-side UUID once per invocation, reused across its upstream retry attempts. Separate legacy requests cannot share an ID that was never supplied, so only refreshed pages provide browser retry idempotency. Supplied malformed IDs are still rejected.

An identical key and normalized payload replay returns success without adding history. The same key with changed details returns `409`. A new key adds history even when it matches an existing company. Ambiguous company matches or an email matching a different existing store also return `409` for staff review.

The server awaits CRM and Sheets independently before ending the function. CRM network errors, timeouts, `429` and `5xx` responses get at most three attempts, each with a five-second timeout and the same idempotency key. Other rejections are not retried. Redirects and non-JSON success pages are not accepted as CRM acknowledgements. New Postgres submissions are stored as JSONB objects; older JSON-string records remain readable and replayable. Transaction-scoped locking prevents concurrent intake from creating duplicate companies.

**Email success is not a CRM delivery guarantee.** The form keeps its existing email-driven success state even when the relay fails. There is no durable queue or unlimited background retry. After bounded retries, recover failed intake from the email notification and the website's Vercel function logs. Do not resend the email just to repair CRM delivery.

Monitor **`goatara`** function logs for `CRM lead delivery`. Each log has a random server-generated `deliveryId`, `attempted`, destination `hostname` and fixed endpoint `path`, `attempt`, `event`, HTTP `status` or safe `category`, and a final `outcome` on `complete`. The ID correlates logs within one website invocation; it is not the caller's submission ID. Invalid configuration does not log raw URLs, and exceptions do not log raw error messages. Authorization headers, secrets, database URLs, upstream bodies, contact data and form payloads are never logged.

Every response also supplies `X-Goatara-Delivery-Id`; use that value to find the matching website log. CRM `/api/workspace` and `/api/auth/me` GET logs only show page loading, not website delivery. A bare `{"ok":true}` relay response is the honeypot skip; acknowledged CRM deliveries include `submissionId`, while email-only acknowledgements also include `delivery: "email"`. A manually inserted CRM record or a zero New leads count does not establish whether a particular website request succeeded. Diagnose that request using its website response and matching delivery log.

| Diagnostic | Meaning and next step |
| --- | --- |
| No relay-version header; no `CRM lead delivery` events | Check `goatara`'s deployed commit, branch, root directory and alias. The old handler never called CRM. |
| `attempted: false`, `missing_url` or `missing_secret` | Set the missing variable in `goatara` Production and redeploy. |
| `attempted: false`, `invalid_url`, `invalid_secret` or `invalid_protection_bypass` | Correct the malformed configuration. URL examples and exact secret requirements are above. |
| `attempted: false`, `honeypot`, `invalid_fields`, `invalid_submission_id`, `origin` or another request category | The request was filtered before delivery; review its shape locally without logging lead data. Honeypot requests retain a quiet 200 response. |
| `attempted: true`, `dns`, `tls`, `timeout` or `network` | Fetch was invoked but may not have reached CRM. Check the configured host, DNS/TLS and service availability. |
| `401`/`403`, `authentication` | Check shared-secret equality and Vercel deployment protection/bypass. Protection can deny the request before CRM function logs appear. |
| `429`, `rate_limited`, or `5xx`, `upstream_5xx` | Bounded retries reuse the payload/key. Review rate limits or CRM/Supabase availability. |
| `invalid_receipt` | An HTTP success response was not the expected CRM JSON acknowledgement, for example an HTML protection/login page. It is not counted as delivery success. |
| `400`, `validation`, or `409`, `conflict` | Review CRM validation/matching; these responses are not retried. |
| `event: complete`, `outcome: success` | A valid CRM acknowledgement was received. Verify the company/history in CRM for the manual production check. |

Resolve validation/matching conflicts manually; fix configuration or protection before replaying. Prefer the identical original payload and ID when retrying an uncertain delivery, since the CRM may have committed before the response was lost.

## Local checks

Requires Node.js 24. `jsdom` and `@playwright/test` are development-only test dependencies. No production package dependency was added:

```powershell
npm ci
npm run check
npm test
npm run build
```

Run the isolated desktop Chromium and mobile WebKit workflows with:

```powershell
npx playwright install chromium webkit
npm run test:browser -- --quiet
```

The build is a syntax-validation gate for this static site and its serverless functions; Vercel performs function packaging. Tests stub CRM, Sheets, FormSubmit, conversions and calendar navigation, and must never send production leads or real emails. The suites cover all eleven fields, configuration errors, exact authentication/endpoint construction, awaited completion, safe logs, retries, legacy pages, validation, server email fallback, booking sequencing, answer retention and mobile header layout. Local tests do not prove deployed environment values or actual inbox receipt.

Run a full local serverless deployment with the Vercel CLI (`npx vercel dev`) and server-only local variables pointing to a test CRM. Plain static hosting cannot execute `/api/save-lead`. Never put Production database credentials in the website project.