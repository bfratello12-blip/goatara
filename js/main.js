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

  /* Forms — deliver submissions via email (FormSubmit) */
  function wireEmailForm(form, successSelector) {
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
          const success = document.querySelector(successSelector);
          if (success) {
            success.classList.add("show");
            success.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          form.reset();
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

  wireEmailForm(document.querySelector("#contactForm"), "#formSuccess");

  /* Qualify modal */
  const modal = document.querySelector("#qualifyModal");
  if (modal) {
    let lastFocused = null;
    const openBtns = document.querySelectorAll("[data-open-qualify]");
    const closeEls = modal.querySelectorAll("[data-close-qualify]");

    const openModal = () => {
      lastFocused = document.activeElement;
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-open");
      const firstField = modal.querySelector("input, select, textarea");
      if (firstField) firstField.focus();
    };
    const closeModal = () => {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("modal-open");
      if (lastFocused) lastFocused.focus();
    };

    openBtns.forEach((b) => b.addEventListener("click", openModal));
    closeEls.forEach((c) => c.addEventListener("click", closeModal));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("open")) closeModal();
    });

    wireEmailForm(document.querySelector("#qualifyForm"), "#qualifySuccess");
  }

  /* Footer year */
  const yearEl = document.querySelector("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* Reddit Lead — booking, phone and email CTAs; delegated so each click counts exactly once */
  document.addEventListener("click", (e) => {
    const link = e.target.closest ? e.target.closest("a[href]") : null;
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (/^(tel:|mailto:)/i.test(href) || link.hostname === "calendar.app.google") {
      recordLead();
    }
  });
})();
