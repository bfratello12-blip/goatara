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

  /* Contact form (demo, no backend) */
  const form = document.querySelector("#contactForm");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const success = document.querySelector("#formSuccess");
      if (success) {
        success.classList.add("show");
        success.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      form.reset();
    });
  }

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

    const qForm = document.querySelector("#qualifyForm");
    if (qForm) {
      qForm.addEventListener("submit", (e) => {
        // No email endpoint yet — handle as a demo until the action URL is set.
        const action = qForm.getAttribute("action") || "";
        if (action.indexOf("REPLACE_WITH_EMAIL_ENDPOINT") !== -1) {
          e.preventDefault();
          if (!qForm.checkValidity()) {
            qForm.reportValidity();
            return;
          }
          const success = document.querySelector("#qualifySuccess");
          if (success) {
            success.classList.add("show");
            success.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          qForm.reset();
        }
      });
    }
  }

  /* Footer year */
  const yearEl = document.querySelector("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
