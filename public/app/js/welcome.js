// Welcome onboarding — full-screen overlay shown once per account until the
// student provides their display name + country + language. Covers brand-new signups AND
// legacy accounts created before country existed. Saves to users_index +
// users/{uid} via Firestore compat SDK (same as syncDbToCloud).
(function () {
  const COUNTRIES = [
    { value: "egypt",   label: "Egypt",         flag: "eg" },
    { value: "tunisia", label: "Tunisia",       flag: "tn" },
    { value: "algeria", label: "Algeria",       flag: "dz" },
    { value: "morocco", label: "Morocco",       flag: "ma" },
    { value: "saudi",   label: "Saudi Arabia",  flag: "sa" },
    { value: "global",  label: "International", flag: null },
  ];

  const LANGUAGES = [
    { value: "en", label: "English" },
    { value: "fr", label: "Français" },
    { value: "ar", label: "العربية" },
  ];

  // Country → default language mapping
  const COUNTRY_LANG = {
    tunisia: 'fr',
    algeria: 'fr',
    morocco: 'fr',
    egypt: 'ar',
    saudi: 'ar',
    global: 'en',
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  window.showWelcomeOnboarding = function () {
    if (window.hideGlobalLoader) window.hideGlobalLoader();
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
      <div class="wo-layout">
        <!-- Left Side: Dashboard Aesthetic Hero -->
        <div class="wo-hero">
          
          <div class="wo-hero-content">
            <div class="wo-brand-hero">
              <div class="wo-logo-hero"><img src="assets/logo.png" alt="Exora Logo" style="width: 100%; height: 100%; border-radius: 12px; object-fit: cover;"></div>
              <span>Exora QBank</span>
            </div>
            
            <h1 class="wo-hero-title">Personalize your study experience.</h1>
            <p class="wo-hero-desc">Tell us a bit about yourself. We'll optimize your workspace, language settings, and AI models to help you master medical concepts faster.</p>
            
            <div class="wo-hero-proof">
              <div class="wo-proof-avatars">
                <div class="wo-avatar"><i class="fa-solid fa-user"></i></div>
                <div class="wo-avatar"><i class="fa-solid fa-user-md"></i></div>
                <div class="wo-avatar"><i class="fa-solid fa-user-nurse"></i></div>
              </div>
              <p>Join thousands of med students globally.</p>
            </div>
          </div>
        </div>

        <!-- Right Side: Form -->
        <div class="wo-form-area">
          <div class="wo-card">
            <div class="wo-brand-mobile">
              <div class="wo-logo-hero" style="width:28px;height:28px;font-size:12px;"><img src="assets/logo.png" alt="Exora Logo" style="width: 100%; height: 100%; border-radius: 12px; object-fit: cover;"></div>
              <span>Exora QBank</span>
            </div>
            <h2 class="wo-title">Welcome${defaultName ? " back, " + esc(defaultName.split(" ")[0]) : ""}! \u{1F44B}</h2>
            <p class="wo-sub">Let's set up your account preferences.</p>

            <div class="wo-form-group">
              <label class="wo-label"><i class="fa-regular fa-user"></i> How should we call you?</label>
              <input id="wo-name" class="wo-input" type="text" maxlength="60"
                     placeholder="e.g. Dr. House or John" value="${esc(defaultName)}" />
            </div>

            <div class="wo-form-group">
              <label class="wo-label"><i class="fa-solid fa-globe"></i> Where are you studying?</label>
              <div class="wo-grid" id="wo-country-grid">
                ${COUNTRIES.map(c => `
                  <button type="button" class="wo-btn-opt wo-country" data-value="${c.value}">
                    ${c.flag ? `<img src="https://flagcdn.com/${c.flag}.svg" alt="" />` : `<span class="wo-globe">🌍</span>`}
                    <span>${esc(c.label)}</span>
                  </button>`).join("")}
              </div>
              <p class="wo-help-text">This helps us tailor medical guidelines to your region.</p>
            </div>

            <div class="wo-form-group">
              <label class="wo-label"><i class="fa-solid fa-language"></i> Preferred Language</label>
              <div class="wo-grid" id="wo-lang-grid">
                ${LANGUAGES.map(l => `
                  <button type="button" class="wo-btn-opt wo-lang" data-value="${l.value}">
                    <span>${esc(l.label)}</span>
                  </button>`).join("")}
              </div>
            </div>

            <div class="wo-status" id="wo-status"></div>
            <button id="wo-go" class="wo-continue" disabled>
              Complete Setup <i class="fa-solid fa-arrow-right"></i>
            </button>
            ${avatar ? `<img src="${esc(avatar)}" style="display:none;" alt="" />` : ""}
          </div>
        </div>
      </div>
      <style>${CSS}</style>`;
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    let chosenCountry = "";
    let chosenLang = "";
    
    const go = overlay.querySelector("#wo-go");
    const status = overlay.querySelector("#wo-status");
    const nameEl = overlay.querySelector("#wo-name");

    const cGrid = overlay.querySelector("#wo-country-grid");
    cGrid.addEventListener("click", (e) => {
      const btn = e.target.closest(".wo-country");
      if (!btn) return;
      chosenCountry = btn.dataset.value;
      cGrid.querySelectorAll(".wo-country").forEach(b => b.classList.toggle("selected", b === btn));
      
      if (!chosenLang && COUNTRY_LANG[chosenCountry]) {
          const autoLang = COUNTRY_LANG[chosenCountry];
          const langBtn = overlay.querySelector(`.wo-lang[data-value="\${autoLang}"]`);
          if (langBtn) langBtn.click();
      }
      refresh();
    });

    const lGrid = overlay.querySelector("#wo-lang-grid");
    lGrid.addEventListener("click", (e) => {
      const btn = e.target.closest(".wo-lang");
      if (!btn) return;
      chosenLang = btn.dataset.value;
      lGrid.querySelectorAll(".wo-lang").forEach(b => b.classList.toggle("selected", b === btn));
      refresh();
    });

    function refresh() {
      const hasName = (nameEl.value || "").trim().length >= 2;
      go.disabled = !(hasName && chosenCountry && chosenLang);
      status.textContent = "";
    }
    
    nameEl.addEventListener("input", refresh);
    setTimeout(() => { nameEl.focus(); refresh(); }, 60);

    go.addEventListener("click", async () => {
      const name = (nameEl.value || "").trim();
      if (name.length < 2 || !chosenCountry || !chosenLang) return;
      
      go.disabled = true;
      go.innerHTML = 'Setting up... <i class="fa-solid fa-spinner fa-spin"></i>';
      
      try {
        try { localStorage.setItem('omnote_lang', chosenLang); } catch (_) {}

        // Auth profile
        try { await user.updateProfile({ displayName: name }); } catch (_) {}

        // Firestore profile (both docs, merge)
        const fsdb = firebase.firestore();
        await fsdb.collection("users_index").doc(user.uid).set(
          { country: chosenCountry, displayName: name, email: user.email || "" },
          { merge: true }
        );
        await fsdb.collection("users").doc(user.uid).set(
          { country: chosenCountry, language: chosenLang },
          { merge: true }
        );

        try { localStorage.setItem("omnote_onboarded", "1"); } catch (_) {}

        overlay.style.opacity = '0';
        setTimeout(() => {
          overlay.remove();
          document.body.style.overflow = "";
        }, 400);

        // Re-run access bootstrap so their banks appear instantly
        if (window.db) delete window.db.access;
        if (typeof saveDb === "function") saveDb();
        if (typeof window.openQBank === "function") window.openQBank();
        else if (typeof window.refreshAppUI === "function") window.refreshAppUI();

        // Set local language last (as it triggers a page reload)
        if (window.setSiteLanguage) {
          window.setSiteLanguage(chosenLang);
        } else if (window.setUserLanguage) {
          window.setUserLanguage(chosenLang);
        }
      } catch (e) {
        status.textContent = "Could not save: " + (e.message || e) + " — check your connection and retry.";
        go.disabled = false;
        go.innerHTML = 'Complete Setup <i class="fa-solid fa-arrow-right"></i>';
      }
    });
  };

  const CSS = `
  #welcome-onboarding { 
    position:fixed; inset:0; z-index:999999; background:var(--bg-base, #f4f6f8);
    display:flex; font-family:'Figtree',sans-serif;
    transition: opacity 0.4s ease;
  }
  .wo-layout {
    display: flex;
    width: 100%;
    min-height: 100vh;
  }
  
  /* Left Hero */
  .wo-hero {
    flex: 1;
    background: url('images/exora-onboarding-bg.png') center/cover no-repeat;
    position: relative;
    overflow: hidden;
    display: none;
    flex-direction: column;
    justify-content: center;
    padding: 60px;
  }
  .wo-hero::before {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(135deg, rgba(10,30,40,0.85) 0%, rgba(14,124,134,0.4) 100%);
  }
  @media (min-width: 900px) { .wo-hero { display: flex; } }
  
  .wo-hero-content {
    position: relative; z-index: 10; max-width: 480px; text-shadow: 0 2px 10px rgba(0,0,0,0.5);
  }
  .wo-brand-hero {
    display: flex; align-items: center; gap: 12px; font-family: 'Outfit', sans-serif;
    font-size: 1.5rem; font-weight: 800; color: #ffffff; margin-bottom: 40px;
  }
  .wo-logo-hero {
    width: 42px; height: 42px; background: #0e7c86; color: #fff;
    display: flex; align-items: center; justify-content: center;
    border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); text-shadow: none;
  }
  .wo-hero-title {
    font-family: 'Outfit', sans-serif; font-size: 2.8rem; font-weight: 800;
    color: #ffffff; line-height: 1.1; margin-bottom: 20px; letter-spacing: -0.02em;
  }
  .wo-hero-desc {
    font-size: 1.1rem; color: rgba(255,255,255,0.9); line-height: 1.6; margin-bottom: 40px;
  }
  .wo-hero-proof {
    display: flex; align-items: center; gap: 16px; color: rgba(255,255,255,0.8); font-weight: 600; font-size: 0.95rem;
  }
  .wo-proof-avatars { display: flex; }
  .wo-avatar {
    width: 36px; height: 36px; border-radius: 50%; background: #0e7c86; color: #ffffff;
    display: flex; align-items: center; justify-content: center;
    border: 2px solid rgba(255,255,255,0.2); margin-left: -10px; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); text-shadow: none;
  }
  .wo-proof-avatars .wo-avatar:first-child { margin-left: 0; }
  
  .wo-brand-mobile {
      display: none; align-items: center; gap: 8px; font-family: 'Outfit', sans-serif;
      font-size: 1.1rem; font-weight: 800; color: var(--text-primary, #0a3d4a); margin-bottom: 24px;
  }
  @media (max-width: 899px) { .wo-brand-mobile { display: flex; } }

  /* Right Form */
  .wo-form-area {
    flex: 1;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; position: relative;
    background: var(--bg-base, #fff);
  }
  .wo-card { 
    width: min(640px, 100%); 
    padding: 60px 40px; border-radius: 24px;
    background: transparent;
    border: none;
    box-shadow: none;
    animation: woFadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  @keyframes woFadeUp {
    0% { opacity: 0; transform: translateY(20px); }
    100% { opacity: 1; transform: translateY(0); }
  }

  .wo-title { 
    font-family:'Outfit',sans-serif; font-size: 2.4rem; font-weight: 800; color: var(--text-primary, #0a3d4a);
    margin:0 0 12px; letter-spacing:-0.02em; 
  }
  .wo-sub { color: var(--text-muted, #6b7f88); font-size: 1.15rem; line-height: 1.5; margin: 0 0 40px; }
  
  .wo-form-group { margin-bottom: 28px; text-align: left; }
  .wo-label { 
    display: flex; align-items: center; gap: 8px;
    font-size: 1.05rem; font-weight: 600; color: var(--text-primary, #0a3d4a); margin-bottom: 12px; 
  }
  .wo-label i { color: var(--accent-cyan, #0e7c86); font-size: 1.1rem; }
  
  .wo-input { 
    width: 100%; box-sizing: border-box; padding: 16px 20px; border: 1.5px solid var(--border-medium, #dbe3e7);
    border-radius: 14px; font-size: 1.1rem; font-family: inherit; color: var(--text-primary, #0a3d4a); outline: none;
    transition: all .2s ease; background: var(--bg-subtle, #fbfcfd);
  }
  .wo-input:focus { 
    border-color: var(--accent-cyan, #0e7c86); background: var(--bg-elevated, #fff);
    box-shadow: 0 0 0 4px rgba(14,124,134,0.1); 
  }
  
  .wo-help-text {
    font-size: 0.85rem; color: var(--text-muted, #6b7f88); margin: 8px 0 0 6px;
  }

  .wo-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
  
  .wo-btn-opt { 
    display: flex; align-items: center; gap: 12px; padding: 16px; cursor: pointer;
    background: var(--bg-subtle, #fbfcfd); border: 1.5px solid var(--border-medium, #dbe3e7); border-radius: 14px; font-family: inherit;
    font-size: 1.05rem; font-weight: 600; color: var(--text-secondary, #334e59); transition: all .2s ease; text-align: left; 
  }
  .wo-btn-opt img { width: 28px; height: auto; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .wo-btn-opt:hover { border-color: var(--accent-cyan, #0e7c86); transform: translateY(-2px); box-shadow: 0 6px 12px rgba(0,0,0,0.05); }
  .wo-btn-opt.selected { 
    border-color: var(--accent-cyan, #0e7c86); background: rgba(14,124,134,0.08); color: var(--accent-cyan, #0b6770);
    box-shadow: 0 0 0 3px rgba(14,124,134,0.15); 
  }
  .wo-globe { font-size: 1.2rem; }
  
  .wo-status { min-height: 20px; color: #c0392b; font-size: 0.9rem; margin-bottom: 16px; font-weight: 600; }
  
  .wo-continue { 
    width: 100%; padding: 20px; border: none; border-radius: 14px;
    background: var(--accent-cyan, #0e7c86); color: #fff; font-family: inherit;
    font-size: 1.2rem; font-weight: 700; cursor: pointer; transition: all .2s ease;
    display: flex; align-items: center; justify-content: center; gap: 10px;
    box-shadow: 0 6px 16px rgba(14, 124, 134, 0.2); margin-top: 10px;
  }
  .wo-continue:hover:not(:disabled) { background: #0b6770; transform: translateY(-1px); box-shadow: 0 6px 16px rgba(14, 124, 134, 0.3); }
  .wo-continue:active:not(:disabled) { transform: translateY(0); }
  .wo-continue:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; transform: none; }
  `;
})();
