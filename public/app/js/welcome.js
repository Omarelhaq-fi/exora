// Welcome onboarding — full-screen overlay shown once per account until the
// student provides their display name + country. Covers brand-new signups AND
// legacy accounts created before country existed. Saves to users_index +
// users/{uid} via Firestore compat SDK (same as syncDbToCloud).
(function () {
  const COUNTRIES = [
    { value: "egypt", label: "Egypt", flag: "\u{1F1EA}\u{1F1EC}" },
    { value: "tunisia", label: "Tunisia", flag: "\u{1F1F9}\u{1F1F3}" },
    { value: "algeria", label: "Algeria", flag: "\u{1F1E9}\u{1F1FF}" },
    { value: "morocco", label: "Morocco", flag: "\u{1F1F2}\u{1F1E6}" },
    { value: "global", label: "International / Other", flag: "\u{1F30D}" },
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  window.showWelcomeOnboarding = function () {
    // Already completed? never show again
    try { if (localStorage.getItem("omnote_onboarded") === "1") return; } catch (_) {}
    if (document.getElementById("welcome-onboarding")) return;

    const user = window.firebase && firebase.auth().currentUser;
    if (!user) return;

    const defaultName = user.displayName || "";
    const avatar = user.photoURL || "";

    const overlay = document.createElement("div");
    overlay.id = "welcome-onboarding";
    overlay.innerHTML = `
      <div class="wo-card">
        <div class="wo-brand">
          <div class="wo-logo">E</div>
          <span>Exora</span>
        </div>
        <h2 class="wo-title">Welcome${defaultName ? " back, " + esc(defaultName.split(" ")[0]) : ""}! \u{1F44B}</h2>
        <p class="wo-sub">Two quick things before you start — your country decides which question banks you get.</p>

        <label class="wo-label">Your name</label>
        <input id="wo-name" class="login-input" type="text" placeholder="e.g. Ahmed Hassan" maxlength="40" value="${esc(defaultName)}" />

        <label class="wo-label">Your country</label>
        <div class="wo-countries">
          ${COUNTRIES.map(c => `
            <button type="button" class="wo-country" data-value="${c.value}">
              <span class="wo-flag">${c.flag}</span>
              <span>${esc(c.label)}</span>
            </button>`).join("")}
        </div>

        <div class="wo-status" id="wo-status"></div>
        <button id="wo-go" class="btn-action primary wo-go" disabled>Start Studying</button>
        ${avatar ? `<img src="${esc(avatar)}" style="display:none;" alt="" />` : ""}
      </div>
      <style>${CSS}</style>`;
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    let picked = "";
    const go = overlay.querySelector("#wo-go");
    const status = overlay.querySelector("#wo-status");
    const nameEl = overlay.querySelector("#wo-name");

    function refresh() {
      overlay.querySelectorAll(".wo-country").forEach(b => {
        b.classList.toggle("picked", b.dataset.value === picked);
      });
      go.disabled = !(picked && (nameEl.value || "").trim().length >= 2);
    }
    overlay.querySelectorAll(".wo-country").forEach(b => {
      b.addEventListener("click", () => { picked = b.dataset.value; refresh(); });
    });
    nameEl.addEventListener("input", refresh);
    setTimeout(() => { nameEl.focus(); refresh(); }, 60);

    go.addEventListener("click", async () => {
      const name = (nameEl.value || "").trim();
      if (name.length < 2 || !picked) return;
      go.disabled = true;
      go.textContent = "Saving…";
      try {
        // Auth profile
        try { await user.updateProfile({ displayName: name }); } catch (_) {}

        // Firestore profile (both docs, merge)
        const fsdb = firebase.firestore();
        await fsdb.collection("users_index").doc(user.uid).set(
          { country: picked, displayName: name, email: user.email || "", qbankGrants: [] },
          { merge: true }
        );
        await fsdb.collection("users").doc(user.uid).set(
          { country: picked, qbankGrants: [] },
          { merge: true }
        );

        try { localStorage.setItem("omnote_onboarded", "1"); } catch (_) {}

        overlay.remove();
        document.body.style.overflow = "";

        // Re-run access bootstrap so their banks appear instantly
        if (window.db) delete window.db.access;
        if (typeof saveDb === "function") saveDb();
        if (typeof window.openQBank === "function") window.openQBank();
        else if (typeof window.refreshAppUI === "function") window.refreshAppUI();
      } catch (e) {
        status.textContent = "Could not save: " + (e.message || e) + " — check your connection and retry.";
        go.disabled = false;
        go.textContent = "Start Studying";
      }
    });
  };

  const CSS = `
  #welcome-onboarding {
    position: fixed; inset: 0; z-index: 999999;
    background:
      radial-gradient(1200px 600px at 50% -10%, rgba(14,124,134,0.25), transparent 60%),
      var(--bg-base, #10181d);
    display: flex; align-items: center; justify-content: center;
    padding: 24px; font-family: 'Figtree', sans-serif;
    backdrop-filter: blur(6px);
  }
  .wo-card {
    width: min(480px, 100%);
    background: var(--bg-elevated, #16232a);
    border: 1px solid rgba(45,212,191,0.16);
    border-radius: 22px;
    padding: 34px 36px 30px;
    box-shadow: 0 40px 100px -30px rgba(4,18,22,0.85);
    animation: wo-in .35s cubic-bezier(.4,0,.2,1);
  }
  @keyframes wo-in { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }
  .wo-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px;
    font-family: 'Outfit', sans-serif; font-weight: 800; font-size: 1.15rem; color: var(--text-primary, #fff); }
  .wo-logo { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
    background: linear-gradient(135deg, #14929d, #0e7c86); color: #fff; font-weight: 800; font-size: 0.95rem; }
  .wo-title { font-family: 'Outfit', sans-serif; font-size: 1.55rem; font-weight: 800; margin: 0 0 6px;
    color: var(--text-primary, #fff); letter-spacing: -0.01em; }
  .wo-sub { margin: 0 0 20px; font-size: 0.92rem; line-height: 1.55; color: var(--text-muted, #8fa9b4); }
  .wo-label { display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--accent-cyan, #2dd4bf); margin: 16px 0 7px; }
  .wo-card .login-input { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.05) !important;
    border: 1px solid rgba(255,255,255,0.12) !important; color: var(--text-primary, #fff) !important;
    padding: 12px 14px; border-radius: 10px; font-size: 0.95rem; }
  .wo-card .login-input:focus { outline: none; border-color: var(--accent-cyan, #2dd4bf) !important;
    box-shadow: 0 0 0 3px rgba(14,124,134,0.18); }
  .wo-countries { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 9px; }
  .wo-country { display: flex; align-items: center; gap: 9px; padding: 11px 13px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
    color: var(--text-secondary, #cfe0e6); cursor: pointer; font-family: inherit; font-size: 0.88rem; font-weight: 600;
    transition: all .15s ease; text-align: left; }
  .wo-country:hover { background: rgba(255,255,255,0.08); transform: translateY(-1px); }
  .wo-country.picked { background: rgba(14,124,134,0.18); border-color: var(--accent-cyan, #2dd4bf);
    color: #fff; box-shadow: 0 0 0 1px var(--accent-cyan, #2dd4bf), 0 6px 18px -6px rgba(20,146,157,0.5); }
  .wo-flag { font-size: 1.15rem; line-height: 1; }
  .wo-status { min-height: 18px; font-size: 0.82rem; color: #facc15; margin-top: 10px; }
  .wo-go { width: 100%; margin-top: 12px; padding: 13px; border-radius: 12px; border: none; cursor: pointer;
    font-family: inherit; font-size: 0.98rem; font-weight: 700; color: #fff;
    background: linear-gradient(135deg, #14929d, #0e7c86); transition: filter .15s ease, opacity .15s ease; }
  .wo-go:hover:not(:disabled) { filter: brightness(1.12); }
  .wo-go:disabled { opacity: 0.45; cursor: not-allowed; }

  /* light mode */
  body.app-light-mode #welcome-onboarding { background:
    radial-gradient(1200px 600px at 50% -10%, rgba(14,124,134,0.14), transparent 60%),
    var(--bg-base, #f4f6f8); }
  body.app-light-mode .wo-card { background: #ffffff; border-color: #dbe3e7;
    box-shadow: 0 40px 90px -30px rgba(10,61,74,0.35); }
  body.app-light-mode .wo-title, body.app-light-mode .wo-brand { color: #0a3d4a; }
  body.app-light-mode .wo-sub { color: #6b7f88; }
  body.app-light-mode .wo-card .login-input { background: #fff !important; border-color: #dbe3e7 !important; color: #0a3d4a !important; }
  body.app-light-mode .wo-country { background: #f4f6f8; border-color: #dbe3e7; color: #334e59; }
  body.app-light-mode .wo-country.picked { background: #e6f4f5; border-color: #0e7c86; color: #0b6770; }
  `;
})();
