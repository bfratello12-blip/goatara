/* Goatara — interactions */
(function () {
  "use strict";

  /* Sticky header shadow */
  const header = document.querySelector(".site-header");
  const onScroll = () => {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 8);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* Mobile nav toggle */
  const nav = document.querySelector(".nav");
  const toggle = document.querySelector(".nav__toggle");
  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      toggle.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
    });
    nav.querySelectorAll(".nav__links a").forEach((a) =>
      a.addEventListener("click", () => {
        nav.classList.remove("open");
        toggle.classList.remove("open");
      })
    );
  }

  /* FAQ accordion */
  document.querySelectorAll(".faq-item").forEach((item) => {
    const btn = item.querySelector(".faq-q");
    const ans = item.querySelector(".faq-a");
    if (!btn || !ans) return;
    btn.addEventListener("click", () => {
      const isOpen = item.classList.contains("open");
      // Close others in same list
      const list = item.closest(".faq-list");
      if (list) {
        list.querySelectorAll(".faq-item.open").forEach((other) => {
          if (other !== item) {
            other.classList.remove("open");
            const a = other.querySelector(".faq-a");
            if (a) a.style.maxHeight = null;
            const b = other.querySelector(".faq-q");
            if (b) b.setAttribute("aria-expanded", "false");
          }
        });
      }
      item.classList.toggle("open", !isOpen);
      btn.setAttribute("aria-expanded", String(!isOpen));
      ans.style.maxHeight = !isOpen ? ans.scrollHeight + "px" : null;
    });
  });

  /* Scroll reveal */
  const reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("in"));
  }

  /* Reddit click ID — persisted first-party so conversions later in the journey stay attributed */
  const CLICK_ID_KEY = "rdt_cid";

  function getStoredClickId() {
    try {
      return localStorage.getItem(CLICK_ID_KEY) || null;
    } catch (err) {
      return null;
    }
  }

  try {
    const landingClickId = new URLSearchParams(window.location.search).get(CLICK_ID_KEY);
    if (landingClickId) localStorage.setItem(CLICK_ID_KEY, landingClickId);
  } catch (err) {
    /* storage unavailable — Reddit falls back to its own matching signals */
  }

  // First-party cookie the Reddit Pixel sets itself; never fabricated.
  function getRedditUuid() {
    const match = document.cookie.match(/(?:^|;\s*)_rdt_uuid=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function generateConversionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    // randomUUID needs a secure context; time + randomness keeps IDs unique elsewhere.
    return (
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10)
    );
  }

  /* Reddit Pixel — browser-side Lead conversion; must never block a submit or navigation.
     Returns the conversion ID so the same value can be reused for CAPI deduplication later. */
  function trackLead(conversionId) {
    const id = conversionId || generateConversionId();
    try {
      if (typeof window.rdt === "function") window.rdt("track", "Lead", { conversionId: id });
    } catch (err) {
      /* pixel blocked or unavailable — the user's action still proceeds normally */
    }
    return id;
  }

  /* Reddit CAPI — fire-and-forget relay; beacons survive the page unload on outbound clicks. */
  function sendRedditCapiLead(details) {
    const payload = {
      event: "Lead",
      conversionId: details.conversionId,
      eventAt: details.eventAt,
      eventSourceUrl: window.location.href,
    };

    const clickId = getStoredClickId();
    if (clickId) payload.clickId = clickId;
    const uuid = getRedditUuid();
    if (uuid) payload.uuid = uuid;

    const screen = window.screen;
    if (screen && Number.isFinite(screen.width) && Number.isFinite(screen.height) && screen.width > 0 && screen.height > 0) {
      payload.screenWidth = screen.width;
      payload.screenHeight = screen.height;
    }

    if (details.email) payload.email = details.email;
    if (details.phone) payload.phone = details.phone;

    const body = JSON.stringify(payload);
    try {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon && navigator.sendBeacon("/api/reddit-capi", blob)) return;
      fetch("/api/reddit-capi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
      }).catch(() => {});
    } catch (err) {
      /* tracking is best-effort and must never surface to the user */
    }
  }

  /* One conversion ID per lead action, shared by the Pixel and CAPI so Reddit can dedupe. */
  function recordLead(matchKeys) {
    const conversionId = trackLead();
    sendRedditCapiLead(Object.assign({ conversionId: conversionId, eventAt: Date.now() }, matchKeys));
    return conversionId;
  }

  /* UTM persistence — read straight from the current URL's query string. */
  function getUtmParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get("utm_source") || "",
      utm_medium: params.get("utm_medium") || "",
      utm_campaign: params.get("utm_campaign") || "",
      utm_content: params.get("utm_content") || "",
      utm_term: params.get("utm_term") || "",
    };
  }

  /* Background sync to Google Sheets via our own serverless endpoint. Fire-and-forget: a
     failure here must never affect the FormSubmit email flow or the on-page success state. */
  function saveLeadToSheets(formValues) {
    const payload = Object.assign(
      {
        current_stage: formValues.current_stage || "",
        store_url: formValues.store_url || "",
        product_category: formValues.product_category || "",
        sku_count: formValues.sku_count || "",
        revenue_range: formValues.revenue_range || "",
        fulfillment_method: formValues.fulfillment_method || "",
        launch_timeline: formValues.launch_timeline || "",
        name: formValues.name || "",
        company: formValues.company || "",
        email: formValues.email || "",
        phone: formValues.phone || "",
        page_url: window.location.href,
        referrer: document.referrer || "",
      },
      getUtmParams()
    );

    fetch("/api/save-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      /* Sheets sync is best-effort only; the lead has already been emailed via FormSubmit. */
    });
  }

  /* Forms — deliver submissions via email (FormSubmit) */
  function wireEmailForm(form, successSelector, onSuccess, collectLead) {
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      let endpoint = form.getAttribute("action") || "";
      try {
        const url = new URL(endpoint, window.location.href);
        if (url.hostname === "formsubmit.co" && !url.pathname.startsWith("/ajax/")) {
          url.pathname = "/ajax" + url.pathname;
        }
        endpoint = url.toString();
      } catch (err) {
        /* leave endpoint as-is if it can't be parsed */
      }

      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      const formValues = Object.fromEntries(new FormData(form).entries());

      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(formValues),
      })
        .then((res) => {
          if (!res.ok) throw new Error("Submission failed");
          recordLead({ email: formValues.email, phone: formValues.phone });
          if (collectLead) saveLeadToSheets(formValues);
          const success = document.querySelector(successSelector);
          if (success) {
            success.classList.add("show");
            success.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          form.reset();
          if (onSuccess) onSuccess();
        })
        .catch(() => {
          // Fall back to a normal form submission if the AJAX request fails.
          HTMLFormElement.prototype.submit.call(form);
        })
        .finally(() => {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  }

  const BOOKING_HOST = "calendar.app.google";

  function bookingModalMarkup() {
    return `<div class="modal" id="qualifyModal" aria-hidden="true">
    <div class="modal__overlay" data-close-qualify></div>
    <div class="modal__dialog" role="dialog" aria-modal="true" aria-labelledby="qualifyTitle">
      <button type="button" class="modal__close" aria-label="Close" data-close-qualify>
        <svg viewBox="0 0 24 24" fill="none" width="20" height="20"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button>
      <div class="modal__head">
        <span class="eyebrow">Partnership enquiry</span>
        <h2 id="qualifyTitle">Tell us about your business</h2>
        <p>Tell us what you sell and we'll be in touch about whether a Goatara partnership is a fit.</p>
      </div>

      <div class="form-success" id="qualifySuccess" tabindex="-1" role="status">
        <p><b>Got it &mdash; your details are on their way to us.</b></p>
        <p>We'll review your business details and get back to you within one business day.</p>
      </div>

      <form class="qualify-form" id="qualifyForm" action="https://formsubmit.co/contact@goatara.com" method="POST" novalidate>
        <input type="hidden" name="_subject" value="New partnership application — Goatara" />
        <input type="hidden" name="_template" value="table" />
        <input type="hidden" name="_cc" value="bfratello@goatara.com,hmdodds@goatara.com,emdodds@goatara.com" />
        <input type="text" name="_honey" style="display:none" tabindex="-1" autocomplete="off" />

        <div class="field">
          <label for="q_stage">Where are you at right now?</label>
          <select id="q_stage" name="current_stage" required>
            <option value="">Select one</option>
            <option>I have products but I'm not selling online yet</option>
            <option>I'm getting ready to launch my first store</option>
            <option>I have a Shopify store, not launched yet</option>
            <option>I have a Shopify store, live but barely selling</option>
            <option>I have a Shopify store that's doing well</option>
            <option>I sell on Amazon or another marketplace</option>
            <option>I sell through retail, wholesale or in person</option>
            <option>I sell through social media or direct messages</option>
            <option>I have a website, but it's not Shopify</option>
          </select>
        </div>

        <div class="field">
          <label for="q_url">Link to your store, listings or products <span class="field__optional">(optional)</span></label>
          <input type="text" id="q_url" name="store_url" placeholder="https://" />
        </div>

        <div class="field-row">
          <div class="field">
            <label for="q_category">What do you sell?</label>
            <input type="text" id="q_category" name="product_category" placeholder="e.g. Home &amp; kitchen" required />
          </div>
          <div class="field">
            <label for="q_skus">Roughly how many products? <span class="field__optional">(optional)</span></label>
            <input type="number" id="q_skus" name="sku_count" min="1" placeholder="e.g. 12" />
          </div>
        </div>

        <div class="field">
          <label for="q_revenue">Current monthly revenue across all channels</label>
          <select id="q_revenue" name="revenue_range" required>
            <option value="">Select a range</option>
            <option>Not selling yet</option>
            <option>Under $5,000</option>
            <option>$5,000 – $25,000</option>
            <option>$25,000 – $50,000</option>
            <option>$50,000 – $100,000</option>
            <option>$100,000 – $250,000</option>
            <option>$250,000+</option>
          </select>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="q_fulfillment">How would orders get shipped?</label>
            <select id="q_fulfillment" name="fulfillment_method" required>
              <option value="">Select one</option>
              <option>I ship them myself</option>
              <option>3PL / warehouse</option>
              <option>My supplier or manufacturer ships them</option>
              <option>Fulfilled by Amazon (FBA)</option>
              <option>Print on demand / dropshipping</option>
              <option>Not sure yet</option>
            </select>
          </div>
          <div class="field">
            <label for="q_timeline">When would you want to start?</label>
            <select id="q_timeline" name="launch_timeline" required>
              <option value="">Select one</option>
              <option>As soon as possible</option>
              <option>Within 1 month</option>
              <option>1–3 months</option>
              <option>3+ months</option>
              <option>Just exploring</option>
            </select>
          </div>
        </div>

        <hr class="modal__divider" />

        <div class="field-row">
          <div class="field">
            <label for="q_name">Full name</label>
            <input type="text" id="q_name" name="name" autocomplete="name" required />
          </div>
          <div class="field">
            <label for="q_company">Business name <span class="field__optional">(optional)</span></label>
            <input type="text" id="q_company" name="company" autocomplete="organization" />
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="q_email">Email</label>
            <input type="email" id="q_email" name="email" autocomplete="email" required />
          </div>
          <div class="field">
            <label for="q_phone">Phone</label>
            <input type="tel" id="q_phone" name="phone" autocomplete="tel" required />
          </div>
        </div>

        <button type="submit" class="btn btn--primary btn--block btn--lg">Submit My Details</button>
        <p class="form-note">By submitting, you agree to be contacted about a Goatara partnership. No spam, ever.</p>
      </form>
    </div>
  </div>`;
  }

  const modalHost = document.createElement("div");
  modalHost.innerHTML = bookingModalMarkup();
  const bookingModal = modalHost.firstElementChild;
  document.body.appendChild(bookingModal);

  const bookingForm = bookingModal.querySelector("#qualifyForm");
  const leadSuccess = bookingModal.querySelector("#qualifySuccess");
  let lastFocused = null;

  const openBookingModal = () => {
    lastFocused = document.activeElement;
    bookingModal.classList.add("open");
    bookingModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    const target = bookingForm.hidden ? leadSuccess : bookingModal.querySelector("#q_stage");
    if (target) target.focus();
  };
  const closeBookingModal = () => {
    bookingModal.classList.remove("open");
    bookingModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    if (lastFocused) lastFocused.focus();
  };

  document.querySelectorAll("[data-open-qualify]").forEach((b) => b.addEventListener("click", openBookingModal));
  bookingModal.querySelectorAll("[data-close-qualify]").forEach((c) => c.addEventListener("click", closeBookingModal));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && bookingModal.classList.contains("open")) closeBookingModal();
  });

  wireEmailForm(
    bookingForm,
    "#qualifySuccess",
    () => {
      bookingForm.hidden = true;
      const eyebrow = bookingModal.querySelector(".modal__head .eyebrow");
      const title = bookingModal.querySelector("#qualifyTitle");
      const intro = bookingModal.querySelector(".modal__head p");
      if (eyebrow) eyebrow.textContent = "Thank you";
      if (title) title.textContent = "Your details have been sent";
      if (intro) intro.remove();
      if (leadSuccess) leadSuccess.focus();
    },
    true
  );

  /* Footer year */
  const yearEl = document.querySelector("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* Reddit Lead — booking, phone and email CTAs; delegated so each click counts exactly once */
  document.addEventListener("click", (e) => {
    const link = e.target.closest ? e.target.closest("a[href]") : null;
    if (!link) return;
    const href = link.getAttribute("href") || "";

    if (link.hostname === BOOKING_HOST) {
      e.preventDefault();
      openBookingModal();
      return;
    }

    if (/^(tel:|mailto:)/i.test(href)) {
      recordLead();
    }
  });
})();
