// Welcome screen — shown once after login to any signed-in user whose profile
// has no country (covers new signups AND pre-existing registered users).
// Collects name + country, writes users_index/{uid} + users/{uid}, then the
// normal access bootstrap applies country gating.
(function () {
  const COUNTRIES = [
    { value: "egypt",   label: "Egypt",         flag: "eg", lang: "ar" },
    { value: "tunisia", label: "Tunisia",       flag: "tn", lang: "fr" },
    { value: "algeria", label: "Algeria",       flag: "dz", lang: "fr" },
    { value: "morocco", label: "Morocco",       flag: "ma", lang: "fr" },
    { value: "global",  label: "International", flag: null, lang: "en" },
  ];

  // Country → default language mapping
  const COUNTRY_LANG = {
    tunisia: 'fr',
    algeria: 'fr',
    morocco: 'fr',
    egypt: 'ar',
    global: 'en',
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  window.ensureCountryProfile = async function (user) {
    if (!user) return false;
    try {
      // Already set? nothing to do. Read via REST-free path: compat SDK.
      const fsdb = firebase.firestore();
      const snap = await fsdb.collection("users_index").doc(user.uid).get();
      const country = (snap.exists && snap.data().country) || "";
      if (country) return true; // already onboarded

      return await new Promise((resolve) => {
        showWelcomeOverlay(user, async (name, countryValue) => {
          try {
            await fsdb.collection("users_index").doc(user.uid).set(
              {
                country: countryValue,
                displayName: name,
                email: (user.email || "").toLowerCase(),
                qbankGrants: [],
              },
              { merge: true }
            );
            try {
              await fsdb.collection("users").doc(user.uid).set(
                { country: countryValue, qbankGrants: [] },
                { merge: true }
              );
            } catch (_) {}
            resolve(true);
          } catch (e) {
            alert("Could not save your profile: " + (e.message || e));
            resolve(false);
          }
        });
      });
    } catch (e) {
      console.warn("ensureCountryProfile failed", e);
      return true; // never lock the user out on a transient error
    }
  };

  function showWelcomeOverlay(user, onSubmit) {
    const old = document.getElementById("welcome-onboarding");
    if (old) old.remove();

    const el = document.createElement("div");
    el.id = "welcome-onboarding";
    el.innerHTML = `
      <div class="wo-card">
        <div class="wo-brand"><span class="wo-logo">E</span> Exora</div>
        <h2 class="wo-title">Welcome to Exora${user.displayName ? ", " + esc(user.displayName.split(" ")[0]) : ""}! 👋</h2>
        <p class="wo-sub">Let's personalize your workspace. Your country decides which question banks you get.</p>

        <label class="wo-label">Your full name</label>
        <input id="wo-name" class="wo-input" type="text" maxlength="60"
               placeholder="e.g. Ahmed Hassan" value="${esc(user.displayName || "")}" />

        <label class="wo-label">Select your country</label>
        <div class="wo-grid" id="wo-country-grid">
          ${COUNTRIES.map(c => `
            <button type="button" class="wo-country" data-value="${c.value}">
              ${c.flag ? `<img src="https://flagcdn.com/${c.flag}.svg" alt="" />` : `<span class="wo-globe">🌍</span>`}`
              <span>${esc(c.label)}</span>
            </button>`).join("")}
        </div>

        <div class="wo-err" id="wo-err"></div>
        <button id="wo-continue" class="wo-continue" disabled>Start studying</button>
      </div>
      <style>${CSS}</style>`;
    document.body.appendChild(el);

    let chosen = "";
    const grid = el.querySelector("#wo-country-grid");
    grid.addEventListener("click", (e) => {
      const btn = e.target.closest(".wo-country");
      if (!btn) return;
      chosen = btn.dataset.value;
      grid.querySelectorAll(".wo-country").forEach(b => b.classList.toggle("selected", b === btn));
      el.querySelector("#wo-continue").disabled = false;
      el.querySelector("#wo-err").textContent = "";
    });

    el.querySelector("#wo-continue").addEventListener("click", () => {
      const name = (el.querySelector("#wo-name").value || "").trim();
      if (name.length < 2) { el.querySelector("#wo-err").textContent = "Please enter your name."; return; }
      if (!chosen) { el.querySelector("#wo-err").textContent = "Please select your country."; return; }

      const btn = el.querySelector("#wo-continue");
      btn.disabled = true;
      btn.textContent = "Setting up…";

      // Auto-set language based on country
      const countryLang = COUNTRY_LANG[chosen] || 'en';
      if (window.setSiteLanguage) {
        window.setSiteLanguage(countryLang);
      } else if (window.setUserLanguage) {
        window.setUserLanguage(countryLang);
      }

      // Also update the Firebase auth display name if it was empty
      const u = firebase.auth().currentUser;
      if (u && !(u.displayName || "").trim()) {
        u.updateProfile({ displayName: name }).catch(() => {});
      }

      onSubmit(name, chosen).then((ok) => {
        el.remove();
        if (!ok) { /* overlay gone; user can retry via next bootstrap */ }
        else if (typeof window.bootstrapAccess === "function") {
          window.db && (window.db.access = null); // force re-bootstrap with new country
          window.bootstrapAccess().finally(() => {
            if (typeof window.openQBank === "function") window.openQBank();
          });
        }
      });
    });
  }

  const CSS = `
  #welcome-onboarding { position:fixed; inset:0; z-index:999999; background:#f4f6f8;
    display:flex; align-items:center; justify-content:center; padding:24px; overflow-y:auto;
    font-family:'Figtree',sans-serif; }
  .wo-card { width:min(480px,100%); background:#fff; border:1px solid #dbe3e7; border-radius:20px;
    padding:36px 34px; box-shadow:0 30px 80px -20px rgba(10,61,74,0.25); text-align:center; }
  .wo-brand { display:inline-flex; align-items:center; gap:9px; font-family:'Outfit',sans-serif;
    font-weight:800; font-size:1.05rem; color:#0a3d4a; margin-bottom:18px; letter-spacing:-0.01em; }
  .wo-logo { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px;
    border-radius:8px; background:linear-gradient(135deg,#14929d,#0e7c86); color:#fff;
    font-size:0.85rem; font-weight:800; }
  .wo-title { font-family:'Outfit',sans-serif; font-size:1.45rem; font-weight:800; color:#0a3d4a;
    margin:0 0 8px; letter-spacing:-0.02em; }
  .wo-sub { color:#334e59; font-size:0.92rem; line-height:1.55; margin:0 0 22px; }
  .wo-label { display:block; text-align:left; font-size:0.72rem; font-weight:700;
    letter-spacing:0.09em; text-transform:uppercase; color:#0e7c86; margin:16px 0 7px; }
  .wo-input { width:100%; box-sizing:border-box; padding:12px 14px; border:1px solid #dbe3e7;
    border-radius:11px; font-size:0.95rem; font-family:inherit; color:#0a3d4a; outline:none;
    transition:border-color .15s ease, box-shadow .15s ease; }
  .wo-input:focus { border-color:#0e7c86; box-shadow:0 0 0 3px rgba(14,124,134,0.14); }
  .wo-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:9px; }
  @media (max-width:430px){ .wo-grid{grid-template-columns:1fr;} }
  .wo-country { display:flex; align-items:center; gap:10px; padding:12px 14px; cursor:pointer;
    background:#fbfcfd; border:1.5px solid #dbe3e7; border-radius:12px; font-family:inherit;
    font-size:0.93rem; font-weight:600; color:#334e59; transition:all .15s ease; text-align:left; }
  .wo-country img { width:26px; height:auto; border-radius:3px; box-shadow:0 1px 4px rgba(0,0,0,0.15); }
  .wo-country:hover { border-color:#0e7c86; transform:translateY(-1px); }
  .wo-country.selected { border-color:#0e7c86; background:#e6f4f5; color:#0b6770;
    box-shadow:0 0 0 3px rgba(14,124,134,0.13); }
  .wo-globe { font-size:1.2rem; }
  .wo-err { min-height:18px; color:#c0392b; font-size:0.83rem; margin-top:12px; font-weight:600; }
  .wo-continue { width:100%; margin-top:6px; padding:13px; border:none; border-radius:11px;
    background:linear-gradient(135deg,#14929d,#0e7c86); color:#fff; font-family:inherit;
    font-size:1rem; font-weight:700; cursor:pointer; transition:filter .15s ease; }
  .wo-continue:hover:not(:disabled) { filter:brightness(1.1); }
  .wo-continue:disabled { opacity:0.55; cursor:not-allowed; }
  `;
})();
