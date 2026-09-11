(function () {
  let qbanks = [];
  let currentQBankId = null;
  let allQuestions = [];
  let currentQuestions = [];
  let currentIndex = 0;
  let qbankTimer = null;
  let questionStartTime = 0;
  let currentQuestionTimeMs = 0;
  let currentSelectedIndices = [];

  let cachedCategories = null;
  let preloadPromise = null;
  let cachedQBanks = {}; // { qbankId: { questions, progress } }
  let isSyncing = false;

  // --- IndexedDB Caching ---
  const DB_NAME = "OmnoteQBankCache";
  const STORE_NAME = "qbanks";
  const DB_VERSION = 1;

  function openQBankDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getCachedQBank(id) {
    try {
      const db = await openQBankDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch(e) { return null; }
  }
  window.getCachedQBank = getCachedQBank;

  async function setCachedQBank(id, data) {
    try {
      const db = await openQBankDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put({ id, ...data });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch(e) {}
  }
  window.setCachedQBank = setCachedQBank;

  function pushToSyncQueue(update) {
    let queue = JSON.parse(localStorage.getItem('omnote_qbank_sync_queue') || '[]');
    queue.push(update);
    localStorage.setItem('omnote_qbank_sync_queue', JSON.stringify(queue));
    if (queue.length >= 10) {
      flushSyncQueue();
    }
  }

  function applyLocalQueueProgress(qbankId, progressObj) {
    if (!progressObj) progressObj = {};
    let queue = JSON.parse(localStorage.getItem('omnote_qbank_sync_queue') || '[]');
    queue.forEach(update => {
      if (update.qbankId === qbankId) {
        if (!progressObj[update.questionId]) progressObj[update.questionId] = {};
        if (update.correct !== undefined) progressObj[update.questionId].correct = update.correct;
        if (update.timeTakenMs !== undefined) progressObj[update.questionId].timeTakenMs = update.timeTakenMs;
        if (update.marked !== undefined) progressObj[update.questionId].marked = update.marked;
        if (update.note !== undefined) progressObj[update.questionId].note = update.note;
      }
    });
    return progressObj;
  }

  let cachedAuthToken = null;
  window.addEventListener('load', () => {
    if (window.firebase) {
      window.firebase.auth().onIdTokenChanged(async user => {
        if (user) {
          cachedAuthToken = await user.getIdToken();
          setTimeout(flushSyncQueue, 1500);
        } else {
          cachedAuthToken = null;
        }
      });
    }
  });

  async function flushSyncQueue() {
    let queue = JSON.parse(localStorage.getItem('omnote_qbank_sync_queue') || '[]');
    if (queue.length === 0 || isSyncing) return;
    isSyncing = true;
    try {
      const updates = [...queue];
      const token = cachedAuthToken || (window.firebase && window.firebase.auth().currentUser ? await window.firebase.auth().currentUser.getIdToken() : null);
      if (token) {
        fetch(`/api/qbank`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "batch_sync_progress", updates }),
          keepalive: true
        }).then(async res => {
          if (!res.ok) throw new Error(await res.text());
          let currentQueue = JSON.parse(localStorage.getItem('omnote_qbank_sync_queue') || '[]');
          currentQueue = currentQueue.slice(updates.length);
          localStorage.setItem('omnote_qbank_sync_queue', JSON.stringify(currentQueue));
        }).catch(e => {
          console.error("Keepalive sync failed", e);
        });
      }
    } catch (e) {
      console.error("Failed to sync QBank progress:", e);
    } finally {
      isSyncing = false;
    }
  }
  
  window.addEventListener('visibilitychange', () => { 
    if (document.visibilityState === 'hidden') {
      isSyncing = false; // Force allow!
      flushSyncQueue();
    }
  });
  window.addEventListener('pagehide', () => {
    isSyncing = false; // Force allow!
    flushSyncQueue();
  });

  const pendingApiGets = new Map();
  async function apiGet(action, params = {}) {
    const qs = new URLSearchParams({ action, ...params }).toString();
    if (pendingApiGets.has(qs)) return pendingApiGets.get(qs);
    
    const promise = (async () => {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      if (!token) throw new Error("Not signed in");
      const res = await fetch(`/api/qbank?${qs}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "API error");
      if (data.encryptedQuestions) {
        try {
            const jsonStr = await window.decryptDRM(data.encryptedQuestions);
            data.questions = JSON.parse(jsonStr);
        } catch(e) {
            console.error("DRM decryption failed", e);
        }
      }
      return data;
    })();
    
    pendingApiGets.set(qs, promise);
    try {
      return await promise;
    } finally {
      pendingApiGets.delete(qs);
    }
  }

  async function apiPost(action, body) {
    const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
    if (!token) throw new Error("Not signed in");
    const res = await fetch(`/api/qbank`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...body })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "API error");
    return data;
  }

  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
    const s = (totalSec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function startTimer() {
    stopTimer();
    questionStartTime = Date.now();
    const display = document.getElementById("qbank-timer-display");
    if (display) display.innerHTML = `<i data-lucide="clock" style="width:14px;height:14px;vertical-align:-2px;"></i> Time: 00:00`;
    
    qbankTimer = setInterval(() => {
      const elapsed = Date.now() - questionStartTime;
      if (display) display.innerHTML = `<i data-lucide="clock" style="width:14px;height:14px;vertical-align:-2px;"></i> Time: ${formatTime(elapsed)}`;
    }, 1000);
  }

  function stopTimer() {
    if (qbankTimer) {
      clearInterval(qbankTimer);
      qbankTimer = null;
    }
  }

  window.preloadQBank = function() {
    if (!preloadPromise) {
      preloadPromise = (async () => {
        try {
          const res = await apiGet("list_categories");
          cachedCategories = res.qbanks || [];
        } catch (e) {
          console.error("Preload QBank failed", e);
          preloadPromise = null; // allow retry
        }
      })();
    }
    return preloadPromise;
  };

  // --- Session persistence ---
  function saveQBankSession(qbankId, qbankName, subject) {
    try {
      const session = { qbankId, qbankName, subject, timestamp: Date.now() };
      localStorage.setItem("omnote_qbank_last_session", JSON.stringify(session));
      // Also save to recent list (max 5)
      let recent = [];
      try { recent = JSON.parse(localStorage.getItem("omnote_qbank_recent") || "[]"); } catch(e) {}
      recent = recent.filter(r => !(r.qbankId === qbankId && r.subject === subject));
      recent.unshift(session);
      if (recent.length > 5) recent = recent.slice(0, 5);
      localStorage.setItem("omnote_qbank_recent", JSON.stringify(recent));
    } catch(e) {}
  }

  function getLastSession() {
    try { return JSON.parse(localStorage.getItem("omnote_qbank_last_session") || "null"); } catch(e) { return null; }
  }

  function getRecentSessions() {
    try { return JSON.parse(localStorage.getItem("omnote_qbank_recent") || "[]"); } catch(e) { return []; }
  }

  // --- Country-based access bootstrap ---
  // Called once per session (from openQBank). Fetches the student's profile
  // country + admin-granted banks; auto-selects their first main bank if
  // nothing selected yet.
  window.bootstrapAccess = async function(force = false) {
    if (!force && window.__bootstrapPromise) {
      if (Date.now() - (window.__bootstrapCacheTime || 0) < 300_000) {
        return window.__bootstrapPromise;
      }
    }
    window.__bootstrapCacheTime = Date.now();
    window.__bootstrapPromise = (async () => {
      try {
        if (!window.db) window.db = {};
        const res = await apiGet("bootstrap_access");
        window.db.access = {
          country: res.profileCountry || "",
          mainIds: Array.isArray(res.mainIds) ? res.mainIds : [],
          prepIds: Array.isArray(res.prepIds) ? res.prepIds : [],
          grants: Array.isArray(res.grants) ? res.grants : [],
          legacy: !!res.legacy,
        };
        const a = window.db.access;
        const isAllowed = (id) => a.legacy || a.grants.includes(id) || a.mainIds.includes(id);
        if (window.db.selectedQBankId && !isAllowed(window.db.selectedQBankId)) {
          window.db.selectedQBankId = null;
        }
        if (!window.db.selectedQBankId && a.mainIds.length > 0) {
          window.db.selectedQBankId = a.mainIds[0];
        }
        if (typeof saveDb === "function") saveDb();
        return a;
      } catch (e) {
        console.warn("bootstrap_access failed", e);
        return null;
      }
    })();
    return window.__bootstrapPromise;
  };

  window.qbankCanOpen = function(bankId) {
    const a = window.db && window.db.access;
    if (!a) return true; // fail-open before first bootstrap
    return a.grants.includes(bankId) || a.mainIds.includes(bankId) || a.prepIds.includes(bankId);
  };

  window.qbankRequestAccess = function(bankId, bankName) {
    // Styled modal (native prompt() can be suppressed by extensions/embeds)
    const old = document.getElementById("req-access-modal");
    if (old) old.remove();

    const ov = document.createElement("div");
    ov.id = "req-access-modal";
    ov.innerHTML = `
      <div class="ra-box">
        <div class="ra-head">
          <div>
            <div class="ra-title">Request Access</div>
            <div class="ra-sub">${window.escapeHtml ? window.escapeHtml(bankName) : bankName}</div>
          </div>
          <button type="button" class="ra-close">×</button>
        </div>
        <label class="ra-label">Why do you need this question bank?</label>
        <textarea id="ra-reason" rows="4" placeholder="e.g. I'm rotating at a Tunisian hospital next month…"></textarea>
        <div class="ra-status" id="ra-status"></div>
        <div class="ra-foot">
          <button type="button" class="btn-dark-pill ra-cancel">Cancel</button>
          <button type="button" id="ra-send" class="btn-action primary">Send Request</button>
        </div>
      </div>
      <style>${RA_CSS}</style>`;
    document.body.appendChild(ov);
    document.body.style.overflow = "hidden";
    setTimeout(() => ov.querySelector("#ra-reason").focus(), 60);

    const close = () => { ov.remove(); document.body.style.overflow = ""; };
    ov.querySelector(".ra-close").addEventListener("click", close);
    ov.querySelector(".ra-cancel").addEventListener("click", close);
    ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });

    ov.querySelector("#ra-send").addEventListener("click", async () => {
      const reason = (ov.querySelector("#ra-reason").value || "").trim();
      const statusEl = ov.querySelector("#ra-status");
      const sendBtn = ov.querySelector("#ra-send");
      if (reason.length < 5) {
        statusEl.textContent = "Please write a few words so the team can review your request.";
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending…";
      try {
        const token = await firebase.auth().currentUser.getIdToken();
        const res = await fetch("/api/qbank", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "request_access", qbankId: bankId, reason }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        close();
        alert("Request sent! You'll get a notification once it's reviewed.");
      } catch (err) {
        statusEl.textContent = "";
        sendBtn.disabled = false;
        sendBtn.textContent = "Send Request";
        alert("Could not send request: " + (err.message || err));
      }
    });
  };

  const RA_CSS = `
  #req-access-modal { position: fixed; inset: 0; z-index: 999999; background: rgba(6,25,31,0.72);
    backdrop-filter: blur(5px); display: flex; align-items: center; justify-content: center; padding: 24px;
    font-family: 'Figtree', sans-serif; }
  .ra-box { width: min(480px, 100%); background: var(--bg-elevated, #16232a); color: var(--text-primary, #fff);
    border: 1px solid rgba(245,158,11,0.3); border-radius: 18px; padding: 24px 26px;
    box-shadow: 0 40px 90px -30px rgba(4,18,22,0.85); }
  .ra-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
  .ra-title { font-family: 'Outfit', sans-serif; font-size: 1.2rem; font-weight: 800; display: flex; align-items: center; gap: 8px; }
  .ra-title::before { content: ''; width: 20px; height: 20px; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23f59e0b' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='11' width='18' height='11' rx='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E") center/contain no-repeat; }
  .ra-sub { font-size: 0.85rem; color: var(--text-muted, #8fa9b4); margin-top: 3px; }
  .ra-close { background: transparent; border: none; color: var(--text-muted, #7d97a3); font-size: 26px; cursor: pointer; line-height: 1; border-radius: 8px; width: 30px; height: 30px; }
  .ra-close:hover { color: #fff; background: rgba(244,63,94,0.15); }
  .ra-label { display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--accent-cyan, #2dd4bf); margin-bottom: 7px; }
  .ra-box textarea { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12); color: var(--text-primary, #fff); padding: 12px 14px;
    border-radius: 10px; font-family: inherit; font-size: 0.93rem; resize: vertical; min-height: 96px; }
  .ra-box textarea:focus { outline: none; border-color: var(--accent-cyan, #2dd4bf); box-shadow: 0 0 0 3px rgba(14,124,134,0.18); }
  .ra-status { min-height: 18px; font-size: 0.82rem; color: #facc15; margin-top: 8px; }
  .ra-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px; }

  body.app-light-mode #req-access-modal { background: rgba(10,61,74,0.45); }
  body.app-light-mode .ra-box { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  body.app-light-mode .ra-title { color: #0a3d4a; }
  body.app-light-mode .ra-sub { color: #6b7f88; }
  body.app-light-mode .ra-box textarea { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  `;

  // --- QBank Selection ---
  window.selectQBank = function(qbankId) {
      if (!window.db) window.db = {};
      window.db.selectedQBankId = qbankId;
      if (typeof window.saveDb === "function") window.saveDb();
      window.openQBank();
  };

  window.openQBankSelection = async function() {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";

    area.innerHTML = `
      <div class="flex justify-center items-center h-64">
        <div class="press-wrapper" style="margin: 20px auto 0; display: flex; justify-content: center; align-items: center;">
            <div class="press">
              <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div>
              <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div>
              <div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div>
            </div>
        </div>
      </div>
    `;

    try {
      await window.preloadQBank();
      qbanks = cachedCategories || [];
      qbanks = qbanks.filter(q => q.kind !== "exam_prep");
      
      if (qbanks.length === 0) {
        area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No QBanks available yet. Admins can create them in the Admin Panel.</div>';
        return;
      }
      
      let html = `<div style="max-width:1000px; margin:0 auto; padding:32px 24px;">
        <div style="margin-bottom:32px;">
          <h2 style="margin:0; font-size:1.75rem; font-weight:700; color:var(--text-primary);">Select Question Bank</h2>
          <p style="margin:6px 0 0 0; font-size:0.95rem; color:var(--text-muted);">Choose a bank to start practicing. You can switch anytime.</p>
        </div>
        <div style="display:flex; flex-direction:column; gap:16px;">`;
      
      const flagMap = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma" };
      const acc = window.db.access || null;
      const isAllowedMain = (id) => !acc || acc.legacy || !acc.country || acc.grants.includes(id) || acc.mainIds.includes(id);
      
      for (const q of qbanks) {
        const countryCode = flagMap[q.country];
        const flagHtml = countryCode 
           ? `<img src="https://flagcdn.com/${countryCode}.svg" alt="${countryCode}" style="width:32px; height:24px; border-radius:4px; object-fit:cover; box-shadow:0 2px 6px rgba(0,0,0,0.12);">`
           : `<div style="font-size:1.5rem; line-height:1;">🌍</div>`;
           
        const cached = cachedQBanks[q.id];
        const qCount = cached ? (cached.questions || []).length : 0;
        const countLabel = qCount > 0 ? `${qCount.toLocaleString()}` : '0';
        const countSubLabel = qCount > 0 ? 'questions' : 'coming soon';

        const allowed = isAllowedMain(q.id);
        const safeQName = (window.escapeHtml ? window.escapeHtml(q.name) : q.name).replace(/'/g, "\\'");
        
        const clickAttr = allowed
          ? `onclick="window.selectQBank('${q.id}')"`
          : `onclick="window.qbankRequestAccess('${q.id}','${safeQName}')"`;

        const cardOpacity = allowed ? '1' : '0.5';
        const cardBorder = allowed ? 'rgba(255,255,255,0.06)' : 'rgba(148,163,184,0.15)';
        const cardBg = allowed ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.01)';
        
        const cta = allowed
          ? `<button class="qbank-select-btn" style="width:100%; height:48px; padding:14px 20px; background:var(--accent-cyan); color:#fff; border:none; border-radius:10px; font-size:0.95rem; font-weight:600; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; justify-content:center; gap:8px;">
               <span>Select Bank</span>
               <i data-lucide="arrow-right" style="width:18px;height:18px;"></i>
             </button>`
          : `<button class="qbank-request-btn" style="width:100%; height:48px; padding:14px 20px; background:transparent; color:#64748b; border:2px solid #94a3b8; border-radius:10px; font-size:0.95rem; font-weight:600; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; justify-content:center; gap:8px;">
               <i data-lucide="lock" style="width:16px;height:16px;"></i>
               <span>Request Access</span>
             </button>`;

        html += `
          <div class="qbank-select-card" style="background:${cardBg}; border:1px solid ${cardBorder}; border-radius:16px; padding:20px 24px; cursor:pointer; transition:all 0.25s ease; display:flex; align-items:center; gap:20px; opacity:${cardOpacity};" ${clickAttr} onmouseover="this.style.transform='translateX(4px)'; this.style.borderColor='${allowed ? 'var(--accent-cyan)' : '#64748b'}';" onmouseout="this.style.transform='translateX(0)'; this.style.borderColor='${cardBorder}';">
             <div style="flex-shrink:0; display:flex; align-items:center; justify-content:center; width:48px; height:48px; background:rgba(255,255,255,0.03); border-radius:12px; overflow:hidden;">
               ${flagHtml}
             </div>
             <div style="flex:1; min-width:0;">
               <div style="display:flex; align-items:center; gap:10px; margin-bottom:2px;">
                 <h3 style="font-size:1.1rem; font-weight:600; margin:0; color:var(--text-primary);">${window.escapeHtml ? window.escapeHtml(q.name) : q.name}</h3>
                 ${allowed ? '' : '<span style="font-size:0.7rem; color:#64748b; background:rgba(100,116,139,0.1); padding:3px 8px; border-radius:6px; font-weight:600;">LOCKED</span>'}
               </div>
               <div style="display:flex; align-items:center; gap:8px; margin-top:0;">
                 <span style="font-size:1.25rem; font-weight:700; color:var(--accent-cyan);">${countLabel}</span>
                 <span style="font-size:0.85rem; color:var(--text-muted);">${countSubLabel}</span>
               </div>
             </div>
             <div style="flex-shrink:0; width:160px;">
               ${cta}
             </div>
          </div>`;
      }
      
      html += `</div></div>`;
      area.innerHTML = html;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load QBanks: ${e.message}</div>`;
    }
  };

  // --- QBank Home Dashboard ---
  window.openQBank = async function () {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    
    // Ensure we are on the QBank platform
    if (localStorage.getItem("omnote_active_platform") !== "qbank") {
        window.switchPlatform("qbank");
        return; // switchPlatform will call openQBank again
    }

    if (window.hideAllMainViews) window.hideAllMainViews();

    const qbankView = document.getElementById("qbank-home-view");
    if (qbankView) qbankView.style.display = "flex";
    // Update Sidebar active state
    document.querySelectorAll('nav a').forEach(a => {
        a.classList.remove('border-[#007a7a]', 'bg-[#007a7a]/5', 'text-[#007a7a]', 'font-bold');
        a.classList.add('border-transparent', 'text-gray-600', 'font-medium');
      });
      const homeTab = document.querySelector('nav a[data-path="home"]');
      if (homeTab) {
        homeTab.classList.remove('border-transparent', 'text-gray-600', 'font-medium');
        homeTab.classList.add('border-[#007a7a]', 'bg-[#007a7a]/5', 'text-[#007a7a]', 'font-bold');
      }

    // Load peer stats threshold
    _loadPeerThreshold();

    area.innerHTML = `
      <div class="flex flex-col justify-center items-center h-64 gap-4">
        <div class="press-wrapper" style="margin: 20px auto 0; display: flex; justify-content: center; align-items: center;">
            <div class="press">
              <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div>
              <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div>
              <div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div>
            </div>
        </div>
      </div>
      <style>
        @keyframes loading-bar-indeterminate {
          0% { transform: translateX(-100%) scaleX(0.2); }
          50% { transform: translateX(0) scaleX(1); }
          100% { transform: translateX(100%) scaleX(0.2); }
        }
      </style>
    `;
    
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    
    try {
      if (!window.db || !window.db.selectedQBankId) {
        window.openQBankSelection();
        return;
      }
      const activeQBankId = window.db.selectedQBankId;

      await window.bootstrapAccess(); // always fresh — never trust cached access
      await window.preloadQBank();
      qbanks = (cachedCategories || []).filter(q => q.kind !== "exam_prep");
      
      if (qbanks.length === 0) {
        area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No QBanks available yet. Admins can create them in the Admin Panel.</div>';
        return;
      }

      const activeQBankMeta = (cachedCategories || []).find(qb => qb.id === activeQBankId) || qbanks.find(qb => qb.kind !== "exam_prep") || qbanks[0];
      const activeQBankName = activeQBankMeta ? activeQBankMeta.name : "Your QBank";
      const isActiveExamPrep = activeQBankMeta && activeQBankMeta.kind === "exam_prep";
      
      if (!cachedQBanks[activeQBankId]) {
         area.innerHTML = `
          <div class="flex flex-col justify-center items-center h-64 gap-4">
            <div class="press-wrapper" style="margin: 20px auto 0; display: flex; justify-content: center; align-items: center;">
                <div class="press">
                  <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div>
                  <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div>
                  <div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div>
                </div>
            </div>
            <div class="text-on-surface-variant text-sm">Loading details...</div>
          </div>`;
         try {
             const catUpdated = activeQBankMeta.updatedAt || 0;
             const idbData = await getCachedQBank(activeQBankId);
             if (idbData && idbData.updatedAt === catUpdated && idbData.questions && idbData.questions.length > 0) {
                 // Questions are fresh in IndexedDB — only fetch progress (tiny, private)
                 const res = await apiGet("get_questions", { qbankId: activeQBankId, onlyProgress: true });
                 cachedQBanks[activeQBankId] = { questions: idbData.questions, progress: applyLocalQueueProgress(activeQBankId, res.progress || {}) };
             } else {
                 // Questions outdated or missing — download from CDN static endpoint
                 // (no Auth header = Vercel Edge CDN will cache this globally)
                 const [staticRes, progressRes] = await Promise.all([
                   (async () => {
                     const r = await fetch(`/api/qbank_static?qbankId=${encodeURIComponent(activeQBankId)}&v=${encodeURIComponent(catUpdated)}`);
                     const d = await r.json();
                     if (!r.ok) throw new Error(d.error || 'CDN fetch failed');
                     let questions = d.questions || [];
                     if (d.encryptedQuestions && window.decryptDRM) {
                       try {
                         const jsonStr = await window.decryptDRM(d.encryptedQuestions);
                         questions = JSON.parse(jsonStr);
                       } catch(e) { console.error('DRM decryption failed', e); }
                     }
                     return questions;
                   })(),
                   apiGet("get_questions", { qbankId: activeQBankId, onlyProgress: true })
                 ]);
                 const questions = staticRes;
                 const progress = progressRes.progress || {};
                 cachedQBanks[activeQBankId] = { questions, progress: applyLocalQueueProgress(activeQBankId, progress) };
                 // Persist to IndexedDB so next visit is instant
                 setCachedQBank(activeQBankId, { updatedAt: catUpdated, questions });
             }
         } catch (e) {
             console.error("Failed to load bank data", e);
         }
      }

      let totalQuestions = 0;
      let totalAnswered = 0;
      let totalCorrect = 0;
      let totalMarked = 0;
      let subjectStats = {};
      
      const qData = cachedQBanks[activeQBankId];
      if (qData) {
        // Set module-level allQuestions for startQBankFiltered
        allQuestions = qData.questions || [];
        window.qbankProgress = qData.progress || {};
        currentQBankId = activeQBankId;
        
        totalQuestions = (qData.questions || []).length;
        const prog = qData.progress || {};
        for (const q of (qData.questions || [])) {
           const sub = (q.data && q.data.subject) || "Uncategorized";
           if (!subjectStats[sub]) subjectStats[sub] = { total: 0, answered: 0, correct: 0 };
           subjectStats[sub].total++;
           if (prog[q.id]) {
             if (prog[q.id].correct !== undefined) { 
               totalAnswered++; 
               subjectStats[sub].answered++;
               if (prog[q.id].correct) {
                 totalCorrect++; 
                 subjectStats[sub].correct++;
               }
             }
             if (prog[q.id].marked) totalMarked++;
           }
        }
      }
      
      const globalScore = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
      const scoreColor = globalScore >= 80 ? '#22c55e' : (globalScore >= 50 ? '#eab308' : '#f43f5e');
      
      const lastSession = getLastSession();
      const recentSessions = getRecentSessions();
      
      let specialtyStats = [];
      for (const [sub, stat] of Object.entries(subjectStats)) {
          if (sub === "Uncategorized") continue;
          let specScore = stat.answered > 0 ? Math.round((stat.correct / stat.answered) * 100) : 0;
          specialtyStats.push({ name: sub, total: stat.total, answered: stat.answered, score: specScore });
      }
      specialtyStats.sort((a, b) => b.answered - a.answered || b.total - a.total);
      
      let specialtyHtml = '';
      if (specialtyStats.length > 0) {
        const topSpecs = specialtyStats.slice(0, 4);
        topSpecs.forEach(spec => {
          let colorClass = spec.score >= 80 ? 'bg-primary' : (spec.score >= 50 ? 'bg-primary/70' : 'bg-error/70');
          specialtyHtml += `
            <div>
              <div class="flex justify-between text-sm mb-1">
                <span class="font-medium">${window.escapeHtml ? window.escapeHtml(spec.name) : spec.name}</span>
                <span class="text-on-surface-variant">${spec.score}% (${spec.answered}/${spec.total})</span>
              </div>
              <div class="w-full bg-surface-container rounded-full h-2">
                <div class="${colorClass} h-2 rounded-full" style="width: ${spec.score}%"></div>
              </div>
            </div>`;
        });
      } else {
        specialtyHtml = '<div class="text-on-surface-variant text-sm">No specialty data yet. Start practicing!</div>';
      }

      // Continuing Session HTML
      let continueSessionHtml = '';
      if (lastSession && lastSession.qbankId) {
        const lastBankName = lastSession.qbankName || "QBank";
        const lastSubject = lastSession.subject && lastSession.subject !== "All Subjects" ? lastSession.subject : "active";
        
        let subStat = subjectStats[lastSubject];
        let progPct = 0;
        let answeredStr = "Q0 / 0";
        if (subStat && subStat.total > 0) {
            progPct = Math.round((subStat.answered / subStat.total) * 100);
            answeredStr = `Q${subStat.answered} / ${subStat.total}`;
        } else {
            // Fallback to global if subject isn't active
            progPct = totalQuestions > 0 ? Math.round((totalAnswered / totalQuestions) * 100) : 0;
            answeredStr = `Q${totalAnswered} / ${totalQuestions}`;
        }
        
        continueSessionHtml = `
          <div class="mb-4">
              <h3 class="font-title-md text-[20px] mb-2 font-bold">Continue ${window.escapeHtml ? window.escapeHtml(lastSubject) : lastSubject}</h3>
              <p class="font-body-md opacity-90">${answeredStr}</p>
          </div>
          <div class="flex items-center gap-3 mb-6">
              <div class="h-1.5 flex-1 bg-surface-container-highest/30 rounded-full overflow-hidden">
                  <div class="h-full bg-on-primary rounded-full transition-all" style="width: ${progPct}%"></div>
              </div>
              <span class="text-sm font-bold">${progPct}%</span>
          </div>
          <div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest mt-auto">
              CONTINUE <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
          </div>
        `;
      } else {
        continueSessionHtml = `
          <div class="mb-4">
              <h3 class="font-title-md text-[20px] mb-2 font-bold">Start Session</h3>
              <p class="font-body-md opacity-90 mb-6">Start a new practice block.</p>
          </div>
          <div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest mt-auto">
              START <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
          </div>
        `;
      }

      // Review Incorrects HTML
      let incorrectBySubject = [];
      for (const [sub, stat] of Object.entries(subjectStats)) {
          let inc = stat.answered - stat.correct;
          if (inc > 0 && sub !== "Uncategorized") {
              incorrectBySubject.push({ name: sub, count: inc });
          }
      }
      incorrectBySubject.sort((a,b) => b.count - a.count);
      
      let reviewIncorrectsHtml = '';
      if (incorrectBySubject.length > 0) {
          const topInc = incorrectBySubject.slice(0, 3);
          const totalInc = incorrectBySubject.reduce((sum, item) => sum + item.count, 0);
          
          let breakdown = '';
          topInc.forEach(inc => {
              breakdown += `<div class="text-sm text-on-surface-variant mb-1 flex items-center gap-2"><span class="font-bold text-on-surface w-6 text-right">${inc.count}</span> <span class="truncate">${window.escapeHtml ? window.escapeHtml(inc.name) : inc.name}</span></div>`;
          });
          
          reviewIncorrectsHtml = `
            <div class="mb-4">
                <h3 class="font-title-md text-[20px] mb-2 font-bold text-primary">Review Incorrects</h3>
                <p class="font-body-md font-bold mb-3">${totalInc} questions</p>
                <div class="flex flex-col">${breakdown}</div>
            </div>
            <div class="flex items-center gap-2 font-label-caps text-label-caps text-primary tracking-widest mt-auto pt-4">
                REVIEW <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
            </div>
          `;
      } else {
          reviewIncorrectsHtml = `
            <div class="mb-4">
                <h3 class="font-title-md text-[20px] mb-2 font-bold text-primary">Review Incorrects</h3>
                <p class="font-body-md font-bold text-primary mb-2">You're all caught up 🎉</p>
                <p class="font-body-md text-on-surface-variant text-sm">No incorrect questions waiting for review.</p>
            </div>
            <div class="flex items-center gap-2 font-label-caps text-label-caps text-primary tracking-widest mt-auto pt-4">
                START NEW BLOCK <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
            </div>
          `;
      }
      
      // Weak Areas HTML
      let weakAreas = specialtyStats.filter(s => s.answered > 0).sort((a, b) => a.score - b.score).slice(0, 3);
      let weakAreasHtml = '';
      if (weakAreas.length > 0) {
          let list = '';
          weakAreas.forEach(wa => {
              list += `
              <div class="mb-3 last:mb-0">
                  <div class="flex justify-between text-sm mb-1">
                      <span class="font-medium truncate mr-2">${window.escapeHtml ? window.escapeHtml(wa.name) : wa.name}</span>
                      <span class="text-on-surface-variant">${wa.score}%</span>
                  </div>
                  <div class="w-full bg-surface-container rounded-full h-1.5">
                      <div class="bg-[var(--accent-purple)] h-1.5 rounded-full transition-all" style="width: ${wa.score}%"></div>
                  </div>
              </div>`;
          });
          weakAreasHtml = `
            <div class="mb-4 flex-1 w-full">
                <h3 class="font-title-md text-[20px] mb-2 font-bold" style="color:var(--accent-purple);">Weak Areas</h3>
                <p class="text-xs text-on-surface-variant mb-4">Topics where you need the most practice</p>
                <div class="flex flex-col w-full">${list}</div>
            </div>
            <div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest mt-auto pt-2" style="color:var(--accent-purple);">
                PRACTICE WEAK AREAS <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
            </div>
          `;
      } else {
          weakAreasHtml = `
            <div class="mb-4 flex-1">
                <h3 class="font-title-md text-[20px] mb-2 font-bold" style="color:var(--accent-purple);">Weak Areas</h3>
                <p class="text-sm text-on-surface-variant mt-4">Answer more questions to reveal your weak areas.</p>
            </div>
            <div class="flex items-center gap-2 font-label-caps text-label-caps tracking-widest mt-auto pt-2" style="color:var(--accent-purple);">
                BROWSE SUBJECTS <span class="material-symbols-outlined text-[16px] group-hover:translate-x-1 transition-transform">arrow_forward</span>
            </div>
          `;
      }
      
      let recentActivityHtml = '';
      if (recentSessions && recentSessions.length > 0) {
        recentSessions.forEach(rs => {
            const timeDiff = Date.now() - (rs.timestamp || Date.now());
            let timeStr = 'just now';
            const mins = Math.floor(timeDiff / 60000);
            if (mins > 0 && mins < 60) timeStr = `${mins}m ago`;
            else if (mins >= 60 && mins < 1440) timeStr = `${Math.floor(mins / 60)}h ago`;
            else if (mins >= 1440) timeStr = `${Math.floor(mins / 1440)}d ago`;

            let subStat = subjectStats[rs.subject];
            let score = 0;
            if (subStat && subStat.answered > 0) {
                score = Math.round((subStat.correct / subStat.answered) * 100);
            } else if (rs.subject === "All Subjects") {
                score = globalScore;
            }
            
            const colorClass = score >= 80 ? 'bg-primary' : (score >= 50 ? 'bg-primary/70' : 'bg-error/70');
            const icon = rs.subject === "All Subjects" ? "dashboard" : "psychology";

            recentActivityHtml += `
            <div class="flex items-center p-3 rounded-xl hover:bg-surface-container transition-colors group cursor-pointer" onclick="window.startQBankSession('${rs.qbankId}', '${window.escapeHtml ? window.escapeHtml(rs.qbankName) : rs.qbankName}', '${window.escapeHtml ? window.escapeHtml(rs.subject) : rs.subject}')">
              <div class="w-10 h-10 rounded-full bg-primary-container/30 flex items-center justify-center mr-3">
                <span class="material-symbols-outlined text-primary text-sm">${icon}</span>
              </div>
              <div class="flex-1 min-w-0">
                <h4 class="font-title-md text-sm text-on-surface truncate">${window.escapeHtml ? window.escapeHtml(rs.subject) : rs.subject}</h4>
                <div class="flex items-center gap-2 mt-1">
                  <div class="h-1 w-12 bg-surface-container-highest rounded-full overflow-hidden">
                    <div class="h-full ${colorClass} rounded-full" style="width: ${score}%"></div>
                  </div>
                  <span class="font-label-sm text-[10px] text-on-surface-variant">${score}%</span>
                </div>
              </div>
              <span class="font-label-sm text-[10px] text-on-surface-variant opacity-60 group-hover:opacity-100 transition-opacity whitespace-nowrap">${timeStr}</span>
            </div>
            `;
        });
      } else {
          recentActivityHtml = `<div class="text-on-surface-variant text-sm p-4 text-center">No recent sessions yet. Start practicing!</div>`;
      }

      let resourcesHtml = '';
      if (activeQBankMeta.resources && activeQBankMeta.resources.length > 0) {
        let normalizedResources = [];
        let uncategorized = [];
        
        activeQBankMeta.resources.forEach(r => {
            if (r.isCategory) {
                normalizedResources.push(r);
            } else {
                uncategorized.push(r);
            }
        });
        if (uncategorized.length > 0) {
            normalizedResources.push({ id: 'cat-general', isCategory: true, title: 'General Resources', items: uncategorized });
        }
        
        let catsHtml = normalizedResources.map(cat => {
            if (!cat.items || cat.items.length === 0) return '';
            let itemsHtml = cat.items.map(r => {
                let icon = 'link';
                let color = 'text-primary';
                let action = `href="${window.escapeHtml ? window.escapeHtml(r.url) : r.url}" target="_blank"`;
                
                if (r.type === 'youtube') { 
                    icon = 'play_circle'; 
                    color = 'text-[#ef4444]'; 
                    action = `href="javascript:void(0)" onclick="window.openYouTubeModal('${r.url}')"`;
                }
                if (r.type === 'pdf') { icon = 'picture_as_pdf'; color = 'text-[#3b82f6]'; }
                if (r.type === 'flashcards') { icon = 'style'; color = 'text-[#eab308]'; }
                
                return `
                <a ${action} class="flex items-center gap-3 p-4 rounded-xl bg-surface-container hover:bg-surface-container-high transition-colors group border border-transparent hover:border-outline-variant/30">
                  <div class="w-10 h-10 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
                    <span class="material-symbols-outlined ${color}">${icon}</span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <h4 class="font-title-sm text-sm text-on-surface truncate font-medium">${window.escapeHtml ? window.escapeHtml(r.title || r.url) : (r.title || r.url)}</h4>
                    ${r.description ? `<p class="text-xs text-on-surface-variant truncate opacity-80 mt-1">${window.escapeHtml(r.description)}</p>` : ''}
                  </div>
                  <span class="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity -translate-x-2 group-hover:translate-x-0">open_in_new</span>
                </a>
                `;
            }).join('');
            
            return `
            <div class="mb-6 last:mb-0">
              <h4 class="text-sm font-label-caps text-on-surface-variant tracking-wider uppercase mb-3 px-1">${window.escapeHtml ? window.escapeHtml(cat.title) : cat.title}</h4>
              <div class="flex flex-col gap-2">
                ${itemsHtml}
              </div>
            </div>
            `;
        }).join('');
        
        resourcesHtml = `
        <div class="flex flex-col mt-6" id="qbank-resources-widget">
          <div class="flex items-center justify-between mb-4">
            <h2 class="font-headline-lg text-[20px] text-on-surface flex items-center gap-2">
                <span class="material-symbols-outlined text-primary">auto_stories</span> Study Resources
            </h2>
          </div>
          <div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30">
            ${catsHtml}
          </div>
        </div>
        `;
      }

      let safeBankName = activeQBankName.replace(/'/g, "\\'");
      
      const flagMap = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma" };
      let flagHtml = '';
      let smallFlagHtml = '';
      if (activeQBankMeta && activeQBankMeta.country && activeQBankMeta.country !== "global") {
          const countryCode = flagMap[activeQBankMeta.country];
          if (countryCode) {
              flagHtml = `<img src="https://flagcdn.com/${countryCode}.svg" alt="${countryCode}" style="height:32px; width:auto; border-radius:4px; box-shadow:0 2px 6px rgba(0,0,0,0.15);" class="inline-block mr-3 align-text-bottom">`;
              smallFlagHtml = `<img src="https://flagcdn.com/${countryCode}.svg" alt="${countryCode}" style="height:13px; width:auto; border-radius:2px;" class="inline-block mr-1.5 align-middle">`;
          }
      }
      
      const hour = new Date().getHours();
      let greeting = "Good morning";
      if (hour >= 12 && hour < 17) greeting = "Good afternoon";
      else if (hour >= 17) greeting = "Good evening";

      let firstName = "Doctor";
      const headerNameEl = document.getElementById("header-user-name");
      if (headerNameEl && headerNameEl.innerText) {
          let full = headerNameEl.innerText.replace(/Dr\.?\s+/i, "").trim();
          firstName = full.split(" ")[0] || "Doctor";
      }

      // CLINICAL DASHBOARD REDESIGN
      let isSessionCompleted = false;
      let lastSubject = "All Subjects";
      let progPct = 0;
      let answeredStr = "Q0 / 0";
      let subStat = null;

      if (lastSession && lastSession.qbankId) {
          lastSubject = lastSession.subject && lastSession.subject !== "All Subjects" ? lastSession.subject : "All Subjects";
          subStat = subjectStats[lastSubject];
          if (subStat && subStat.total > 0) {
              progPct = Math.round((subStat.answered / subStat.total) * 100);
              answeredStr = `Q${subStat.answered} / ${subStat.total}`;
          } else {
              progPct = totalQuestions > 0 ? Math.round((totalAnswered / totalQuestions) * 100) : 0;
              answeredStr = `Q${totalAnswered} / ${totalQuestions}`;
          }
          if (progPct >= 100) isSessionCompleted = true;
      }

      // Calculate correct/incorrect
      let totalIncorrect = totalAnswered - totalCorrect;
      let totalUnused = Math.max(0, totalQuestions - totalAnswered);
      
      let pctCorrect = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;
      let pctIncorrect = totalQuestions > 0 ? (totalIncorrect / totalQuestions) * 100 : 0;
      let pctUnused = totalQuestions > 0 ? (totalUnused / totalQuestions) * 100 : 100;

      const streakVal = window.studyGoals ? window.studyGoals.computeStreak() : 0;

      // Performance Overview - Donut Chart (new version)

      const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

      // Header Section
      let headerHtml = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:32px;">
          <div>
              <h1 style="font-size:24px; font-weight:bold; color:#1f2937; margin:0 0 4px 0;">Good ${greeting.toLowerCase().replace('good ', '')}, ${firstName} 👋</h1>
              <p style="color:#6b7280; font-size:14px; margin:0;">Keep going. Consistency today builds the doctor you want to be tomorrow.</p>
          </div>
          <div style="display:flex; align-items:center; gap:24px; text-align:right;">
              <div style="display:flex; align-items:center; gap:12px; background:#fff; padding:8px 16px; border-radius:8px; border:1px solid #e5e7eb; box-shadow:0 1px 2px rgba(0,0,0,0.02);">
                  <div style="background:#e6f2f2; width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center;">
                      <i class="fa-solid fa-fire" style="color:#007a7a; font-size:14px;"></i>
                  </div>
                  <div style="text-align:left;">
                      <div style="font-size:11px; color:#6b7280; font-weight:600; text-transform:uppercase;">Study Streak</div>
                      <div style="font-size:14px; font-weight:bold; color:#111827;">${streakVal} Days</div>
                  </div>
              </div>
              <div>
                  <div style="color:#6b7280; font-size:13px; margin-bottom:2px;">${dateStr}</div>
                  <div style="color:#9ca3af; font-size:12px;">Progress over perfection.</div>
              </div>
          </div>
      </div>
      `;

      // Continue Studying Card
      let continueCardHtml = '';
      if (lastSession && lastSession.qbankId && !isSessionCompleted) {
          const qlPct = subStat && subStat.total > 0 ? Math.round((subStat.answered / subStat.total) * 100) : 0;
          const subjScore = subStat && subStat.answered > 0 ? Math.round((subStat.correct / subStat.answered) * 100) : 0;
          const weakTopicsCount = Math.max(1, Math.min(5, Math.floor((100 - (subjScore || 50)) / 10)));
          
          continueCardHtml = `
          <div class="dash-card" style="display:flex; flex-direction:column;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
                  <h2 class="dash-card-title"><i class="fa-solid fa-book-open" style="color:#007a7a; margin-right:8px;"></i>Continue Studying</h2>
                  <a href="#" onclick="window.openExamPrepTab && window.openExamPrepTab(); return false;" style="color:#6b7280; font-size:12px; text-decoration:none; font-weight:500;">Change Session</a>
              </div>
              
              <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:24px;">
                  <div style="flex:1; display:flex; flex-direction:column;">
                      <div style="font-weight:800; color:#111827; font-size:18px; margin-bottom:8px;">${window.escapeHtml ? window.escapeHtml(lastSubject) : lastSubject}</div>
                      
                      <div style="color:#4b5563; font-size:14px; font-weight:500; margin-bottom:4px;">
                          <span style="color:#111827; font-weight:700;">${subStat ? subStat.answered : 0}</span> questions completed &middot; <span style="font-weight:700; color:${subjScore >= 70 ? '#10b981' : (subjScore >= 50 ? '#f59e0b' : '#e11d48')};">${subjScore}%</span> last score
                      </div>
                      <div style="color:#e11d48; font-size:14px; font-weight:600; margin-bottom:24px;">
                          ${weakTopicsCount} weak topics identified
                      </div>
                      
                      <div style="margin-top:auto;">
                          <button onclick="window.qbankContinueLast()" style="background:transparent; border:1px solid #007a7a; color:#007a7a; border-radius:6px; padding:8px 24px; font-weight:600; font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; transition:all 0.2s;" onmouseover="this.style.background='#007a7a'; this.style.color='#fff';" onmouseout="this.style.background='transparent'; this.style.color='#007a7a';">
                              Continue Session <i class="fa-solid fa-arrow-right"></i>
                          </button>
                      </div>
                  </div>
                  
                  <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:16px; width:220px; flex-shrink:0;">
                      <div style="font-size:12px; color:#6b7280; font-weight:700; text-transform:uppercase; margin-bottom:8px; letter-spacing:0.5px;">Next Up</div>
                      <div style="font-weight:700; color:#111827; font-size:14px; margin-bottom:12px;">${lastSubject === "All Subjects" ? "Mixed Review Block" : "Priority Topic Review"}</div>
                      
                      <div style="display:flex; flex-direction:column; gap:8px;">
                          <div style="color:#4b5563; font-size:13px; display:flex; align-items:center; gap:8px;">
                              <i class="fa-solid fa-list-check text-gray-400 w-4 text-center"></i> Estimated 15 Qs
                          </div>
                          <div style="color:#4b5563; font-size:13px; display:flex; align-items:center; gap:8px;">
                              <i class="fa-regular fa-clock text-gray-400 w-4 text-center"></i> ~12 min
                          </div>
                      </div>
                  </div>
              </div>
          </div>
          `;
      } else {
          continueCardHtml = `
          <div class="dash-card">
              <h2 class="dash-card-title"><i class="fa-solid fa-book-open" style="color:#007a7a; margin-right:8px;"></i>Continue Studying</h2>
              <div style="margin-top:20px; text-align:center; color:#6b7280; font-size:14px;">
                  Ready to dive in? Start a new session to track your progress.
              </div>
              <div style="text-align:center; margin-top:16px;">
                  <button onclick="window.openExamPrepTab && window.openExamPrepTab()" style="background:#007a7a; color:white; border:none; border-radius:6px; padding:8px 24px; font-weight:600; font-size:13px; cursor:pointer;">
                      Start New Session
                  </button>
              </div>
          </div>
          `;
      }

      // Performance Card
      let strongestAreas = specialtyStats.filter(s => s.answered > 0).sort((a, b) => b.score - a.score);
      let topStrong = strongestAreas.length > 0 ? strongestAreas[0] : null;
      let topWeakPerf = weakAreas && weakAreas.length > 0 ? weakAreas[0] : null;
      
      let performanceCardHtml = `
      <div class="dash-card" style="display:flex; flex-direction:column;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
              <h2 class="dash-card-title"><i class="fa-solid fa-chart-column" style="color:#007a7a; margin-right:8px;"></i>Your Performance</h2>
              <select style="border:1px solid #e5e7eb; border-radius:6px; font-size:12px; color:#4b5563; padding:4px 8px; outline:none; background:white; cursor:pointer;">
                  <option>Last 30 days</option>
                  <option>All time</option>
              </select>
          </div>
          
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:24px; margin-bottom:24px;">
              <div style="display:flex; flex-direction:column; justify-content:center;">
                  <div style="font-size:32px; font-weight:800; color:#111827; line-height:1;">${globalScore}%</div>
                  <div style="color:#6b7280; font-size:13px; font-weight:500; margin-top:4px;">Average Score</div>
                  <div style="color:#10b981; font-size:11px; font-weight:600; margin-top:8px; display:flex; align-items:center; gap:4px;">
                      <i class="fa-solid fa-arrow-trend-up"></i> 4% <span style="color:#9ca3af; font-weight:400;">vs previous 30 days</span>
                  </div>
              </div>
              <div style="display:flex; flex-direction:column; gap:8px;">
                  <div style="display:flex; justify-content:space-between; font-size:13px;">
                      <span style="color:#4b5563; font-weight:500;">Attempted</span>
                      <span style="font-weight:700; color:#111827;">${totalAnswered}</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; font-size:13px;">
                      <span style="color:#4b5563; font-weight:500;">Correct</span>
                      <span style="font-weight:700; color:#10b981;">${totalCorrect}</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; font-size:13px;">
                      <span style="color:#4b5563; font-weight:500;">Incorrect</span>
                      <span style="font-weight:700; color:#e11d48;">${totalIncorrect}</span>
                  </div>
              </div>
          </div>
          
          <div style="border-top:1px solid #f3f4f6; padding-top:20px; display:flex; flex-direction:column; gap:12px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div style="display:flex; align-items:center; gap:8px;">
                      <i class="fa-solid fa-arrow-trend-down" style="color:#e11d48; width:16px; text-align:center;"></i>
                      <span style="color:#4b5563; font-size:13px; font-weight:500;">Weakest: ${topWeakPerf ? (window.escapeHtml ? window.escapeHtml(topWeakPerf.name) : topWeakPerf.name) : 'N/A'}</span>
                  </div>
                  <span style="font-weight:700; font-size:13px; color:#111827;">${topWeakPerf ? topWeakPerf.score + '%' : '--'}</span>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div style="display:flex; align-items:center; gap:8px;">
                      <i class="fa-solid fa-arrow-trend-up" style="color:#10b981; width:16px; text-align:center;"></i>
                      <span style="color:#4b5563; font-size:13px; font-weight:500;">Strongest: ${topStrong ? (window.escapeHtml ? window.escapeHtml(topStrong.name) : topStrong.name) : 'N/A'}</span>
                  </div>
                  <span style="font-weight:700; font-size:13px; color:#111827;">${topStrong ? topStrong.score + '%' : '--'}</span>
              </div>
          </div>
      </div>
      `;

      // Today's Focus Card
      let focusCardHtml = '';
      if (weakAreas && weakAreas.length > 0) {
          const topWeak = weakAreas[0];
          let recQs = 12;
          const wStat = subjectStats[topWeak.name];
          if (wStat) {
              const unused = Math.max(0, wStat.total - wStat.answered);
              recQs = unused > 0 ? Math.min(15, unused) : 10;
          }
          
          focusCardHtml = `
          <div class="dash-card" style="background: #f8fafc; display:flex; flex-direction:column; justify-content:center; border: 1px solid #e2e8f0;">
              <h2 class="dash-card-title" style="margin-bottom:12px; color:#007a7a;"><i class="fa-solid fa-microscope" style="margin-right:8px;"></i>Today's Focus</h2>
              <div style="font-size:16px; font-weight:700; color:#111827; margin-bottom:4px;">${window.escapeHtml ? window.escapeHtml(topWeak.name) : topWeak.name} &mdash; <span style="color:#e11d48; font-weight:600; font-size:14px;">Needs attention</span></div>
              <div style="color:#6b7280; font-size:13px; margin-bottom:16px;">
                  <i class="fa-solid fa-list-check" style="color:#9ca3af; margin-right:4px;"></i> ${recQs} questions recommended
              </div>
              <button onclick="window.startQBankSession('${activeQBankId}', '${safeBankName}', '${window.escapeHtml ? window.escapeHtml(topWeak.name).replace(/'/g, "\\'") : topWeak.name.replace(/'/g, "\\'")}')" style="background:transparent; border:1px solid #007a7a; color:#007a7a; border-radius:6px; padding:6px 16px; font-weight:600; font-size:13px; cursor:pointer; align-self:flex-start; transition:all 0.2s;" onmouseover="this.style.background='#007a7a'; this.style.color='#fff';" onmouseout="this.style.background='transparent'; this.style.color='#007a7a';">
                  Start Review &rarr;
              </button>
          </div>
          `;
      } else {
          focusCardHtml = `
          <div class="dash-card" style="background: #f8fafc; display:flex; flex-direction:column; justify-content:center; border: 1px solid #e2e8f0;">
              <h2 class="dash-card-title" style="margin-bottom:12px; color:#007a7a;"><i class="fa-solid fa-microscope" style="margin-right:8px;"></i>Today's Focus</h2>
              <div style="font-size:14px; color:#6b7280; margin-bottom:16px;">You're doing great! No immediate weak areas detected.</div>
              <button onclick="window.openExamPrepTab && window.openExamPrepTab()" style="background:transparent; border:1px solid #007a7a; color:#007a7a; border-radius:6px; padding:6px 16px; font-weight:600; font-size:13px; cursor:pointer; align-self:flex-start; transition:all 0.2s;" onmouseover="this.style.background='#007a7a'; this.style.color='#fff';" onmouseout="this.style.background='transparent'; this.style.color='#007a7a';">
                  Start Mixed Block &rarr;
              </button>
          </div>
          `;
      }

      // Quick Actions
      let quickActionsHtml = `
      <div class="dash-card full-width">
          <h2 class="dash-card-title"><i class="fa-solid fa-bolt" style="color:#007a7a; margin-right:8px;"></i>Quick Actions</h2>
          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; margin-top:16px;">
              <div onclick="window.openExamPrepTab && window.openExamPrepTab()" style="background:#f9fafb; border:1px solid #f3f4f6; border-radius:8px; padding:12px 16px; cursor:pointer; display:flex; align-items:center; gap:12px; transition:all 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.borderColor='#e5e7eb'; this.style.background='#f3f4f6';" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='#f3f4f6'; this.style.background='#f9fafb';">
                  <div style="background:#e6f2f2; width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                      <i class="fa-solid fa-book-open text-[#007a7a] text-[16px]"></i>
                  </div>
                  <div style="flex:1;">
                      <div style="font-weight:700; color:#111827; font-size:13px; margin-bottom:2px;">Start a New Session</div>
                      <div style="color:#6b7280; font-size:11px;">Customize your practice</div>
                  </div>
                  <i class="fa-solid fa-arrow-right text-[#007a7a] text-[12px] opacity-60"></i>
              </div>
              <div onclick="window.openFlashcardsExplorer && window.openFlashcardsExplorer()" style="background:#f9fafb; border:1px solid #f3f4f6; border-radius:8px; padding:12px 16px; cursor:pointer; display:flex; align-items:center; gap:12px; transition:all 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.borderColor='#e5e7eb'; this.style.background='#f3f4f6';" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='#f3f4f6'; this.style.background='#f9fafb';">
                  <div style="background:#e6f2f2; width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                      <i class="fa-solid fa-layer-group text-[#007a7a] text-[16px]"></i>
                  </div>
                  <div style="flex:1;">
                      <div style="font-weight:700; color:#111827; font-size:13px; margin-bottom:2px;">Review Flashcards</div>
                      <div style="color:#6b7280; font-size:11px;">Reinforce what you learn</div>
                  </div>
                  <i class="fa-solid fa-arrow-right text-[#007a7a] text-[12px] opacity-60"></i>
              </div>
              <div onclick="window.openPlanner && window.openPlanner()" style="background:#f9fafb; border:1px solid #f3f4f6; border-radius:8px; padding:12px 16px; cursor:pointer; display:flex; align-items:center; gap:12px; transition:all 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.borderColor='#e5e7eb'; this.style.background='#f3f4f6';" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='#f3f4f6'; this.style.background='#f9fafb';">
                  <div style="background:#e6f2f2; width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                      <i class="fa-regular fa-calendar text-[#007a7a] text-[16px]"></i>
                  </div>
                  <div style="flex:1;">
                      <div style="font-weight:700; color:#111827; font-size:13px; margin-bottom:2px;">View Study Plan</div>
                      <div style="color:#6b7280; font-size:11px;">Stay on track</div>
                  </div>
                  <i class="fa-solid fa-arrow-right text-[#007a7a] text-[12px] opacity-60"></i>
              </div>
          </div>
      </div>
      `;

      // Weakest Areas
      let weakestAreasHtml = '';
      if (weakAreas && weakAreas.length > 0) {
          let listHtml = '';
          weakAreas.slice(0, 3).forEach((w, index) => {
              const safeName = window.escapeHtml ? window.escapeHtml(w.name) : w.name;
              const safeNameClick = safeName.replace(/'/g, "\\'");
              listHtml += `
              <div onclick="window.startQBankSession('${activeQBankId}', '${safeBankName}', '${safeNameClick}')" style="margin-bottom:${index === Math.min(weakAreas.length - 1, 2) ? '0' : '12px'}; padding:12px 16px; border-radius:8px; border:1px solid #f3f4f6; background:#f9fafb; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor='#e5e7eb'; this.style.background='#f3f4f6';" onmouseout="this.style.borderColor='#f3f4f6'; this.style.background='#f9fafb';">
                  <div style="font-weight:700; color:#111827; font-size:14px; margin-bottom:4px;">
                      ${safeName} &mdash; <span style="color:#e11d48;">${w.score}%</span>
                  </div>
                  <div style="color:#6b7280; font-size:12px; font-weight:500; display:flex; justify-content:space-between; align-items:center;">
                      <span>${w.answered || 0} questions attempted</span>
                      <span style="color:#007a7a; font-weight:600;">Review now &rarr;</span>
                  </div>
              </div>
              `;
          });

          weakestAreasHtml = `
          <div class="dash-card" style="display:flex; flex-direction:column;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
                  <h2 class="dash-card-title"><i class="fa-solid fa-bullseye" style="color:#e11d48; margin-right:8px;"></i>Weakest Areas</h2>
                  <a href="#" onclick="window.openPerformance && window.openPerformance(); return false;" style="color:#007a7a; font-size:12px; text-decoration:none; font-weight:500;">View All</a>
              </div>
              <div style="flex:1; display:flex; flex-direction:column; justify-content:center;">
                  ${listHtml}
              </div>
          </div>
          `;
      } else {
          weakestAreasHtml = `
          <div class="dash-card" style="display:flex; flex-direction:column;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
                  <h2 class="dash-card-title"><i class="fa-solid fa-bullseye" style="color:#e11d48; margin-right:8px;"></i>Weakest Areas</h2>
              </div>
              <div style="flex:1; display:flex; align-items:center; justify-content:center; color:#6b7280; font-size:13px;">
                  Not enough data yet. Keep practicing!
              </div>
          </div>
          `;
      }

      let plannerInlineHtml = `
        <div id="dashboard-planner-inline" style="margin-bottom: 24px;"></div>
      `;

      let html = `
        <div class="p-gutter w-full animate-[fade-in_0.5s_ease-out] max-w-[1200px] mx-auto" style="padding-top:32px; padding-bottom:64px;">
            ${plannerInlineHtml}
            ${headerHtml}
            
            <div class="dashboard-grid">
                ${continueCardHtml}
                ${focusCardHtml}
                ${performanceCardHtml}
                ${weakestAreasHtml}
                ${quickActionsHtml}
            </div>
        </div>
        <style>
        .dashboard-grid {
            display: grid;
            grid-template-columns: 2fr 1fr;
            grid-gap: 20px;
        }
        .full-width {
            grid-column: 1 / -1;
        }
        .dash-card {
            background: #fff;
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);
            border: 1px solid #f3f4f6;
        }
        .dash-card-title {
            font-size: 14px;
            font-weight: 700;
            color: #111827;
            margin: 0;
            display: flex;
            align-items: center;
        }
        @media (max-width: 1024px) {
            .dashboard-grid {
                grid-template-columns: 1fr;
            }
        }
        @keyframes fade-in {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        </style>
      `;
      area.innerHTML = html;
      // Attach renderDashboardPlannerWidget
      if (window.renderDashboardPlannerWidget) window.renderDashboardPlannerWidget();

      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      if (window.hideGlobalLoader) window.hideGlobalLoader();
      
    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load QBanks: ${e.message}</div>`;
      if (window.hideGlobalLoader) window.hideGlobalLoader();
    }
  };

  // --- Browse All Banks (original category grid) ---
  window.openQBankCategories = function () {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    
    if (!qbanks || qbanks.length === 0) {
      area.innerHTML = '<div style="padding:40px;text-align:center;color:#6b7280;">No QBanks available.</div>';
      return;
    }
    
    let html = `<div style="max-width:1400px; margin:0 auto; padding:40px 20px;">
      <div style="display:flex; align-items:center; margin-bottom:30px;">
        <button style="background:#f8fafc; border:1px solid #e2e8f0; color:#111827; border-radius:999px; padding:8px 16px; margin-right:15px; display:flex; align-items:center; gap:8px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'" onclick="window.openQBank()">
          <i data-lucide="arrow-left" style="width:16px;height:16px;"></i> Home
        </button>
        <div>
          <h2 style="margin:0; font-size:1.5rem; font-weight:700; color:#111827;">Choose Your Exam</h2>
          <p style="margin:4px 0 0 0; font-size:0.9rem; color:#6b7280;">Select from ${qbanks.length} available question bank${qbanks.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:24px;">`;
    
    const flagMap = { usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma" };
    for (const q of qbanks) {
      const countryCode = flagMap[q.country];
      const flagHtml = countryCode 
         ? `<img src="https://flagcdn.com/w80/${countryCode}.png" alt="${countryCode}" style="width:64px; height:auto; border-radius:4px; margin-bottom:20px; box-shadow:0 1px 3px rgba(0,0,0,0.1);">`
         : `<div style="font-size:4rem; margin-bottom:20px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); line-height:1;">🌍</div>`;
         
      // Show question count if cached
      const cached = cachedQBanks[q.id];
      const qCount = cached ? (cached.questions || []).length : 0;
      const countLabel = qCount > 0 ? `<div style="font-size:0.85rem; color:#6b7280; margin-bottom:12px;">${qCount.toLocaleString()} questions</div>` : '';
         
      html += `
        <div class="qbank-exam-card" style="background:#fff; border:1px solid #e2e8f0; border-radius:20px; padding:32px 24px; cursor:pointer; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); display:flex; flex-direction:column; align-items:center; text-align:center; position:relative; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.05);" onclick="window.startQBankSession('${q.id}', '${window.escapeHtml ? window.escapeHtml(q.name).replace(/'/g, "\\\\'") : q.name.replace(/'/g, "\\\\'")}')" onmouseover="this.style.transform='translateY(-4px)'; this.style.borderColor='#007a7a'; this.style.boxShadow='0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)';" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='#e2e8f0'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';">
           ${flagHtml}
           <h3 style="font-size:1.4rem; font-weight:700; margin-bottom:8px; color:#111827; letter-spacing:0.2px;">${window.escapeHtml ? window.escapeHtml(q.name) : q.name}</h3>
           ${countLabel}
           <div style="color:#007a7a; font-size:0.95rem; font-weight:600; display:flex; align-items:center; gap:8px; margin-top:auto; padding-top:15px; text-transform:uppercase; letter-spacing:1px;">
             <span>Start Practicing</span>
             <i data-lucide="arrow-right" style="width:18px;height:18px;"></i>
           </div>
        </div>`;
    }
    
    html += `</div></div>`;
    area.innerHTML = html;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  // --- Continue last session ---
  window.qbankContinueLast = function () {
    const last = getLastSession();
    if (!last || !last.qbankId) { window.openQBankCategories(); return; }
    window.qbankResumeSession(last.qbankId, last.qbankName, last.subject);
  };

  // --- Resume a specific session ---
  window.qbankResumeSession = async function (qbankId, qbankName, subject) {
    if (!qbankId) { window.openQBankCategories(); return; }
    
    // Ensure data is loaded
    if (!cachedQBanks[qbankId]) {
      await window.startQBankSession(qbankId, qbankName || "QBank");
      // After session loads, filter to subject if needed
      if (subject && subject !== "All Subjects") {
        window.startQBankFiltered(subject);
      }
    } else {
      currentQBankId = qbankId;
      window.isQBankAdmin = window.checkAdmin ? await window.checkAdmin() : false;
      const qData = cachedQBanks[qbankId];
      allQuestions = qData.questions;
      window.qbankProgress = qData.progress;
      document.getElementById("qbank-active-name").textContent = qbankName || "QBank";
      
      if (subject && subject !== "All Subjects") {
        window.startQBankFiltered(subject);
      } else {
        window.startQBankFiltered(null);
      }
    }
  };

  // --- Continue Marked Questions ---
  window.qbankContinueMarked = async function () {
    // Gather all marked questions across all banks
    let markedQuestions = [];
    let firstBankId = null;
    
    for (const qb of qbanks) {
      const data = cachedQBanks[qb.id];
      if (!data) continue;
      const prog = data.progress || {};
      
      for (const q of (data.questions || [])) {
        if (prog[q.id] && prog[q.id].marked) {
          markedQuestions.push(q);
          if (!firstBankId) firstBankId = qb.id;
        }
      }
    }
    
    if (markedQuestions.length === 0) {
      alert("No marked questions found. Mark questions during practice by clicking the bookmark button.");
      return;
    }
    
    // Use the first bank's ID for context
    currentQBankId = firstBankId;
    window.isQBankAdmin = window.checkAdmin ? await window.checkAdmin() : false;
    
    // Merge progress from all banks
    window.qbankProgress = {};
    for (const qb of qbanks) {
      const data = cachedQBanks[qb.id];
      if (data && data.progress) Object.assign(window.qbankProgress, data.progress);
    }
    
    allQuestions = markedQuestions;
    currentQuestions = [...markedQuestions];
    currentIndex = 0;
    window.currentQuestions = currentQuestions;
    window.currentIndex = currentIndex;
    
    document.getElementById("qbank-active-name").textContent = "Marked Questions";
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "flex";
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "flex";
    
    window.qbankRenderCurrent();
  };

  // ---- Cache invalidation after admin edits ----
  // Keeps the in-session question store in sync with Firestore so question
  // pages and ID search always show the latest saved content.
  window.qbankPatchCachedQuestion = function(qbankId, questionId, questionText, dataObj) {
    const entry = cachedQBanks[qbankId];
    if (!entry || !Array.isArray(entry.questions)) return;
    const q = entry.questions.find(x => x.id === questionId);
    if (!q) return;
    if (questionText !== undefined) q.text = questionText;
    if (dataObj !== undefined) q.data = dataObj;
    q.highlightedHTML = null;
  };

  window.qbankRemoveCachedQuestion = function(qbankId, questionId) {
    const entry = cachedQBanks[qbankId];
    if (!entry || !Array.isArray(entry.questions)) return;
    const i = entry.questions.findIndex(x => x.id === questionId);
    if (i !== -1) entry.questions.splice(i, 1);
  };

  // ---- Question lookup by Firestore id or human code (used by home search) ----
  // ALWAYS resolves via the server (Firestore = source of truth), so results
  // reflect admin edits instantly. No client cache involvement.
  window.qbankFindByRef = async function(term, preferBankId) {
    term = String(term || "").trim();
    if (!term || !/^[A-Za-z0-9_-]{3,64}$/.test(term)) return null;
    try {
      // Search the preferred bank (or current one) first — most likely hit
      const params = { ref: term };
      const hint = preferBankId || currentQBankId;
      if (hint) params.qbankId = hint;
      const res = await apiGet("get_question", params);
      if (!res || !res.question) return null;
      const qd = res.question;
      // Patch ONLY the in-memory entry — never overwrite the IndexedDB bank
      // cache with a single question (that previously shrank whole banks).
      try {
        const entry = cachedQBanks[qd.qbankId];
        if (entry && Array.isArray(entry.questions)) {
          const i = entry.questions.findIndex(x => x.id === qd.id);
          if (i >= 0) entry.questions[i] = { id: qd.id, text: qd.text, data: qd.data };
          else entry.questions.push({ id: qd.id, text: qd.text, data: qd.data });
        } else {
          cachedQBanks[qd.qbankId] = { questions: [{ id: qd.id, text: qd.text, data: qd.data }], progress: {} };
        }
      } catch (e) { /* non-fatal */ }
      const nameOf = (bid) => ((cachedCategories || []).find(c => c.id === bid) || {}).name || bid;
      return {
        bankId: qd.qbankId,
        bankName: nameOf(qd.qbankId),
        question: { id: qd.id, text: qd.text, data: qd.data },
        alternatives: (res.alternatives || []).map(a => ({ bankId: a.qbankId, bankName: nameOf(a.qbankId) })),
      };
    } catch (e) {
      console.error("qbankFindByRef failed:", e);
      return null;
    }
  };

  // Opens exactly one question as a mini-session.
  window.qbankOpenSingle = async function(bankId, bankName, question) {
    currentQBankId = bankId;
    allQuestions = [question];
    currentQuestions = [question];
    window.currentQuestions = currentQuestions;
    window.isQBankAdmin = window.checkAdmin ? await window.checkAdmin() : false;

    window.qbankProgress = (cachedQBanks[bankId] && cachedQBanks[bankId].progress) || {};

    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "flex";
    const nameEl = document.getElementById("qbank-active-name");
    if (nameEl) nameEl.textContent = bankName || "";
    window.hideAllMainViews && window.hideAllMainViews();
    const view = document.getElementById("qbank-home-view");
    if (view) view.style.display = "flex";
    document.querySelectorAll('nav a').forEach(a => {
        a.classList.remove('border-primary', 'bg-primary/10', 'text-primary', 'font-bold');
        a.classList.add('border-transparent', 'text-on-surface-variant', 'font-medium');
    });
    const homeTab = document.querySelector('nav a[data-path="home"]');
    if (homeTab) {
        homeTab.classList.remove('border-transparent', 'text-on-surface-variant', 'font-medium');
        homeTab.classList.add('border-primary', 'bg-primary/10', 'text-primary', 'font-bold');
    }

    currentIndex = 0;
    sessionAnswers = [];
    window.currentIndex = 0;
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "flex";
    window.qbankRenderCurrent();
  };

  window.startQBankSession = async function (qbankId, qbankName, targetSubject = null, reviewIncorrectsOnly = false) {
    const area = document.getElementById("qbank-home-content");
    if (!area) return;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "none";
    
    if (window.hideAllMainViews) window.hideAllMainViews();
    const qbankView = document.getElementById("qbank-home-view");
    if (qbankView) qbankView.style.display = "flex";
    
    // We update the modal's title now so it's ready when they actually start practicing
    const activeNameEl = document.getElementById("qbank-active-name");
    if (activeNameEl) activeNameEl.textContent = qbankName;
    
    currentQBankId = qbankId;
    window.isQBankAdmin = window.checkAdmin ? await window.checkAdmin() : false;
    
    try {
      let qData = cachedQBanks[qbankId];
      if (!qData) {
         area.innerHTML = `
          <div class="flex flex-col justify-center items-center h-64 gap-4">
            <div class="press-wrapper" style="margin: 20px auto 0; display: flex; justify-content: center; align-items: center;">
                <div class="press">
                  <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div>
                  <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div>
                  <div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div>
                </div>
            </div>
            <div class="text-on-surface-variant text-sm">Updating Questions</div>
          </div>`;
         const qCat = (cachedCategories || []).find(c => c.id === qbankId);
         const catUpdated = qCat ? qCat.updatedAt : 0;
         
         const idbData = await getCachedQBank(qbankId);
         if (idbData && idbData.updatedAt === catUpdated && idbData.questions && idbData.questions.length > 0) {
            const res = await apiGet("get_questions", { qbankId, onlyProgress: true });
            cachedQBanks[qbankId] = { questions: idbData.questions, progress: applyLocalQueueProgress(qbankId, res.progress || {}) };
         } else {
            const res = await apiGet("get_questions", { qbankId });
            cachedQBanks[qbankId] = { questions: res.questions || [], progress: applyLocalQueueProgress(qbankId, res.progress || {}) };
            setCachedQBank(qbankId, { updatedAt: catUpdated, questions: res.questions || [] });
         }
         
         qData = cachedQBanks[qbankId];
      }
      
      allQuestions = qData.questions;
      window.qbankProgress = qData.progress;
      const progress = window.qbankProgress;
      
      if (allQuestions.length === 0) {
        area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">This QBank is empty.</div>';
        return;
      }
      
      // Extract subjects and stats
      const subjectStats = {};
      let totalQ = 0;
      let totalAns = 0;
      let totalCorrect = 0;

      allQuestions.forEach(q => {
        const sub = (q.data && q.data.subject) || "Uncategorized";
        const chapter = (q.data && q.data.chapter) || null;
        
        if (!subjectStats[sub]) subjectStats[sub] = { total: 0, answered: 0, correct: 0, chapters: {} };
        subjectStats[sub].total++;
        totalQ++;
        
        if (chapter) {
            if (!subjectStats[sub].chapters[chapter]) subjectStats[sub].chapters[chapter] = { total: 0, answered: 0, correct: 0 };
            subjectStats[sub].chapters[chapter].total++;
        }
        
        if (progress[q.id] && progress[q.id].correct !== undefined) {
          subjectStats[sub].answered++;
          totalAns++;
          if (chapter) subjectStats[sub].chapters[chapter].answered++;
          
          if (progress[q.id].correct) {
             subjectStats[sub].correct++;
             totalCorrect++;
             if (chapter) subjectStats[sub].chapters[chapter].correct++;
          }
        }
      });
      
      let subjectList = Object.keys(subjectStats).filter(s => s !== "Uncategorized");
      subjectList.sort((a, b) => {
        const isCasA = a.toLowerCase().includes("cas clinique");
        const isCasB = b.toLowerCase().includes("cas clinique");
        if (isCasA && !isCasB) return -1;
        if (!isCasA && isCasB) return 1;
        return a.localeCompare(b);
      });
      
      window.qbankCurrentSubjectStats = subjectStats; // Save for chapter view
      
      if (targetSubject !== null || reviewIncorrectsOnly || (qbankName === "Answer Party" && !window.pendingPartyCreation)) {
          window.startQBankFiltered(targetSubject, null, reviewIncorrectsOnly);
          return;
      }
      
      if (subjectList.length === 0) {
        // No subjects, start directly
        window.startQBankFiltered(null);
      } else {
        const getScoreDisplay = (correct, answered) => {
           if (answered === 0) return { text: '0%', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' };
           const score = Math.round((correct / answered) * 100);
           const color = score >= 80 ? '#22c55e' : (score >= 50 ? '#eab308' : '#f43f5e');
           const bg = score >= 80 ? 'rgba(34,197,94,0.1)' : (score >= 50 ? 'rgba(234,179,8,0.1)' : 'rgba(244,63,94,0.1)');
           return { text: `${score}%`, color, bg };
        };

        const globalScoreUI = getScoreDisplay(totalCorrect, totalAns);

        // Show subject selection (extracted renderer)
        window.showQBankSubjects(qbankId);
      }

    } catch (e) {
      area.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);">Failed to load questions: ${e.message}</div>`;
    }
  };

  // Renders the sub-category ("subjects") grid for the active bank.
  // Relies on window.qbankCurrentSubjectStats computed by startQBankSession,
  // and currentQBankId / allQuestions being set.
  window.getSubjectDesign = function(sub) {
    const s = (sub || "").toLowerCase();
    const color = "var(--text-primary)";
    const bg = "transparent";
    if (s.includes("cardio") || s.includes("heart")) return { icon: "heart", color, bg };
    if (s.includes("neuro") || s.includes("brain") || s.includes("psych")) return { icon: "brain", color, bg };
    if (s.includes("pneumo") || s.includes("pulmo") || s.includes("lung") || s.includes("respira")) return { icon: "wind", color, bg };
    if (s.includes("gastro") || s.includes("hepato") || s.includes("digest") || s.includes("git") || s.includes("entero")) return { icon: "coffee", color, bg };
    if (s.includes("nephro") || s.includes("uro") || s.includes("kidney")) return { icon: "filter", color, bg };
    if (s.includes("ortho") || s.includes("rhumato") || s.includes("trauma") || s.includes("bone") || s.includes("osteo")) return { icon: "bone", color, bg };
    if (s.includes("pedia") || s.includes("child") || s.includes("neo")) return { icon: "baby", color, bg };
    if (s.includes("ophtalmo") || s.includes("eye") || s.includes("ophthal")) return { icon: "eye", color, bg };
    if (s.includes("orl") || s.includes("ear") || s.includes("ent")) return { icon: "ear", color, bg };
    if (s.includes("derma") || s.includes("skin")) return { icon: "sun", color, bg };
    if (s.includes("infect") || s.includes("microbio") || s.includes("bacterio") || s.includes("vir")) return { icon: "bug", color, bg };
    if (s.includes("hemato") || s.includes("blood") || s.includes("sang")) return { icon: "droplet", color, bg };
    if (s.includes("onco") || s.includes("cancer") || s.includes("tumor")) return { icon: "target", color, bg };
    if (s.includes("endocrin") || s.includes("hormon") || s.includes("diabet") || s.includes("meta")) return { icon: "activity", color, bg };
    if (s.includes("chirurg") || s.includes("surg")) return { icon: "scissors", color, bg };
    if (s.includes("gyneco") || s.includes("obste") || s.includes("woman") || s.includes("mater")) return { icon: "activity", color, bg };
    if (s.includes("urgences") || s.includes("reanima") || s.includes("emergenc") || s.includes("icu") || s.includes("soins inten")) return { icon: "zap", color, bg };
    if (s.includes("pharma") || s.includes("drug") || s.includes("thera")) return { icon: "pill", color, bg };
    if (s.includes("bio") || s.includes("lab")) return { icon: "test-tube", color, bg };
    if (s.includes("immuno")) return { icon: "shield", color, bg };
    if (s.includes("anatomy") || s.includes("physio")) return { icon: "user", color, bg };
    if (s.includes("cas clinique") || s.includes("clinical")) return { icon: "clipboard-list", color, bg };
    return { icon: "book-open", color, bg };
  };
  window.showQBankSubjects = async function(requestedQBankId = null) {
      // 1. Switch active view to qbank-home-view
      if (window.hideAllMainViews) window.hideAllMainViews();
      const view = document.getElementById("qbank-home-view");
      if (view) view.style.display = "flex";

      // 2. Update navigation active state
      document.querySelectorAll('nav a').forEach(a => {
          a.classList.remove('border-primary', 'bg-primary/10', 'text-primary', 'font-bold');
          a.classList.add('border-transparent', 'text-on-surface-variant', 'font-medium');
      });
      const browseTab = document.querySelector('nav a[data-path="browse"]');
      if (browseTab) {
          browseTab.classList.remove('border-transparent', 'text-on-surface-variant', 'font-medium');
          browseTab.classList.add('border-primary', 'bg-primary/10', 'text-primary', 'font-bold');
      }

      const area = document.getElementById("qbank-home-content");
      if (!area) return;
      
      const activeQBankId = requestedQBankId || currentQBankId || (window.db && window.db.selectedQBankId);
      if (!activeQBankId) { window.openQBank(); return; }

      // Make sure the QBank data is loaded
      if (!cachedQBanks[activeQBankId] || !cachedQBanks[activeQBankId].questions) {
          // Temporarily show a loader and fetch if not loaded
          area.innerHTML = `
          <div class="flex flex-col justify-center items-center h-64 gap-4">
            <div class="press-wrapper" style="margin: 20px auto 0; display: flex; justify-content: center; align-items: center;">
                <div class="press">
                  <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="roll"></div>
                  <div class="sheet"></div><div class="roll"></div><div class="sheet"></div><div class="sheet"></div>
                  <div class="sheet"></div><div class="sheet"></div><div class="sheet"></div><div class="roll"></div>
                </div>
            </div>
            <div class="text-on-surface-variant text-sm">Loading specialties...</div>
          </div>`;
          await window.openQBank(activeQBankId); 
          // openQBank will load the questions and overwrite the HTML, so we must call showQBankSubjects again
          setTimeout(() => window.showQBankSubjects(activeQBankId), 100);
          return;
      }

      // Set module-level allQuestions for startQBankFiltered
      allQuestions = cachedQBanks[activeQBankId].questions || [];
      window.qbankProgress = cachedQBanks[activeQBankId].progress || {};
      currentQBankId = activeQBankId;

      const questionsToUse = cachedQBanks[activeQBankId].questions;
      const progressToUse = cachedQBanks[activeQBankId].progress || {};
      const activeQBankName = (cachedCategories || []).find(qb => qb.id === activeQBankId)?.name || "Your QBank";
      const subSafeQbankId = window.escapeHtml ? window.escapeHtml(activeQBankId).replace(/'/g, "\\'") : activeQBankId;
      const subSafeQbankName = window.escapeHtml ? window.escapeHtml(activeQBankName).replace(/'/g, "\\'") : activeQBankName;

      const subjectStats = window.qbankCurrentSubjectStats || {};
      const getScoreDisplay = (correct, answered) => {
          if (answered === 0) return { text: '0%', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' };
          const score = Math.round((correct / answered) * 100);
          const color = score >= 80 ? '#22c55e' : (score >= 50 ? '#eab308' : '#f43f5e');
          const bg = score >= 80 ? 'rgba(34,197,94,0.1)' : (score >= 50 ? 'rgba(234,179,8,0.1)' : 'rgba(244,63,94,0.1)');
          return { text: `${score}%`, color, bg };
      };

      // Recompute stats fresh so progress is always current
      const stats = {};
      let totalAns = 0, totalCorrect = 0;
      questionsToUse.forEach(q => {
        const sub = (q.data && q.data.subject) || "Uncategorized";
        const chapter = (q.data && q.data.chapter) || null;
        if (!stats[sub]) stats[sub] = { total: 0, answered: 0, correct: 0, chapters: {} };
        stats[sub].total++;
        if (chapter) {
          if (!stats[sub].chapters[chapter]) stats[sub].chapters[chapter] = { total: 0, answered: 0, correct: 0 };
          stats[sub].chapters[chapter].total++;
        }
        const p = progressToUse[q.id];
        if (p && p.correct !== undefined) {
          stats[sub].answered++;
          totalAns++;
          if (chapter && stats[sub].chapters[chapter]) stats[sub].chapters[chapter].answered++;
          if (p.correct) {
            stats[sub].correct++; totalCorrect++;
            if (chapter && stats[sub].chapters[chapter]) stats[sub].chapters[chapter].correct++;
          }
        }
      });
      window.qbankCurrentSubjectStats = stats;

      let subjectList = Object.keys(stats).filter(x => x !== "Uncategorized");
      subjectList.sort((a, b) => {
        const isCasA = a.toLowerCase().includes("cas clinique");
        const isCasB = b.toLowerCase().includes("cas clinique");
        if (isCasA && !isCasB) return -1;
        if (!isCasA && isCasB) return 1;
        return a.localeCompare(b);
      });

      const globalScoreUI = getScoreDisplay(totalCorrect, totalAns);

      let html = `<div style="width:100%; max-width:1200px; margin:0 auto; padding:20px;">
          <div style="display:flex; align-items:center; margin-bottom:25px;">
             <button style="background:#f8fafc; border:1px solid #e2e8f0; color:#111827; border-radius:999px; padding:8px 16px; margin-right:15px; display:flex; align-items:center; gap:8px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'" onclick="window.openQBank()">
               <i data-lucide="arrow-left" style="width:16px;height:16px;"></i> Back
             </button>
             <h2 style="margin:0; font-size:1.5rem; font-weight:700; color:#111827;">Select Sub-Category</h2>
          </div>
          <input type="text" placeholder="Search sub-categories..." style="width:100%; margin-bottom:15px; padding:12px 16px; font-size:1rem; border-radius:12px; border:1px solid #e2e8f0; background:#fff; color:#111827; outline:none;" onfocus="this.style.borderColor='#007a7a'; this.style.boxShadow='0 0 0 3px rgba(0,122,122,0.1)'" onblur="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none'" oninput="window.filterQBankSubjects(this.value)">
          <div id="qbank-subject-list-container" style="display:flex; flex-direction:column; gap:16px;">
            <div style="position:relative; width:100%;">
            <button style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px 24px; text-align:left; justify-content:space-between; align-items:center; display:flex; width:100%; box-shadow:0 1px 3px rgba(0,0,0,0.05); cursor:pointer; transition:all 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';" onclick="window.startQBankFiltered(null)">
              <div style="display:flex; align-items:center; gap:20px;">
                <div style="width:48px; height:48px; border-radius:12px; background:#f8fafc; border:1px solid #e2e8f0; display:flex; align-items:center; justify-content:center;">
                  <i data-lucide="shuffle" style="width:24px; height:24px; color:#6b7280;"></i>
                </div>
                <div>
                  <div style="font-size:1.2rem; font-weight:600; color:#111827;">All Subjects (Mix)</div>
                  <div style="font-size:0.9rem; color:#6b7280; margin-top:4px;">Practice questions from all available subjects</div>
                </div>
              </div>
              <div style="display:flex; gap:24px; align-items:center;">
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Answered</div>
                  <div style="font-size:1rem; font-weight:500; color:#111827; margin-top:4px;">${totalAns} / ${questionsToUse.length}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Score</div>
                  <div style="font-size:1rem; font-weight:700; color:${globalScoreUI.color}; margin-top:4px; display:inline-block; background:${globalScoreUI.bg}; padding:2px 10px; border-radius:12px;">${globalScoreUI.text}</div>
                </div>
                <i data-lucide="chevron-right" style="width:20px;height:20px;color:#9ca3af;margin-left:10px;"></i>
              </div>
            </button>
            </div>` +
        subjectList.map(sub => {
            const st = stats[sub];
            const scoreUI = getScoreDisplay(st.correct, st.answered);
            const hasChapters = Object.keys(st.chapters || {}).length > 0;
            const subSafe = window.escapeHtml ? window.escapeHtml(sub).replace(/'/g, "\\'") : sub;
            let adminBtn = "";
            if (window.isQBankAdmin) {
               adminBtn = `<div style="position:absolute; top:-12px; left:80px; z-index:2; display:flex; gap:8px;">
                 <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#e11d48; border:1px solid #ffe4e6; background:#fff1f2; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminDeleteSubject('${subSafe}')"><i data-lucide="trash-2" style="width:12px;height:12px;margin-right:4px;"></i>Delete</button>
                 <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#8b5cf6; border:1px solid #ede9fe; background:#f5f3ff; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminMoveSubject('${subSafe}')"><i data-lucide="folder-input" style="width:12px;height:12px;margin-right:4px;"></i>Merge</button>
                 <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#0ea5e9; border:1px solid #e0f2fe; background:#f0f9ff; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminRenameSubject('${subSafe}')"><i data-lucide="edit-3" style="width:12px;height:12px;margin-right:4px;"></i>Rename</button>
               </div>`;
            }
            const design = window.getSubjectDesign(sub);
            return `
            <div style="position:relative; width:100%;">
            ${adminBtn}
            <button class="qbank-subject-btn" data-subject="${subSafe}" style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px 24px; text-align:left; justify-content:space-between; align-items:center; display:flex; width:100%; box-shadow:0 1px 3px rgba(0,0,0,0.05); cursor:pointer; transition:all 0.2s; position:relative; overflow:hidden;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';" onclick="${hasChapters ? `window.showQBankChapters('${subSafe}')` : `window.startQBankFiltered('${subSafe}', null)`}">
              <div style="display:flex; align-items:center; gap:20px; z-index:1;">
                <div style="width:48px; height:48px; border-radius:12px; background:${design.color}15; border:1px solid ${design.color}30; display:flex; align-items:center; justify-content:center;">
                  <i data-lucide="${design.icon}" style="width:24px; height:24px; color:${design.color};"></i>
                </div>
                <div>
                  <div style="font-size:1.2rem; font-weight:600; color:#111827;">${window.escapeHtml ? window.escapeHtml(sub) : sub}</div>
                  <div style="font-size:0.9rem; color:#6b7280; margin-top:4px;">${hasChapters ? 'View Chapters' : 'Start Subject'}</div>
                </div>
              </div>
              <div style="display:flex; gap:24px; align-items:center; z-index:1;">
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Answered</div>
                  <div style="font-size:1rem; font-weight:500; color:#111827; margin-top:4px;">${st.answered} / ${st.total}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Score</div>
                  <div style="font-size:1rem; font-weight:700; color:${scoreUI.color}; margin-top:4px; display:inline-block; background:${scoreUI.bg}; padding:2px 10px; border-radius:12px;">${scoreUI.text}</div>
                </div>
                <i data-lucide="${hasChapters ? 'folder' : 'chevron-right'}" style="width:20px;height:20px;color:#9ca3af;margin-left:10px;"></i>
              </div>
              <i data-lucide="${design.icon}" style="position:absolute; right:15%; top:-20px; width:120px; height:120px; opacity:0.03; color:${design.color}; pointer-events:none; transform:rotate(-15deg);"></i>
            </button>
            </div>`;
        }).join("") +
        `</div></div>`;
      area.innerHTML = html;
      document.getElementById("qbank-active-name") && (document.getElementById("qbank-active-name").textContent = document.getElementById("qbank-active-name").textContent || "QBank");
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      window.showQBankChaptersView = false;
  };

  
  window.showQBankChapters = function(subject) {
      const area = document.getElementById("qbank-home-content");
      if (!area) return;
      const stats = window.qbankCurrentSubjectStats[subject];
      if (!stats) return;
      
      const getScoreDisplay = (correct, answered) => {
          if (answered === 0) return { text: '0%', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' };
          const score = Math.round((correct / answered) * 100);
          const color = score >= 80 ? '#22c55e' : (score >= 50 ? '#eab308' : '#f43f5e');
          const bg = score >= 80 ? 'rgba(34,197,94,0.1)' : (score >= 50 ? 'rgba(234,179,8,0.1)' : 'rgba(244,63,94,0.1)');
          return { text: `${score}%`, color, bg };
      };
      
      const subSafe = window.escapeHtml ? window.escapeHtml(subject).replace(/'/g, "\\'") : subject;
      const globalScoreUI = getScoreDisplay(stats.correct, stats.answered);
      
      let html = `<div style="width:100%; max-width:1200px; margin:0 auto; padding:20px;">
          <div style="display:flex; align-items:center; margin-bottom:25px;">
             <button style="background:#f8fafc; border:1px solid #e2e8f0; color:#111827; border-radius:999px; padding:8px 16px; margin-right:15px; display:flex; align-items:center; gap:8px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'" onclick="window.showQBankSubjects()">
               <i data-lucide="arrow-left" style="width:16px;height:16px;"></i> Back to Subjects
             </button>
             <h2 style="margin:0; font-size:1.5rem; font-weight:700; color:#111827;">Chapters: ${window.escapeHtml ? window.escapeHtml(subject) : subject}</h2>
          </div>
          
          <input type="text" placeholder="Search chapters..." style="width:100%; margin-bottom:15px; padding:12px 16px; font-size:1rem; border-radius:12px; border:1px solid #e2e8f0; background:#fff; color:#111827; outline:none;" onfocus="this.style.borderColor='#007a7a'; this.style.boxShadow='0 0 0 3px rgba(0,122,122,0.1)'" onblur="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none'" oninput="window.filterQBankSubjects(this.value)">
          <div id="qbank-subject-list-container" style="display:flex; flex-direction:column; gap:16px;">
            <div style="position:relative; width:100%;">
            <button style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px 24px; text-align:left; justify-content:space-between; align-items:center; display:flex; width:100%; box-shadow:0 1px 3px rgba(0,0,0,0.05); cursor:pointer; transition:all 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';" onclick="window.startQBankFiltered('${subSafe}', null)">
              <div style="display:flex; align-items:center; gap:20px;">
                <div style="width:48px; height:48px; border-radius:12px; background:#f8fafc; border:1px solid #e2e8f0; display:flex; align-items:center; justify-content:center;">
                  <i data-lucide="shuffle" style="width:24px; height:24px; color:#6b7280;"></i>
                </div>
                <div>
                  <div style="font-size:1.2rem; font-weight:600; color:#111827;">All Chapters (Mix)</div>
                  <div style="font-size:0.9rem; color:#6b7280; margin-top:4px;">Practice questions from all chapters in this subject</div>
                </div>
              </div>
              <div style="display:flex; gap:24px; align-items:center;">
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Answered</div>
                  <div style="font-size:1rem; font-weight:500; color:#111827; margin-top:4px;">${stats.answered} / ${stats.total}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Score</div>
                  <div style="font-size:1rem; font-weight:700; color:${globalScoreUI.color}; margin-top:4px; display:inline-block; background:${globalScoreUI.bg}; padding:2px 10px; border-radius:12px;">${globalScoreUI.text}</div>
                </div>
                <i data-lucide="chevron-right" style="width:20px;height:20px;color:#9ca3af;margin-left:10px;"></i>
              </div>
            </button>
            </div>`;
            
      const chaptersList = Object.keys(stats.chapters).sort((a,b) => a.localeCompare(b));
      
      chaptersList.forEach(ch => {
          const chStats = stats.chapters[ch];
          const chSafe = window.escapeHtml ? window.escapeHtml(ch).replace(/'/g, "\\'") : ch;
          const scoreUI = getScoreDisplay(chStats.correct, chStats.answered);
          
          let adminBtn = "";
          if (window.isQBankAdmin) {
             adminBtn = `<div style="position:absolute; top:-12px; left:80px; z-index:2; display:flex; gap:8px;">
               <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#8b5cf6; border:1px solid #ede9fe; background:#f5f3ff; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminMoveChapter('${subSafe}', '${chSafe}')"><i data-lucide="folder-input" style="width:12px;height:12px;margin-right:4px;"></i>Merge</button>
               <button style="padding:4px 10px; font-size:0.75rem; font-weight:600; color:#0ea5e9; border:1px solid #e0f2fe; background:#f0f9ff; border-radius:999px; cursor:pointer; display:flex; align-items:center;" onclick="event.stopPropagation(); window.qbankAdminRenameChapter('${subSafe}', '${chSafe}')"><i data-lucide="edit-3" style="width:12px;height:12px;margin-right:4px;"></i>Rename</button>
             </div>`;
          }
          const design = window.getSubjectDesign(ch);
          html += `
            <div style="position:relative; width:100%;">
            ${adminBtn}
            <button class="qbank-subject-btn" data-subject="${chSafe}" style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px 24px; text-align:left; justify-content:space-between; align-items:center; display:flex; width:100%; box-shadow:0 1px 3px rgba(0,0,0,0.05); cursor:pointer; transition:all 0.2s; position:relative; overflow:hidden;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';" onclick="window.startQBankFiltered('${subSafe}', '${chSafe}')">
              <div style="display:flex; align-items:center; gap:20px; z-index:1;">
                <div style="width:48px; height:48px; border-radius:12px; background:${design.color}15; border:1px solid ${design.color}30; display:flex; align-items:center; justify-content:center;">
                  <i data-lucide="${design.icon}" style="width:24px; height:24px; color:${design.color};"></i>
                </div>
                <div>
                  <div style="font-size:1.1rem; font-weight:600; color:#111827;">${window.escapeHtml ? window.escapeHtml(ch) : ch}</div>
                  <div style="font-size:0.9rem; color:#6b7280; margin-top:4px;">Start Chapter</div>
                </div>
              </div>
              <div style="display:flex; gap:24px; align-items:center; z-index:1;">
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Answered</div>
                  <div style="font-size:1rem; font-weight:500; color:#111827; margin-top:4px;">${chStats.answered} / ${chStats.total}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.8rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-weight:600;">Score</div>
                  <div style="font-size:1rem; font-weight:700; color:${scoreUI.color}; margin-top:4px; display:inline-block; background:${scoreUI.bg}; padding:2px 10px; border-radius:12px;">${scoreUI.text}</div>
                </div>
                <i data-lucide="chevron-right" style="width:20px;height:20px;color:#9ca3af;margin-left:10px;"></i>
              </div>
              <i data-lucide="${design.icon}" style="position:absolute; right:15%; top:-20px; width:120px; height:120px; opacity:0.03; color:${design.color}; pointer-events:none; transform:rotate(-15deg);"></i>
            </button>
            </div>`;
      });
      
      html += `</div></div>`;
      area.innerHTML = html;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.filterQBankSubjects = function(query) {
    const q = (query || "").toLowerCase();
    const container = document.getElementById("qbank-subject-list-container");
    if (!container) return;
    const btns = container.querySelectorAll(".qbank-subject-btn");
    btns.forEach(btn => {
      const text = (btn.getAttribute("data-subject") || "").toLowerCase();
      if (text.includes(q)) {
        btn.style.display = "flex";
      } else {
        btn.style.display = "none";
      }
    });
  };

  window.startQBankFiltered = function(subject, chapter = null, reviewIncorrectsOnly = false) {
    // If subject contains a hyphen and chapter is not provided, try to parse them from the combined string (e.g. from last session)
    if (subject && !chapter && subject.includes(" - ")) {
        const parts = subject.split(" - ");
        const potentialSubject = parts[0];
        const isValid = window.qbankCurrentSubjectStats 
            ? !!window.qbankCurrentSubjectStats[potentialSubject]
            : allQuestions.some(q => q.data && q.data.subject === potentialSubject);
        if (isValid) {
            subject = potentialSubject;
            chapter = parts.slice(1).join(" - ");
        }
    }

    // Ensure allQuestions is populated from cached data
    if (allQuestions.length === 0) {
        const activeQBankId = window.db && window.db.selectedQBankId;
        if (activeQBankId && cachedQBanks[activeQBankId]) {
            allQuestions = cachedQBanks[activeQBankId].questions || [];
            window.qbankProgress = cachedQBanks[activeQBankId].progress || {};
            currentQBankId = activeQBankId;
        }
    }

    if (window.pendingPartyCreation) {
       window.pendingPartyCreation = false;
       window.QBankParty.createParty(currentQBankId, subject || "All").then(code => {
           window.QBankParty.attachParty(code);
           setTimeout(() => window.qbankToast("Answer Party Created! Invite Code: " + code), 500);
       }).catch(e => window.qbankToast(e.message, true));
       return;
    }
    // Save session for Continue feature
    const qbName = document.getElementById("qbank-active-name")?.textContent || "QBank";
    saveQBankSession(currentQBankId, qbName, chapter ? `${subject} - ${chapter}` : (subject || "All Subjects"));
    
    if (subject) {
      currentQuestions = allQuestions.filter(q => q.data && q.data.subject === subject);
      if (chapter) {
          currentQuestions = currentQuestions.filter(q => q.data && q.data.chapter === chapter);
      }
    } else {
      currentQuestions = [...allQuestions];
    }

    if (reviewIncorrectsOnly) {
        currentQuestions = currentQuestions.filter(q => {
            const p = window.qbankProgress[q.id];
            return p && (p.correct === false || p.marked === true);
        });
    }
    
    // 1. Sort by creation time to guarantee sequential order (vital for clinical cases)
    currentQuestions.sort((a, b) => {
       const t1 = (a.data && a.data.createdAt) ? a.data.createdAt : 0;
       const t2 = (b.data && b.data.createdAt) ? b.data.createdAt : 0;
       return t1 - t2;
    });

    // (Removed random shuffle to ensure stable question ordering across sessions)
    
    let firstUnsolved = 0;
    for (let i = 0; i < currentQuestions.length; i++) {
       const p = window.qbankProgress[currentQuestions[i].id] || {};
       if (p.correct === undefined) {
          firstUnsolved = i;
          break;
       }
    }
    
    currentIndex = firstUnsolved;
    window.currentQuestions = currentQuestions;
    window.currentIndex = currentIndex;
    
    const modal = document.getElementById("qbank-modal");
    if (modal) modal.style.display = "flex";
    
    const sidebar = document.getElementById("qbank-sidebar");
    if (sidebar) sidebar.style.display = "flex";

    window.qbankRenderCurrent();
    
    if (window.QBankParty && window.QBankParty.state.party && typeof window.qbankPartyStateChanged === 'function') {
        window.qbankPartyStateChanged(true, true);
    }
  };

  // Upgrades content images: capped height so they never dominate the
  // explanation box, hover hint, and click-to-zoom lightbox.
  window.qbankEnhanceImages = function(rootEl) {
    const root = rootEl || document;
    root.querySelectorAll(".qbank-rich img").forEach(img => {
      if (img.dataset.enhanced) return;
      img.dataset.enhanced = "1";
      img.style.maxWidth = "100%";
      img.style.maxHeight = "260px";
      img.style.width = "auto";
      img.style.height = "auto";
      img.style.borderRadius = "10px";
      img.style.cursor = "zoom-in";
      img.style.transition = "filter .15s ease";
      img.addEventListener("click", () => window.qbankOpenImageLightbox(img.src));
    });
    if (root.querySelector && root.querySelector(".qbank-rich img") && window.lucide && window.lucide.createIcons) {
      try { window.lucide.createIcons(); } catch (_) {}
    }
  };

  window.qbankOpenImageLightbox = function(src) {
    const old = document.getElementById("qbank-img-lightbox");
    if (old) old.remove();
    const lb = document.createElement("div");
    lb.id = "qbank-img-lightbox";
    lb.innerHTML = `
      <button type="button" class="qlb-close" title="Close (Esc)">×</button>
      <img src="${src}" alt="Enlarged image" />
      <div class="qlb-hint">Click anywhere or press Esc to close</div>
      <style>${QLB_CSS}</style>`;
    document.body.appendChild(lb);
    document.body.style.overflow = "hidden";
    const close = () => { lb.remove(); document.body.style.overflow = ""; };
    lb.addEventListener("click", close);
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });
  };

  const QLB_CSS = `
  #qbank-img-lightbox { position: fixed; inset: 0; z-index: 2147483000;
    background: rgba(4,12,16,0.92); backdrop-filter: blur(8px);
    display: flex; align-items: center; justify-content: center; padding: 40px;
    cursor: zoom-out; }
  #qbank-img-lightbox img { max-width: min(1100px, 92vw); max-height: 88vh;
    width: auto; height: auto; border-radius: 12px;
    box-shadow: 0 30px 90px rgba(0,0,0,0.7); cursor: default; }
  #qbank-img-lightbox .qlb-close { position: absolute; top: 18px; right: 22px;
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2);
    color: #fff; font-size: 26px; width: 42px; height: 42px; border-radius: 50%;
    cursor: pointer; line-height: 1; transition: background .15s ease; }
  #qbank-img-lightbox .qlb-close:hover { background: rgba(244,63,94,0.35); }
  #qbank-img-lightbox .qlb-hint { position: absolute; bottom: 20px; left: 50%;
    transform: translateX(-50%); color: rgba(255,255,255,0.55); font-size: 0.8rem;
    font-family: 'Figtree', sans-serif; }
  `;

  window.qbankJumpTo = function(idx) {
    if (idx < 0 || idx >= currentQuestions.length) return;
    
    const isParty = document.getElementById("qbank-party-sidebar")?.style.display !== "none";
    if (isParty) {
        if (!window.QBankParty || !window.QBankParty.state.isHost) {
            window.qbankToast("Only the host can jump to a different question during a party.", true);
            return;
        }
        const nextId = currentQuestions[idx].id;
        window.QBankParty.hostStartSession(nextId);
        return;
    }
    
    currentIndex = idx;
    window.currentIndex = currentIndex;
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
  };

  window.qbankRenderSidebar = function() {
    const container = document.getElementById("qbank-sidebar");
    if (!container) return;
    
    let html = "";
    currentQuestions.forEach((q, idx) => {
      const p = window.qbankProgress[q.id] || {};
      const isMarked = p.marked;
      const isAnswered = p.correct !== undefined;
      const isActive = idx === currentIndex;
      
      let cls = "usmle-sidebar-item";
      if (isActive) cls += " active";
      if (isAnswered) cls += " answered";
      if (isMarked) cls += " flagged";
      
      let icon = "";
      if (isAnswered) {
          icon = `<div style="position:absolute; bottom: -2px; right: -2px; width: 12px; height: 12px; background: #0e7c86; border-radius: 50%; box-shadow: 0 0 0 2px #ffffff; display: flex; align-items: center; justify-content: center;"><i data-lucide="check" style="width: 8px; height: 8px; color: #ffffff; stroke-width: 4px;"></i></div>`;
      }
      
      html += `<div class="${cls}" onclick="window.qbankJumpTo(${idx})">${idx + 1}${icon}</div>`;
    });
    
    container.innerHTML = html;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    
    // Auto scroll to active
    const activeEl = container.children[currentIndex];
    if (activeEl) {
       activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  if (!document.getElementById("uiverse-radio-styles")) {
    const style = document.createElement("style");
    style.id = "uiverse-radio-styles";
    style.innerHTML = `
      .qbank-radio-input label.uiverse-label {
        display: flex;
        background-color: var(--bg-elevated, #fff);
        padding: 16px 20px;
        margin: 10px 0;
        font-size: 1rem;
        font-weight: 600;
        border-radius: 12px;
        cursor: pointer;
        border: 2px solid var(--border-color, rgba(187, 187, 187, 0.2));
        color: var(--text-primary, #000);
        transition: .3s ease;
      }
      .qbank-radio-input label.uiverse-label:hover {
        background-color: var(--hover-bg, rgba(24, 24, 24, 0.05));
        border-color: var(--border-hover, #bbb);
      }
      .qbank-radio-input input:checked + label.uiverse-label {
        border-color: var(--accent-cyan, #2dd4bf);
        background-color: var(--accent-cyan-light, rgba(45, 212, 191, 0.05));
      }
    `;
    document.head.appendChild(style);
  }

  window.qbankRenderCurrent = function () {
    const area = document.getElementById("qbank-question-area");
    if (currentIndex >= currentQuestions.length) {
      stopTimer();
      area.innerHTML = `<div style="padding:60px; text-align:center;">
        <i data-lucide="check-circle" style="width:64px; height:64px; color:var(--accent-cyan); margin-bottom:20px;"></i>
        <h2>You have completed all questions in this session!</h2>
        <button class="btn-action primary" style="margin-top:20px; padding:12px 24px;" onclick="window.openQBank()">Return to QBank Home</button>
      </div>`;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      window.qbankEnhanceImages && window.qbankEnhanceImages(document.getElementById("qbank-modal"));
      return;
    }
    
    const q = currentQuestions[currentIndex];
    const data = q.data || {};
    
    const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    const isMultiple = correctIndices.length > 1;
    
    const inPartyMode = window.QBankParty && window.QBankParty.state.party;
    let optionsHtml = '';
    if (data.options) {
      // Get peer stats for this question
      const peerStats = window.qbankPeerStats && window.qbankPeerStats[q.id] || null;
      const peerThreshold = window.qbankPeerThreshold || 50;
      const isAdmin = window.isAdminCache || false;
      const showPeerStats = peerStats && peerStats.total >= peerThreshold;
      
      optionsHtml = data.options.map((opt, i) => {
        let peerPercent = '';
        
        // Admin always sees real percentages
        if (isAdmin && peerStats && peerStats.counts) {
          const count = peerStats.counts[i] || 0;
          const pct = peerStats.total > 0 ? Math.round((count / peerStats.total) * 100) : 0;
          peerPercent = `<span style="font-size:11px; color:#6b7280; margin-left:8px; font-weight:600;">${pct}%</span>`;
        }
        // Regular users only see percentages when threshold is met
        else if (showPeerStats && peerStats.counts) {
          const count = peerStats.counts[i] || 0;
          const pct = peerStats.total > 0 ? Math.round((count / peerStats.total) * 100) : 0;
          peerPercent = `<span style="font-size:11px; color:#6b7280; margin-left:8px; font-weight:600;">${pct}%</span>`;
        }
        // Otherwise show nothing (no "Pending", no "No data")
        
        return `
        <div class="qbank-radio-input" style="position:relative; width:100%;">
          <input type="${isMultiple ? 'checkbox' : 'radio'}" id="qbank-radio-input-${i}" name="qbank-radio" value="${i}" style="display:none;" ${!isMultiple && !inPartyMode ? 'onclick="event.preventDefault()"' : ''}>
          <label class="usmle-option qbank-option-btn uiverse-label" id="qbank-opt-${i}" for="qbank-radio-input-${i}" ${!isMultiple && !inPartyMode ? `onclick="window.qbankSelectOption(${i}); event.preventDefault();"` : ""} style="display:flex; align-items:flex-start; width:100%; box-sizing:border-box;">
            <span class="usmle-option-letter" style="margin-right:12px; font-weight:800; opacity:0.8;">${String.fromCharCode(65 + i)}</span>
            <span class="usmle-option-text" style="flex:1;">${window.renderRichText ? window.renderRichText(opt) : (window.escapeHtml ? window.escapeHtml(opt) : opt)}</span>
            ${peerPercent}
          </label>
        </div>`;
      }).join('');
    }
    
    // Fetch peer stats for this question (async, then update percentages)
    if (q.id && window.loadPeerStats && !window._peerStatsLoading) {
      window._peerStatsLoading = true;
      window.loadPeerStats(q.id).then(() => {
        window._peerStatsLoading = false;
        // Update percentages without re-rendering the whole question
        window._updatePeerPercentages(q.id);
      }).finally(() => {
        window._peerStatsLoading = false;
      });
    }

    let submitHtml = '';
    if (inPartyMode) {
      submitHtml = `<button id="qbank-submit-btn" class="btn-action primary" style="margin-top:10px; width:100%; padding:12px;" onclick="window.qbankPartyLockAnswer()">Lock Answer</button>`;
    } else if (isMultiple) {
      submitHtml = `<button id="qbank-submit-btn" class="btn-action primary" style="margin-top:10px; width:100%; padding:12px;" onclick="window.qbankSelectOption()">Submit Answer</button>`;
    }

    area.innerHTML = `
      <div id="qbank-split-container" style="display:flex; max-width:1400px; margin:0 auto; padding:20px; gap:24px; text-align:left; align-items:flex-start;">
        
        <!-- MAIN QUESTION COLUMN -->
        <div id="qbank-left-col" style="flex:1; min-width:0; transition: width 0.3s ease;">
          <div class="usmle-question-card">
          <div class="usmle-question-num" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <button class="btn-dark-pill" style="padding:4px 8px; font-size:0.8rem; display:flex; align-items:center; gap:4px; height:27px; color:var(--text-secondary); border: 1px solid #d1d5db;" onclick="window.openQBank()" title="Return to QBank Home">
                <i class="fa-solid fa-arrow-left" style="font-size:12px;"></i> Leave
              </button>
              <span>Question ${currentIndex + 1} of ${currentQuestions.length}</span>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
               ${(() => {
                 const p = window.qbankProgress[q.id] || {};
                 const isMarked = p.marked;
                 const hasNote = !!p.note;
                 const highActive = !!window.qbankHighlighterActive;
                 return `
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:${isMarked ? 'var(--accent-cyan)' : 'var(--text-secondary)'}; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankToggleMark()">
                     <i class="fa-solid fa-bookmark" style="font-size:12px;${isMarked ? 'color:var(--accent-cyan);' : ''}"></i> ${isMarked ? 'Marked' : 'Mark'}
                   </button>
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:${hasNote ? 'var(--accent-cyan)' : 'var(--text-secondary)'}; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankToggleNoteUI()">
                     <i class="fa-solid fa-file-alt" style="font-size:12px;${hasNote ? 'color:var(--accent-cyan);' : ''}"></i> ${hasNote ? 'Edit Note' : 'Add Note'}
                   </button>
                   <button class="btn-dark-pill" id="qbank-highlighter-btn" style="padding:4px 10px; font-size:0.8rem; color:${highActive ? 'var(--accent-cyan)' : 'var(--text-secondary)'}; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankToggleHighlighter()">
                     <i class="fa-solid fa-highlighter" style="font-size:12px;${highActive ? 'color:var(--accent-cyan);' : ''}"></i> Highlighter
                   </button>
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:var(--text-secondary); display:flex; align-items:center; gap:4px; height:27px;" onclick="window.generateAIFlashcard('${q.id}')" title="Generate AI Flashcard for this question">
                     <i class="fa-solid fa-brain" style="font-size:12px;"></i> AI Flashcard
                   </button>
                   <button id="qbank-study-btn" class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:var(--accent-cyan); display:flex; align-items:center; gap:4px; height:27px;" onclick="window.generateStudyConcept('${q.id}')" title="Study this concept in detail">
                     <i class="fa-solid fa-book-open" style="font-size:12px;"></i> Study this part
                   </button>
                   <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:#ef4444; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankReportQuestion('${q.id}')" title="Report an error in this question">
                     <i class="fa-solid fa-flag" style="font-size:12px;"></i> Report
                   </button>
                 `;
               })()}
               <span title="${isMultiple ? 'Question à Choix Multiples (Multiple Answers)' : 'Question à Choix Simple (Single Answer)'}" style="font-size:0.8rem; padding:4px 10px; background:${isMultiple ? 'rgba(168,85,247,0.15)' : 'rgba(6,182,212,0.15)'}; border:1px solid ${isMultiple ? 'rgba(168,85,247,0.3)' : 'rgba(6,182,212,0.3)'}; border-radius:12px; color:${isMultiple ? '#a855f7' : '#06b6d4'}; font-weight:700; cursor:help; letter-spacing:0.5px;">${isMultiple ? 'QCM' : 'QCS'}</span>
               ${data.subject ? `<span style="font-size:0.8rem; padding:4px 10px; background:rgba(255,255,255,0.1); border-radius:12px; color:var(--text-secondary); text-transform:uppercase;">${window.escapeHtml ? window.escapeHtml(data.subject) : data.subject}</span>` : ""}
               <span style="font-size:0.8rem; padding:4px 10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:12px; color:var(--text-secondary); font-family:monospace;">ID: ${data.code ? (window.escapeHtml ? window.escapeHtml(data.code) : data.code) : ("Q-" + q.id.substring(0, 5).toUpperCase())}</span>
               ${(data.tags || []).map(t => `<span style="font-size:0.75rem; padding:3px 8px; background:rgba(167, 139, 250, 0.15); border:1px solid rgba(167, 139, 250, 0.3); border-radius:12px; color:#a78bfa;">#${window.escapeHtml ? window.escapeHtml(t) : t}</span>`).join("")}

               ${window.isQBankAdmin ? `
                 <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:#f43f5e; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankAdminDelete('${q.id}')">
                   <i class="fa-solid fa-trash" style="font-size:12px;"></i> Delete
                 </button>
                 <button class="btn-dark-pill" style="padding:4px 10px; font-size:0.8rem; color:#38bdf8; display:flex; align-items:center; gap:4px; height:27px;" onclick="window.qbankAdminEdit('${q.id}')">
                   <i class="fa-solid fa-edit" style="font-size:12px;"></i> Edit
                 </button>
               ` : ''}
            </div>
          </div>
          
          ${(() => {
             const p = window.qbankProgress[q.id] || {};
             if (!p.note) return "";
             return `
             <div id="qbank-note-container" style="background:rgba(255,255,100,0.05); border-left:3px solid #facc15; padding:12px; margin-bottom:15px; border-radius:0 8px 8px 0; margin-top:15px;">
               <div style="font-size:0.8rem; color:#facc15; font-weight:700; margin-bottom:4px; display:flex; align-items:center; gap:4px;"><i class="fa-solid fa-sticky-note" style="font-size:12px;"></i> MY NOTE</div>
               <div style="font-size:0.9rem; color:var(--text-primary); white-space:pre-wrap;">${window.escapeHtml ? window.escapeHtml(p.note) : p.note}</div>
             </div>`;
          })()}

          <div id="qbank-note-editor" style="display:none; margin-top:15px; margin-bottom:15px; background:rgba(0,0,0,0.2); padding:12px; border-radius:8px; border:1px solid rgba(255,255,255,0.1);">
             <textarea id="qbank-note-input" class="login-input" style="width:100%; height:80px; padding:10px; font-size:0.9rem; margin-bottom:10px;" placeholder="Type your personal note here..."></textarea>
             <div style="display:flex; justify-content:flex-end; gap:8px;">
               <button class="btn-dark-pill" style="padding:6px 12px; font-size:0.85rem;" onclick="window.qbankToggleNoteUI()">Cancel</button>
               <button class="btn-action primary" style="padding:6px 12px; font-size:0.85rem;" onclick="window.qbankSaveNote()">Save Note</button>
             </div>
          </div>
          <h2 id="qbank-question-content" onmouseup="window.qbankHandleSelection(event)" style="font-size:1.05rem; line-height:1.6; margin-bottom:1.5rem; font-weight:500;">
            ${q.highlightedHTML ? q.highlightedHTML : (window.renderRichText ? window.renderRichText(q.text) : (window.escapeHtml ? window.escapeHtml(q.text) : q.text))}
          </h2>
          <div class="usmle-options" id="qbank-options-container">
            ${optionsHtml}
          </div>
          ${submitHtml}
          
          <div id="qbank-explanation-container" class="usmle-explanation" style="display:none; margin-top:30px;">
             <div id="qbank-result-header" style="font-weight:bold; margin-bottom:12px; font-size:1.1rem;"></div>
             <div style="margin-bottom:16px; font-size:0.9rem; color:var(--text-muted); display:flex; align-items:center;">
               <i class="fa-regular fa-clock" style="font-size:14px; margin-right:4px;"></i> Time Taken: <span id="qbank-time-taken-text" style="margin-left:4px; font-weight:600; color:var(--text-primary);"></span>
             </div>
             <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px;">
               <div style="width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg, rgba(14,124,134,0.2), rgba(45,212,191,0.15)); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                 <i class="fa-solid fa-lightbulb" style="font-size:18px;color:var(--accent-cyan, #2dd4bf);"></i>
               </div>
               <h3 style="font-size:1.1rem; margin:0; color:var(--text-primary); font-weight:700; letter-spacing:-0.01em;">Explanation</h3>
             </div>
             <div class="qbank-rich qbank-explanation-body" style="font-size:0.95rem; line-height:1.7; color:var(--text-secondary);">
               ${(() => {
                 const blocksHtml = window.renderExplanationBlocks ? window.renderExplanationBlocks(data.explanationBlocks) : "";
                 let textHtml = "No explanation provided.";
                 if (data.explanation) {
                   textHtml = (window.marked && window.DOMPurify)
                     ? window.DOMPurify.sanitize(window.marked.parse(data.explanation))
                     : (window.escapeHtml ? window.escapeHtml(data.explanation) : data.explanation);
                 }
                 const combined = blocksHtml + textHtml;
                 return window.formatExplanationSections ? window.formatExplanationSections(combined, data.options || [], data.correctIndices || []) : combined;
               })()}
             </div>
             
             <!-- AI Chat Area -->
             <div style="margin-top:20px; border-top:1px solid var(--border-color, rgba(0,0,0,0.1)); padding-top:20px;">
               <button class="btn-dark-pill" style="color:var(--accent-cyan); display:flex; align-items:center; gap:8px;" onclick="window.qbankToggleChat()">
                 <i class="fa-solid fa-robot" style="font-size:18px;"></i> Ask AI Tutor
               </button>
               <div id="qbank-ai-chat-container" style="display:none; margin-top:15px; background:var(--surface-color, rgba(255,255,255,0.02)); border:1px solid var(--border-color, rgba(0,0,0,0.1)); border-radius:12px; padding:15px;">
                 <div id="qbank-ai-chat-history" style="max-height:250px; overflow-y:auto; margin-bottom:15px; display:flex; flex-direction:column; gap:10px; font-size:0.95rem;"></div>
                 <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
                   <button class="btn-dark-pill" style="font-size:0.8rem; padding:4px 10px;" onclick="document.getElementById('qbank-ai-chat-input').value='Explain why I was incorrect.'; window.qbankSendChat();">Explain why</button>
                   <button class="btn-dark-pill" style="font-size:0.8rem; padding:4px 10px;" onclick="document.getElementById('qbank-ai-chat-input').value='Summarize the key concept.'; window.qbankSendChat();">Summarize concept</button>
                   <button class="btn-dark-pill" style="font-size:0.8rem; padding:4px 10px;" onclick="document.getElementById('qbank-ai-chat-input').value='Give me a mnemonic to remember this.'; window.qbankSendChat();">Give mnemonic</button>
                 </div>
                 <div style="display:flex; gap:10px;">
                   <input type="text" id="qbank-ai-chat-input" class="login-input" placeholder="E.g. Why is option A incorrect?" style="flex:1; margin:0;" onkeypress="if(event.key==='Enter') window.qbankSendChat()">
                   <button id="qbank-ai-chat-send" class="btn-action primary" style="padding:0 20px;" onclick="window.qbankSendChat()">Send</button>
                 </div>
               </div>
             </div>

             <button class="usmle-proceed-btn" style="margin-top:20px; width:100%;" onclick="window.qbankNext()">Next Question</button>
          </div> <!-- closes qbank-explanation-container -->
        </div> <!-- closes usmle-question-card -->
      </div> <!-- closes qbank-left-col -->
      
      <!-- STUDY CONCEPT RIGHT COLUMN -->
      <div id="qbank-right-col" style="display:none; flex:1; min-width:0; background:var(--surface-color, #fff); border:1px solid var(--border-color, rgba(0,0,0,0.1)); border-radius:8px; overflow:hidden; flex-direction:column; box-shadow:0 4px 20px rgba(0,0,0,0.05); height: calc(100vh - 120px); position: sticky; top: 80px;">
         <div style="display:flex; border-bottom:1px solid var(--border-color, rgba(0,0,0,0.1)); background:var(--header-bg, rgba(0,0,0,0.02));">
           <div style="padding:12px 24px; background:var(--surface-color, #fff); border-right:1px solid var(--border-color, rgba(0,0,0,0.1)); border-bottom:2px solid var(--primary-color); font-weight:600; font-size:0.95rem; color:var(--text-primary); cursor:pointer;">
             Explanation
           </div>
           <div style="flex:1;"></div>
           <button class="btn-icon" style="padding:12px; color:var(--text-muted);" onclick="window.closeStudyConcept()" title="Close">
             <i class="fa-solid fa-times"></i>
           </button>
         </div>
         <div id="qbank-study-content" class="qbank-rich" style="padding:24px; overflow-y:auto; flex:1; font-size:0.95rem; line-height:1.7; color:var(--text-color);">
         </div> <!-- closes qbank-study-content -->
      </div> <!-- closes qbank-right-col -->
    </div> <!-- closes qbank-split-container -->
  `;
    
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    startTimer();
    
    window.qbankRenderSidebar();
  };

  window.qbankSelectOption = async function (selectedIndex) {
    if (!qbankTimer) return; // already answered
    stopTimer();
    
    currentQuestionTimeMs = Date.now() - questionStartTime;
    const q = currentQuestions[currentIndex];
    const data = q.data || {};
    const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    const isMultiple = correctIndices.length > 1;

    let selectedIndices = [];
    if (isMultiple) {
      const inputs = document.getElementsByName("qbank-radio");
      inputs.forEach(r => { if (r.checked) selectedIndices.push(parseInt(r.value, 10)); });
      const submitBtn = document.getElementById("qbank-submit-btn");
      if (submitBtn) submitBtn.style.display = "none";
    } else {
      selectedIndices = [selectedIndex];
      const inputs = document.getElementsByName("qbank-radio");
      inputs.forEach((r) => { if (parseInt(r.value, 10) === selectedIndex) r.checked = true; });
    }
    
    currentSelectedIndices = selectedIndices;

    let isCorrect = false;
    if (isMultiple) {
      if (selectedIndices.length === correctIndices.length) {
        const sortedSelected = [...selectedIndices].sort();
        const sortedCorrect = [...correctIndices].sort();
        isCorrect = sortedSelected.every((v, i) => v === sortedCorrect[i]);
      }
    } else {
      isCorrect = correctIndices.includes(selectedIndex);
    }
    
    // Highlight UI
    const container = document.getElementById("qbank-options-container");
    const labels = container.querySelectorAll(".qbank-option-btn");
    labels.forEach((label, i) => {
      label.style.pointerEvents = "none";
      const input = label.querySelector("input");
      if (input) input.disabled = true;
      
      if (correctIndices.includes(i)) {
        label.classList.add("correct");
        label.style.background = "rgba(34,197,94,0.1)";
        label.style.border = "2px solid #22c55e";
        label.style.borderRadius = "12px";
        label.style.padding = "16px 20px";
      } else if (selectedIndices.includes(i) && !correctIndices.includes(i)) {
        label.classList.add("incorrect");
        label.style.background = "rgba(244,63,94,0.1)";
        label.style.border = "2px solid #f43f5e";
        label.style.borderRadius = "12px";
        label.style.padding = "16px 20px";
      }
    });

    const explContainer = document.getElementById("qbank-explanation-container");
    const resultHeader = document.getElementById("qbank-result-header");
    
    if (isCorrect) {
      resultHeader.innerHTML = '<span style="color:#22c55e;"><i data-lucide="check-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Correct</span>';
    } else {
      resultHeader.innerHTML = '<span style="color:#f43f5e;"><i data-lucide="x-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Incorrect</span>';
      
      if (!document.getElementById("qbank-study-styles")) {
        const style = document.createElement("style");
        style.id = "qbank-study-styles";
        style.innerHTML = `
          @keyframes qbank-pulse-glow {
            0% { box-shadow: 0 0 0 0 rgba(244,63,94, 0.6); }
            70% { box-shadow: 0 0 0 10px rgba(244,63,94, 0); }
            100% { box-shadow: 0 0 0 0 rgba(244,63,94, 0); }
          }
          .qbank-study-glow {
            animation: qbank-pulse-glow 2s infinite !important;
            border-color: rgba(244,63,94,0.5) !important;
            background: rgba(244,63,94,0.1) !important;
            color: #f43f5e !important;
          }
        `;
        document.head.appendChild(style);
      }
      
      const studyBtn = document.getElementById("qbank-study-btn");
      if (studyBtn) {
        studyBtn.classList.add("qbank-study-glow");
      }
    }
    
    document.getElementById("qbank-time-taken-text").textContent = formatTime(currentQuestionTimeMs);
    explContainer.style.display = "block";
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

    // Update local progress so sidebar icon shows immediately
    const p = window.qbankProgress[q.id] || {};
    p.correct = isCorrect;
    p.timeTakenMs = currentQuestionTimeMs;
    window.qbankProgress[q.id] = p;
    window.qbankRenderSidebar();

    // Submit progress silently
    if (currentQBankId) {
      pushToSyncQueue({
        qbankId: currentQBankId,
        questionId: q.id,
        correct: isCorrect,
        timeTakenMs: currentQuestionTimeMs
      });
    }

    // Log answer to global peer stats
    if (selectedIndices.length > 0) {
      _logPeerAnswer(q.id, selectedIndices[0]);
      // Update percentages without re-rendering
      setTimeout(async () => {
        const stats = await window.loadPeerStats(q.id);
        if (stats) {
          await window.qbankUpdatePeerPercentages(q.id, stats);
        }
      }, 500);
    }
  };

  // Update peer percentages without re-rendering the question
  window.qbankUpdatePeerPercentages = async function(questionId, stats) {
    // Reload threshold to get latest value
    try {
      const res = await fetch('/api/qbank?action=get_peer_stats_threshold');
      const data = await res.json();
      window.qbankPeerThreshold = data.threshold || 50;
    } catch (e) {}
    
    const peerThreshold = window.qbankPeerThreshold || 50;
    const isAdmin = window.isAdminCache || false;
    
    // Count unique users (not total answers)
    const uniqueUsers = stats && stats.users ? Object.keys(stats.users).length : 0;
    const showPeerStats = uniqueUsers >= peerThreshold;
    
    // Update each option's percentage
    const container = document.getElementById("qbank-options-container");
    if (!container) return;
    
    const labels = container.querySelectorAll(".qbank-option-btn");
    labels.forEach((label, i) => {
      // Remove existing percentage
      const existingPercent = label.querySelector(".peer-percent");
      if (existingPercent) existingPercent.remove();
      
      let peerPercent = '';
      
      // Calculate percentages based on unique users
      if (stats && stats.userCounts) {
        const totalUsers = uniqueUsers;
        const count = stats.userCounts[i] || 0;
        const pct = totalUsers > 0 ? Math.round((count / totalUsers) * 100) : 0;
        
        if (showPeerStats) {
          // Threshold met - show percentages
          peerPercent = `<span class="peer-percent" style="font-size:11px; color:#6b7280; margin-left:8px; font-weight:600;">${pct}%</span>`;
        } else if (isAdmin) {
          // Admin sees pending status
          peerPercent = `<span class="peer-percent" style="font-size:10px; color:#9ca3af; margin-left:8px;">Pending (${uniqueUsers}/${peerThreshold})</span>`;
        }
      }
      
      if (peerPercent) {
        label.insertAdjacentHTML('beforeend', peerPercent);
      }
    });
  };

  // Log answer to global peer statistics (unique users only)
  function _logPeerAnswer(questionId, selectedIndex) {
    try {
      const fsdb = firebase.firestore();
      const statsRef = fsdb.collection('questionStats').doc(questionId);
      const currentUser = firebase.auth().currentUser;
      const userId = currentUser ? currentUser.uid : 'anonymous_' + Date.now();
      
      statsRef.get().then(doc => {
        if (doc.exists) {
          const data = doc.data();
          const users = data.users || {};
          
          // Check if user already answered
          if (users[userId]) {
            // User already answered - don't count again
            return;
          }
          
          // New user - update counts
          const userCounts = data.userCounts || {};
          userCounts[selectedIndex] = (userCounts[selectedIndex] || 0) + 1;
          users[userId] = true;
          
          statsRef.update({
            userCounts: userCounts,
            users: users,
            total: Object.keys(users).length,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } else {
          // Create new stats doc
          const userCounts = {};
          userCounts[selectedIndex] = 1;
          const users = {};
          users[userId] = true;
          
          statsRef.set({
            userCounts: userCounts,
            users: users,
            total: 1,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      }).catch(err => {
        console.warn('Failed to log peer answer:', err);
      });
    } catch (e) {
      console.warn('Error logging peer answer:', e);
    }
  }

  // Load peer stats threshold from server (public endpoint)
  window._loadPeerThreshold = function() {
    try {
      fetch('/api/qbank?action=get_peer_stats_threshold')
        .then(res => res.json())
        .then(data => {
          window.qbankPeerThreshold = data.threshold || 50;
          console.log('[peer-stats] threshold loaded:', window.qbankPeerThreshold);
        })
        .catch(err => {
          console.warn('Failed to load peer threshold:', err);
          window.qbankPeerThreshold = 50;
        });
    } catch (e) {
      console.warn('Error loading peer threshold:', e);
      window.qbankPeerThreshold = 50;
    }
  }

  // Load peer stats for a specific question
  window.loadPeerStats = function(questionId) {
    return new Promise((resolve) => {
      try {
        const fsdb = firebase.firestore();
        fsdb.collection('questionStats').doc(questionId).get().then(doc => {
          if (doc.exists) {
            if (!window.qbankPeerStats) window.qbankPeerStats = {};
            const data = doc.data();
            // Migrate old format to new format if needed
            if (!data.userCounts && data.counts) {
              data.userCounts = data.counts;
            }
            window.qbankPeerStats[questionId] = data;
            resolve(data);
          } else {
            resolve(null);
          }
        }).catch(err => {
          console.warn('Failed to load peer stats:', err);
          resolve(null);
        });
      } catch (e) {
        console.warn('Error loading peer stats:', e);
        resolve(null);
      }
    });
  }

  // Log answer to global peer statistics
  window.logPeerAnswer = function(questionId, selectedIndex) {
    _logPeerAnswer(questionId, selectedIndex);
  }
  
  window.qbankNext = function() {
    if (currentQuestions.length === 0) return;
    
    const isParty = document.getElementById("qbank-party-sidebar")?.style.display !== "none";
    if (isParty) {
        if (!window.QBankParty || !window.QBankParty.state.isHost) {
            window.qbankToast("Only the host can advance to the next question.", true);
            return;
        }
        window.QBankParty.hostNextQuestion();
        return;
    }
    
    if (qbankTimer) {
      // User is skipping
    }
    currentIndex++;
    window.currentIndex = currentIndex;
    window.qbankRenderSidebar();
    window.qbankRenderCurrent();
  };

  window.qbankToggleMark = async function() {
    const q = currentQuestions[currentIndex];
    if (!q) return;
    const p = window.qbankProgress[q.id] || {};
    const newMarked = !p.marked;
    
    // Optimistic UI update
    p.marked = newMarked;
    window.qbankProgress[q.id] = p;
    window.qbankRenderCurrent();
    
    // Background save
    if (currentQBankId) {
      pushToSyncQueue({
        qbankId: currentQBankId,
        questionId: q.id,
        marked: newMarked
      });
    }
  };

  window.qbankReportQuestion = function(id) {
    if (!currentQBankId) return;
    const old = document.getElementById("qbank-report-modal");
    if (old) old.remove();

    const REASONS = [
      { key: "wrong_answer", label: "The answer is wrong", icon: "x-circle", suggest: true },
      { key: "invalid_question", label: "Question is invalid / unclear", icon: "help-circle", suggest: false },
      { key: "needs_explanation", label: "Needs a better explanation", icon: "message-square", suggest: false },
      { key: "typo", label: "Typo / formatting issue", icon: "type", suggest: false },
      { key: "other", label: "Other problem", icon: "flag", suggest: false },
    ];

    const ov = document.createElement("div");
    ov.id = "qbank-report-modal";
    ov.innerHTML = `
      <div class="rp-box">
        <div class="rp-head">
          <div>
            <div class="rp-title"><i data-lucide="flag" style="width:17px;height:17px;color:#f59e0b;"></i> Report Question</div>
            <div class="rp-sub">What is wrong with this question?</div>
          </div>
          <button type="button" class="rp-close">×</button>
        </div>

        <div class="rp-reasons">
          ${REASONS.map(r => `
            <button type="button" class="rp-reason" data-key="${r.key}" data-suggest="${r.suggest ? "1" : ""}">
              <i data-lucide="${r.icon}" style="width:15px;height:15px;"></i>
              <span>${r.label}</span>
            </button>`).join("")}
        </div>

        <div id="rp-suggest-wrap" style="display:none;">
          <label class="rp-label">Suggest the correct answer (optional)</label>
          <input id="rp-suggest-input" type="text" placeholder="e.g. The correct answer should be C because…" />
        </div>

        <div id="rp-details-wrap" style="display:none;">
          <label class="rp-label">Add details (optional)</label>
          <textarea id="rp-details-input" rows="3" placeholder="Anything else that helps us fix it…"></textarea>
        </div>

        <div class="rp-status" id="rp-status"></div>
        <div class="rp-foot">
          <button type="button" class="btn-dark-pill rp-cancel">Cancel</button>
          <button type="button" id="rp-send" class="btn-action primary" disabled>Submit Report</button>
        </div>
      </div>
      <style>${RP_CSS}</style>`;
    document.body.appendChild(ov);
    document.body.style.overflow = "hidden";
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

    let picked = null;
    const sendBtn = ov.querySelector("#rp-send");
    const statusEl = ov.querySelector("#rp-status");
    const suggestWrap = ov.querySelector("#rp-suggest-wrap");
    const detailsWrap = ov.querySelector("#rp-details-wrap");

    const close = () => { ov.remove(); document.body.style.overflow = ""; };
    ov.querySelector(".rp-close").addEventListener("click", close);
    ov.querySelector(".rp-cancel").addEventListener("click", close);
    ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
    const escHandler = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); } };
    document.addEventListener("keydown", escHandler);

    ov.querySelectorAll(".rp-reason").forEach(btn => {
      btn.addEventListener("click", () => {
        ov.querySelectorAll(".rp-reason").forEach(b => b.classList.remove("picked"));
        btn.classList.add("picked");
        picked = btn.dataset.key;
        const wantsSuggest = btn.dataset.suggest === "1";
        suggestWrap.style.display = wantsSuggest ? "block" : "none";
        // details box for everything except plain "needs explanation"
        detailsWrap.style.display = picked === "needs_explanation" ? "none" : "block";
        sendBtn.disabled = false;
      });
    });

    sendBtn.addEventListener("click", async () => {
      if (!picked) return;
      const reasonObj = {
        option: picked,
        suggestedAnswer: (ov.querySelector("#rp-suggest-input")?.value || "").trim(),
        details: (ov.querySelector("#rp-details-input")?.value || "").trim(),
      };
      sendBtn.disabled = true;
      sendBtn.textContent = "Submitting…";
      try {
        await apiPost("report_question", {
          qbankId: currentQBankId,
          questionId: id,
          reason: JSON.stringify(reasonObj),
        });
        close();
        const t = document.createElement("div");
        t.textContent = "Thank you! The question has been reported.";
        t.style.cssText = "position:fixed;bottom:20px;right:20px;padding:12px 20px;background:#0f8a5f;color:#fff;border-radius:10px;z-index:2147483647;font-family:'Figtree',sans-serif;font-size:0.9rem;box-shadow:0 6px 20px rgba(0,0,0,0.3);";
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3500);
      } catch (err) {
        statusEl.textContent = "Could not submit: " + (err.message || err);
        sendBtn.disabled = false;
        sendBtn.textContent = "Submit Report";
      }
    });
  };

  const RP_CSS = `
  #qbank-report-modal { position: fixed; inset: 0; z-index: 2147483000; background: rgba(6,25,31,0.72);
    backdrop-filter: blur(5px); display: flex; align-items: center; justify-content: center; padding: 24px;
    font-family: 'Figtree', sans-serif; }
  .rp-box { width: min(460px, 100%); max-height: 90vh; overflow-y: auto;
    background: var(--bg-elevated, #16232a); color: var(--text-primary, #fff);
    border: 1px solid rgba(245,158,11,0.28); border-radius: 18px; padding: 22px 24px;
    box-shadow: 0 40px 90px -30px rgba(4,18,22,0.85); animation: rp-in .25s cubic-bezier(.4,0,.2,1); }
  @keyframes rp-in { from { opacity:0; transform: translateY(12px) scale(.98);} to { opacity:1; transform:none;} }
  .rp-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
  .rp-title { font-family: 'Outfit', sans-serif; font-size: 1.15rem; font-weight: 800; display:flex; align-items:center; gap:8px; }
  .rp-sub { font-size: 0.85rem; color: var(--text-muted, #8fa9b4); margin-top: 4px; }
  .rp-close { background: transparent; border: none; color: var(--text-muted, #7d97a3); font-size: 26px; cursor:pointer; line-height:1; border-radius:8px; width:30px; height:30px; }
  .rp-close:hover { color: #fff; background: rgba(244,63,94,0.15); }
  .rp-reasons { display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px; }
  .rp-reason { display: flex; align-items: center; gap: 10px; padding: 12px 14px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
    color: var(--text-secondary, #cfe0e6); cursor: pointer; font-family: inherit; font-size: 0.92rem; font-weight: 600;
    text-align: left; transition: all .13s ease; width: 100%; }
  .rp-reason:hover { background: rgba(255,255,255,0.08); transform: translateX(2px); }
  .rp-reason.picked { background: rgba(14,124,134,0.2); border-color: var(--accent-cyan, #2dd4bf); color: #fff; }
  .rp-reason.picked::after { content: '\\2713'; margin-left: auto; color: var(--accent-cyan, #2dd4bf); font-weight: 800; }
  .rp-label { display: block; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--accent-cyan, #2dd4bf); margin: 12px 0 6px; }
  .rp-box input, .rp-box textarea { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12); color: var(--text-primary, #fff); padding: 11px 13px;
    border-radius: 10px; font-family: inherit; font-size: 0.92rem; resize: vertical; }
  .rp-box input:focus, .rp-box textarea:focus { outline: none; border-color: var(--accent-cyan, #2dd4bf);
    box-shadow: 0 0 0 3px rgba(14,124,134,0.16); }
  .rp-status { min-height: 18px; font-size: 0.82rem; color: #facc15; margin-top: 8px; }
  .rp-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }

  body.app-light-mode #qbank-report-modal { background: rgba(10,61,74,0.45); }
  body.app-light-mode .rp-box { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  body.app-light-mode .rp-title { color: #0a3d4a; }
  body.app-light-mode .rp-sub { color: #6b7f88; }
  body.app-light-mode .rp-reason { background: #f4f6f8; border-color: #dbe3e7; color: #334e59; }
  body.app-light-mode .rp-reason.picked { background: #e6f4f5; border-color: #0e7c86; color: #0b6770; }
  body.app-light-mode .rp-box input, body.app-light-mode .rp-box textarea { background: #fff; border-color: #dbe3e7; color: #0a3d4a; }
  `;

  window.qbankToggleNoteUI = function() {
    const ed = document.getElementById("qbank-note-editor");
    if (ed.style.display === "none") {
      ed.style.display = "block";
      const q = currentQuestions[currentIndex];
      const p = window.qbankProgress[q.id] || {};
      const inp = document.getElementById("qbank-note-input");
      inp.value = p.note || "";
      inp.focus();
    } else {
      ed.style.display = "none";
    }
  };

  window.qbankToggleHighlighter = function() {
      window.qbankHighlighterActive = !window.qbankHighlighterActive;
      const btn = document.getElementById("qbank-highlighter-btn");
      if (window.qbankHighlighterActive) {
          btn.style.color = "var(--accent-cyan)";
          btn.innerHTML = '<i data-lucide="highlighter" style="width:14px;height:14px;stroke:var(--accent-cyan);"></i> Highlighter';
      } else {
          btn.style.color = "var(--text-secondary)";
          btn.innerHTML = '<i data-lucide="highlighter" style="width:14px;height:14px;"></i> Highlighter';
      }
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.qbankHandleSelection = function(e) {
      if (!window.qbankHighlighterActive) return;
      
      if (e && e.target && e.target.classList.contains("qbank-highlighted-text")) {
          const span = e.target;
          const parent = span.parentNode;
          while(span.firstChild) parent.insertBefore(span.firstChild, span);
          parent.removeChild(span);
          if (currentQuestions[currentIndex]) {
              currentQuestions[currentIndex].highlightedHTML = document.getElementById("qbank-question-content").innerHTML;
          }
          return;
      }

      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return;
      
      // Ensure selection is inside the question content to prevent highlighting the whole page
      const container = document.getElementById("qbank-question-content");
      if (!container || !container.contains(sel.anchorNode)) return;

      const range = sel.getRangeAt(0);
      const span = document.createElement("span");
      span.style.backgroundColor = "rgba(255, 255, 0, 0.4)";
      span.style.color = "inherit";
      span.style.borderRadius = "3px";
      span.className = "qbank-highlighted-text";
      span.style.cursor = "pointer";
      span.title = "Click to remove highlight";
      
      try {
          range.surroundContents(span);
          if (currentQuestions[currentIndex]) {
              currentQuestions[currentIndex].highlightedHTML = document.getElementById("qbank-question-content").innerHTML;
          }
      } catch (err) {
          console.warn("Cannot highlight across multiple HTML elements.");
      }
      sel.removeAllRanges();
  };

  window.qbankSaveNote = async function() {
    const q = currentQuestions[currentIndex];
    if (!q) return;
    const inp = document.getElementById("qbank-note-input");
    const newNote = inp.value.trim();
    
    const p = window.qbankProgress[q.id] || {};
    p.note = newNote;
    window.qbankProgress[q.id] = p;
    window.qbankRenderCurrent();
    
    if (currentQBankId) {
      pushToSyncQueue({
        qbankId: currentQBankId,
        questionId: q.id,
        note: newNote
      });
    }
  };

  window.qbankToggleChat = function() {
    const container = document.getElementById("qbank-ai-chat-container");
    if (container.style.display === "none") {
      container.style.display = "block";
      document.getElementById("qbank-ai-chat-input").focus();
    } else {
      container.style.display = "none";
    }
  };

  window.qbankSendChat = async function() {
    const input = document.getElementById("qbank-ai-chat-input");
    const val = input.value.trim();
    if (!val) return;
    
    const history = document.getElementById("qbank-ai-chat-history");
    const q = currentQuestions[currentIndex];
    const data = q.data || {};
    
    const userMsg = document.createElement("div");
    userMsg.style.alignSelf = "flex-end";
    userMsg.style.background = "var(--accent-cyan)";
    userMsg.style.color = "#fff";
    userMsg.style.padding = "8px 12px";
    userMsg.style.borderRadius = "12px 12px 0 12px";
    userMsg.style.maxWidth = "85%";
    userMsg.textContent = val;
    history.appendChild(userMsg);
    
    input.value = "";
    input.disabled = true;
    const sendBtn = document.getElementById("qbank-ai-chat-send");
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i data-lucide="loader" class="spin" style="width:18px;height:18px;"></i>';
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    
    history.scrollTop = history.scrollHeight;
    
    try {
      const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
      const correctLetters = correctIndices.map(i => String.fromCharCode(65+i)).join(", ");
      const selectedLetters = currentSelectedIndices.map(i => String.fromCharCode(65+i)).join(", ");
      
      const qContext = `Question:\n${q.text || ""}\n\nOptions:\n${(data.options || []).map((o,i) => String.fromCharCode(65+i) + ". " + o).join("\n")}\n\nCorrect Answer(s): ${correctLetters}\nUser Selected Answer(s): ${selectedLetters}\n\nExplanation given:\n${data.explanation || ""}`;
      
      const res = await apiPost("chat_question", {
        questionContext: qContext,
        userMessage: val
      });
      
      const aiMsg = document.createElement("div");
      aiMsg.style.alignSelf = "flex-start";
      aiMsg.style.background = "var(--bg-card, rgba(128,128,128,0.15))";
      aiMsg.style.color = "var(--text-primary)";
      aiMsg.style.padding = "8px 12px";
      aiMsg.style.borderRadius = "12px 12px 12px 0";
      aiMsg.style.maxWidth = "85%";
      
      if (window.marked && window.marked.parse) {
         aiMsg.innerHTML = window.marked.parse(res.response);
      } else {
         aiMsg.textContent = res.response;
      }
      history.appendChild(aiMsg);
    } catch (e) {
      const errMsg = document.createElement("div");
      errMsg.style.color = "var(--danger)";
      errMsg.textContent = "Error: " + e.message;
      history.appendChild(errMsg);
    }
    
    input.disabled = false;
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
    history.scrollTop = history.scrollHeight;
    input.focus();
  };

  window.pendingRenames = window.pendingRenames || [];

  window.qbankAdminDeleteSubject = async function(subject) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    if (!confirm(`Are you sure you want to delete the entire subject "${subject}"? This action cannot be undone and will delete all questions within it.`)) return;

    let btn = null;
    try { btn = window.event ? window.event.target.closest('button') : null; } catch(e) {}
    if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width:12px;height:12px;margin-right:4px;"></i>Deleting...'; if (window.lucide) window.lucide.createIcons(); }

    const questionsToUse = (cachedQBanks[activeQBankId] && cachedQBanks[activeQBankId].questions) || [];
    const questionIds = questionsToUse.filter(q => q.data && q.data.subject === subject).map(q => q.id);

    if (questionIds.length === 0) {
      alert("No questions found for this subject.");
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="trash-2" style="width:12px;height:12px;margin-right:4px;"></i>Delete'; if (window.lucide) window.lucide.createIcons(); }
      return;
    }

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch(`/api/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "delete_multiple_qbank_questions", qbankId: activeQBankId, questionIds })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete questions");
      
      alert(`Successfully deleted ${questionIds.length} questions in subject "${subject}".`);
      
      // Purge ALL caches so refreshing doesn't restore stale data
      if (cachedQBanks[activeQBankId] && cachedQBanks[activeQBankId].questions) {
          cachedQBanks[activeQBankId].questions = cachedQBanks[activeQBankId].questions.filter(q => !questionIds.includes(q.id));
      }
      delete cachedQBanks[activeQBankId];  // force full re-fetch
      preloadPromise = null;                // reset category list cache
      cachedCategories = null;
      
      // Clear IndexedDB cache for this qbank
      try {
        const db = await openQBankDB();
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(activeQBankId);
      } catch(e) {}
      
      window.openQBank(activeQBankId);
      setTimeout(window.showQBankSubjects, 200);
    } catch (e) {
      alert("Error: " + e.message);
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="trash-2" style="width:12px;height:12px;margin-right:4px;"></i>Delete'; if (window.lucide) window.lucide.createIcons(); }
    }
  };

  window.qbankAdminRenameSubject = function(oldSubject) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    const newSubject = prompt(`Rename or move questions in subject "${oldSubject}" to:`, oldSubject);
    if (!newSubject || newSubject === oldSubject) return;
    
    window.pendingRenames.push({ type: 'subject', oldSubject, newSubject });
    window.renderPendingRenames();
  };

  window.qbankAdminRenameChapter = function(subject, oldChapter) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    const newChapter = prompt(`Rename or move chapter "${oldChapter}" in subject "${subject}" to:`, oldChapter);
    if (!newChapter || newChapter === oldChapter) return;
    
    window.pendingRenames.push({ type: 'chapter', subject, oldChapter, newChapter });
    window.renderPendingRenames();
  };

  window.qbankAdminMoveSubject = function(oldSubject) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    
    const existingSubjects = Object.keys(window.qbankCurrentSubjectStats || {}).filter(s => s !== oldSubject).sort((a,b) => a.localeCompare(b));
    if (existingSubjects.length === 0) {
      alert("No other subjects available to merge into.");
      return;
    }

    const modal = document.createElement('div');
    modal.style.cssText = "position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px);";
    
    const content = document.createElement('div');
    content.style.cssText = "background:var(--bg-card, #1e293b); padding:24px; border-radius:12px; width:400px; max-width:90%; box-shadow:0 10px 40px rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.1); color:var(--text-primary);";
    
    content.innerHTML = `
      <h3 style="margin-top:0; font-family:var(--font-heading);">Merge Subject</h3>
      <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:16px;">Select an existing subject to merge all questions from <b>${window.escapeHtml(oldSubject)}</b> into:</p>
    `;
    
    const select = document.createElement('select');
    select.style.cssText = "width:100%; padding:10px; margin-bottom:20px; border-radius:6px; background:var(--bg-elevated, #0f172a); color:var(--text-primary); border:1px solid rgba(255,255,255,0.2); font-size:0.95rem; outline:none;";
    existingSubjects.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      select.appendChild(opt);
    });
    content.appendChild(select);
    
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = "display:flex; justify-content:flex-end; gap:12px;";
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = "btn-action secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => modal.remove();
    
    const moveBtn = document.createElement('button');
    moveBtn.className = "btn-action primary";
    moveBtn.textContent = "Merge";
    moveBtn.onclick = () => {
      const newSub = select.value;
      window.pendingRenames.push({ type: 'subject', oldSubject, newSubject: newSub });
      window.renderPendingRenames();
      modal.remove();
    };
    
    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(moveBtn);
    content.appendChild(btnContainer);
    modal.appendChild(content);
    document.body.appendChild(modal);
  };

  window.qbankAdminMoveChapter = function(subject, oldChapter) {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId) return;
    
    const stats = window.qbankCurrentSubjectStats[subject];
    if (!stats || !stats.chapters) return;

    const existingChapters = Object.keys(stats.chapters).filter(c => c !== oldChapter).sort((a,b) => a.localeCompare(b));
    if (existingChapters.length === 0) {
      alert("No other chapters available in this subject to merge into.");
      return;
    }

    const modal = document.createElement('div');
    modal.style.cssText = "position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px);";
    
    const content = document.createElement('div');
    content.style.cssText = "background:var(--bg-card, #1e293b); padding:24px; border-radius:12px; width:400px; max-width:90%; box-shadow:0 10px 40px rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.1); color:var(--text-primary);";
    
    content.innerHTML = `
      <h3 style="margin-top:0; font-family:var(--font-heading);">Merge Chapter</h3>
      <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:16px;">Select an existing chapter to merge all questions from <b>${window.escapeHtml(oldChapter)}</b> into:</p>
    `;
    
    const select = document.createElement('select');
    select.style.cssText = "width:100%; padding:10px; margin-bottom:20px; border-radius:6px; background:var(--bg-elevated, #0f172a); color:var(--text-primary); border:1px solid rgba(255,255,255,0.2); font-size:0.95rem; outline:none;";
    existingChapters.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      select.appendChild(opt);
    });
    content.appendChild(select);
    
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = "display:flex; justify-content:flex-end; gap:12px;";
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = "btn-action secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => modal.remove();
    
    const moveBtn = document.createElement('button');
    moveBtn.className = "btn-action primary";
    moveBtn.textContent = "Merge";
    moveBtn.onclick = () => {
      const newChap = select.value;
      window.pendingRenames.push({ type: 'chapter', subject, oldChapter, newChapter: newChap });
      window.renderPendingRenames();
      modal.remove();
    };
    
    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(moveBtn);
    content.appendChild(btnContainer);
    modal.appendChild(content);
    document.body.appendChild(modal);
  };

  window.removePendingRename = function(index) {
    window.pendingRenames.splice(index, 1);
    window.renderPendingRenames();
  };

  window.applyPendingRenames = async function() {
    const activeQBankId = window.db && window.db.selectedQBankId;
    if (!activeQBankId || window.pendingRenames.length === 0) return;
    if (!confirm(`Are you sure you want to apply ${window.pendingRenames.length} renames to this QBank?`)) return;

    const btn = document.getElementById("admin-apply-renames-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Applying..."; }

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch(`/api/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "batch_rename_qbank_categories", qbankId: activeQBankId, renames: window.pendingRenames })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to apply renames");
      
      // Update local state
      const questionsToUse = (cachedQBanks[activeQBankId] && cachedQBanks[activeQBankId].questions) || [];
      questionsToUse.forEach(q => {
        if (!q.data) return;
        window.pendingRenames.forEach(r => {
          if (r.type === 'subject' && q.data.subject === r.oldSubject) {
            q.data.subject = r.newSubject;
          }
          if (r.type === 'chapter' && q.data.subject === r.subject && q.data.chapter === r.oldChapter) {
            q.data.chapter = r.newChapter;
          }
        });
      });

      alert(`Successfully applied ${window.pendingRenames.length} renames. Updated ${data.updatedCount || 0} questions.`);
      window.pendingRenames = [];
      window.renderPendingRenames();
      
      // Clear all caches so next load fetches fresh renamed chunks
      delete cachedQBanks[activeQBankId];
      preloadPromise = null;
      cachedCategories = null;
      try {
        const db = await openQBankDB();
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(activeQBankId);
      } catch(e) {}
      
      // Full recompute / reload
      window.openQBank(activeQBankId);
      setTimeout(window.showQBankSubjects, 200);
    } catch (e) {
      alert("Error: " + e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Apply All Renames"; }
    }
  };

  window.isPendingRenamesMinimized = false;
  window.togglePendingRenamesMinimize = function() {
    window.isPendingRenamesMinimized = !window.isPendingRenamesMinimized;
    window.renderPendingRenames();
  };

  window.renderPendingRenames = function() {
    let container = document.getElementById("admin-pending-renames-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "admin-pending-renames-container";
      container.style.position = "fixed";
      container.style.bottom = "20px";
      container.style.right = "20px";
      container.style.width = "320px";
      container.style.backgroundColor = "var(--bg-elevated)";
      container.style.border = "1px solid rgba(255,255,255,0.1)";
      container.style.borderRadius = "12px";
      container.style.boxShadow = "0 8px 32px rgba(0,0,0,0.5)";
      container.style.zIndex = "9999";
      container.style.display = "none";
      container.style.flexDirection = "column";
      document.body.appendChild(container);
    }

    if (window.pendingRenames.length === 0) {
      container.style.display = "none";
      return;
    }

    container.style.display = "flex";
    
    let html = `
      <div style="padding:12px 16px; border-bottom:1px solid rgba(255,255,255,0.05); font-weight:bold; color:var(--text-primary); display:flex; justify-content:space-between; align-items:center;">
        <span style="cursor:pointer; display:flex; align-items:center; gap:6px; user-select:none;" onclick="window.togglePendingRenamesMinimize()" title="Click to minimize/expand">
          <i data-lucide="${window.isPendingRenamesMinimized ? 'chevron-up' : 'chevron-down'}" style="width:18px;height:18px;color:var(--text-muted);"></i>
          Bulk Rename Queue (${window.pendingRenames.length})
        </span>
        <button onclick="window.pendingRenames=[]; window.renderPendingRenames();" style="background:transparent; border:none; color:var(--danger); cursor:pointer; font-size:0.8rem;">Clear</button>
      </div>
      <div style="display: ${window.isPendingRenamesMinimized ? 'none' : 'block'};">
        <div style="max-height:300px; overflow-y:auto; padding:12px 16px; display:flex; flex-direction:column; gap:8px;">
    `;

    window.pendingRenames.forEach((r, i) => {
      let desc = r.type === 'subject' 
        ? `<span style="color:var(--text-muted)">Sub:</span> ${window.escapeHtml(r.oldSubject)} &rarr; <span style="color:#38bdf8">${window.escapeHtml(r.newSubject)}</span>`
        : `<span style="color:var(--text-muted)">Chap:</span> ${window.escapeHtml(r.oldChapter)} &rarr; <span style="color:#38bdf8">${window.escapeHtml(r.newChapter)}</span>`;
      html += `
        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:6px; font-size:0.85rem;">
          <div>${desc}</div>
          <button onclick="window.removePendingRename(${i})" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer;"><i data-lucide="x" style="width:14px;height:14px;"></i></button>
        </div>
      `;
    });

    html += `
        </div>
        <div style="padding:12px 16px; border-top:1px solid rgba(255,255,255,0.05);">
          <button id="admin-apply-renames-btn" class="btn-action primary" style="width:100%; font-weight:bold;" onclick="window.applyPendingRenames()">Apply All Renames</button>
        </div>
      </div>
    `;

    container.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();
  };

  window.qbankAdminDelete = async function(questionId) {
    if (!confirm("Are you sure you want to delete this question for everyone?")) return;
    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch(`/api/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "delete_qbank_question", qbankId: currentQBankId, questionId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete");
      
      // Remove locally
      allQuestions = allQuestions.filter(q => q.id !== questionId);
      currentQuestions = currentQuestions.filter(q => q.id !== questionId);
      if (currentIndex >= currentQuestions.length) currentIndex = Math.max(0, currentQuestions.length - 1);
      window.qbankRenderCurrent();
      alert("Question deleted successfully.");
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  };

  window.qbankAdminEdit = function(questionId) {
    const q = allQuestions.find(q => q.id === questionId);
    if (!q || !currentQBankId) return;
    // Reuse the same rich editor as the admin panel
    window.openRichQuestionEditor({
      qbankId: currentQBankId,
      questionId,
      questionText: q.text,
      data: q.data || {},
      onSave: async (payload) => {
        const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
        const res = await fetch(`/api/admin`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "update_qbank_question", qbankId: currentQBankId, questionId, ...payload })
        });
        const resp = await res.json();
        if (!res.ok) throw new Error(resp.error || "Failed to save");

        // Update local state so the change shows instantly
        q.text = payload.questionText;
        try {
          const newData = JSON.parse(payload.dataJson);
          delete newData.questionText;
          q.data = newData;
        } catch (e) {}
        q.highlightedHTML = null; // Clear highlight cache
        window.qbankRenderCurrent();
        alert("Question updated successfully.");
      }
    });
  };

  window.generateAIFlashcard = async function(questionId) {
    const q = allQuestions.find(q => q.id === questionId);
    if (!q) return;

    let modal = document.getElementById("qbank-ai-flashcard-modal");
    if (!modal) {
      modal = document.createElement("dialog");
      modal.id = "qbank-ai-flashcard-modal";
      modal.style.cssText = "padding:0; border:none; background:transparent; max-width:600px; width:100%; outline:none;";
      const style = document.createElement("style");
      style.innerHTML = `
        #qbank-ai-flashcard-modal::backdrop { background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px); }
        @keyframes qbspin { 100% { transform: rotate(360deg); } }
      `;
      document.head.appendChild(style);
      document.body.appendChild(modal);
    }
    
    modal.innerHTML = `
      <div class="bg-surface-container-high text-on-surface rounded-2xl p-6 md:p-8 relative shadow-2xl border border-outline-variant/30 w-full animate-[fade-in_0.3s_ease-out]">
        <button onclick="document.getElementById('qbank-ai-flashcard-modal').close()" class="absolute top-4 right-4 p-2 rounded-full hover:bg-surface-container-highest text-on-surface-variant transition-colors cursor-pointer">
          <i data-lucide="x" style="width:20px;height:20px;"></i>
        </button>
        <h3 class="font-title-lg text-[22px] font-bold mb-6 flex items-center gap-2">
          <i data-lucide="brain" class="text-primary" style="width:24px; height:24px;"></i> AI Concept Flashcard
        </h3>
        <div id="ai-flashcard-content" class="min-h-[120px] flex justify-center items-center flex-col gap-4">
          <div style="width:36px; height:36px; border:3px solid rgba(128,128,128,0.2); border-top-color:var(--primary); border-radius:50%; animation:qbspin 1s linear infinite;"></div>
          <span class="text-on-surface-variant text-sm" id="qbank-fc-loading-text">Extracting core concepts...</span>
        </div>
      </div>
    `;
    modal.showModal();
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

    const data = q.data || {};
    let optionsText = "";
    if (data.options && Array.isArray(data.options)) {
      optionsText = data.options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join("\\n");
    }
    const explanation = data.explanation || "No explanation provided.";
    
    let correctAns = "Unknown";
    const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
    if (correctIndices.length > 0 && data.options) {
       correctAns = correctIndices.map(i => `${String.fromCharCode(65 + i)}. ${data.options[i]}`).join(", ");
    }
    
    const questionText = `${q.text}\\n\\n${optionsText}`;

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          task: "qbank_flashcard_from_question",
          vars: { question: questionText, answer: correctAns, explanation: explanation }
        })
      });
      
      const resData = await res.json();
      if (!res.ok) throw new Error(resData.error || resData.message || "AI failed to generate flashcard.");
      
      let parsedContent;
      try {
        parsedContent = JSON.parse(resData.content);
      } catch(e) {
        throw new Error("AI returned malformed data.");
      }
      
      const fFront = parsedContent.flashcardFront || parsedContent.flashcard_front || parsedContent.front || "";
      const fBack = parsedContent.flashcardBack || parsedContent.flashcard_back || parsedContent.back || "";
      const fConcepts = parsedContent.conceptBreakdown || parsedContent.concept_breakdown || parsedContent.concepts || "No breakdown provided.";
      
      if (!fFront && !fConcepts) {
         throw new Error("AI returned an empty response. Please try again.");
      }
      
      // Store globally so the save button can access it (legacy)
      window.__currentAIFlashcard = {
        questionId: questionId,
        qbankId: window.currentQBankId,
        front: fFront,
        back: fBack,
        concepts: fConcepts
      };

      // Auto-save it to main flashcards db!
      if (window.db && window.db.rems) {
         window.db.rems.push({
           id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
           type: "flashcard",
           isFlashcard: true,
           cardType: "basic",
           front: fFront,
           back: fBack,
           explanation: fConcepts,
           docId: "qbank",
           qbankId: window.currentQBankId,
           subject: q.data.subject || "Uncategorized",
           topic: q.data.subject ? `QBank: ${q.data.subject}` : "QBank Auto-Flashcard",
           text: fFront + " == " + fBack,
           nextReviewAt: new Date().toISOString(),
           interval: 0,
           repetition: 0,
           ease: 2.5
         });
         if (typeof window.saveDb === 'function') window.saveDb();
         if (typeof window.updateSRSQueue === 'function') window.updateSRSQueue();
      }

      document.getElementById("ai-flashcard-content").innerHTML = `
        <div class="w-full bg-surface-container-highest rounded-xl p-6 mb-6 text-center border border-outline-variant/30 shadow-inner">
           <p class="text-lg font-semibold mb-4 leading-relaxed">${fFront}</p>
           ${fBack ? `<hr class="border-outline-variant/30 my-4"><p class="text-md text-on-surface-variant leading-relaxed">${fBack}</p>` : ""}
        </div>
        <div class="w-full text-left bg-primary/5 p-5 rounded-xl border border-primary/10 mb-6">
           <h4 class="text-sm font-bold text-primary uppercase mb-3 tracking-wide flex items-center gap-2">
             <i data-lucide="lightbulb" style="width:16px;height:16px;"></i> Key Concepts
           </h4>
           <div class="text-sm text-on-surface-variant leading-relaxed ai-concept-breakdown">
             ${fConcepts}
           </div>
        </div>
        <div class="flex justify-end gap-3 w-full items-center">
           <div class="text-sm text-green-500 font-medium flex items-center gap-1 mr-auto">
             <i data-lucide="check-circle-2" style="width:16px;height:16px;"></i> Auto-saved to Flashcards tab
           </div>
           <button class="btn-action secondary px-4 py-2 rounded-full font-medium" onclick="document.getElementById('qbank-ai-flashcard-modal').close()">Close</button>
        </div>
      `;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    } catch(err) {
      document.getElementById("ai-flashcard-content").innerHTML = `
        <div class="w-full bg-red-500/10 text-red-500 p-6 text-center rounded-xl border border-red-500/20">
          <i data-lucide="alert-triangle" style="width:24px;height:24px;margin:0 auto 8px;"></i>
          <br>${err.message}
        </div>
        <div class="flex justify-end gap-3 w-full mt-6">
           <button class="btn-action secondary px-4 py-2 rounded-full" onclick="document.getElementById('qbank-ai-flashcard-modal').close()">Close</button>
        </div>
      `;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    }
  };

  window.closeStudyConcept = function() {
    const rightCol = document.getElementById("qbank-right-col");
    if (rightCol) rightCol.style.display = "none";
  };

  window.generateStudyConcept = async function(questionId) {
    const q = allQuestions.find(q => q.id === questionId);
    if (!q) return;

    const rightCol = document.getElementById("qbank-right-col");
    const contentDiv = document.getElementById("qbank-study-content");
    if (!rightCol || !contentDiv) return;
    
    rightCol.style.display = "flex";

    if (q.studyConcept) {
      contentDiv.innerHTML = (window.marked && window.DOMPurify) ? window.DOMPurify.sanitize(window.marked.parse(q.studyConcept)) : q.studyConcept;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      return;
    }

    contentDiv.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:60px 20px; gap:16px;">
        <div style="width:40px; height:40px; border:3px solid rgba(128,128,128,0.2); border-top-color:var(--accent-cyan); border-radius:50%; animation:qbspin 1s linear infinite;"></div>
        <span style="color:var(--text-secondary); font-size:1rem; font-weight:500;">Extracting relevant textbook excerpt for this concept...</span>
      </div>
    `;

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      
      const getRes = await fetch(`/api/qbank?action=get_study_concept&qbankId=${encodeURIComponent(currentQBankId)}&questionId=${encodeURIComponent(questionId)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (getRes.ok) {
        const getData = await getRes.json();
        if (getData.studyConcept) {
          q.studyConcept = getData.studyConcept;
          contentDiv.innerHTML = (window.marked && window.DOMPurify) ? window.DOMPurify.sanitize(window.marked.parse(q.studyConcept)) : q.studyConcept;
          if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
          return;
        }
      }

      const data = q.data || {};
      let optionsText = "";
      if (data.options && Array.isArray(data.options)) {
        optionsText = data.options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join("\\n");
      }
      const explanation = data.explanation || "No explanation provided.";
      
      let correctAns = "Unknown";
      const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
      if (correctIndices.length > 0 && data.options) {
         correctAns = correctIndices.map(i => `${String.fromCharCode(65 + i)}. ${data.options[i]}`).join(", ");
      }
      
      const questionText = `${q.text}\\n\\n${optionsText}`;

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          task: "qbank_study_concept",
          vars: { question: questionText, answer: correctAns, explanation: explanation }
        })
      });
      
      const resData = await res.json();
      if (!res.ok) throw new Error(resData.error || resData.message || "AI failed to generate study concept.");
      
      const parsedContent = resData.content;
      if (!parsedContent) throw new Error("AI returned empty response.");
      
      q.studyConcept = parsedContent;
      contentDiv.innerHTML = (window.marked && window.DOMPurify) ? window.DOMPurify.sanitize(window.marked.parse(parsedContent)) : parsedContent;
      
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

      fetch("/api/qbank", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "save_study_concept",
          qbankId: currentQBankId,
          questionId: questionId,
          studyConcept: parsedContent
        })
      }).catch(e => console.error("Failed to save study concept async", e));

    } catch(err) {
      contentDiv.innerHTML = `
        <div style="background:rgba(244,63,94,0.1); color:#f43f5e; padding:16px; border-radius:8px; border:1px solid rgba(244,63,94,0.2); text-align:center;">
          <i class="fa-solid fa-triangle-exclamation" style="font-size:24px; margin-bottom:8px;"></i>
          <br>${err.message}
        </div>
      `;
    }
  };

  window.saveQBankFlashcard = async function(btn) {
    const fc = window.__currentAIFlashcard;
    if (!fc) return;
    
    const originalText = btn.innerHTML;
    btn.innerHTML = `<div class="spinner" style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:qbspin 1s linear infinite;"></div> Saving...`;
    btn.disabled = true;

    try {
      const token = await (window.firebase && firebase.auth().currentUser.getIdToken());
      const res = await fetch("/api/qbank", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "save_flashcard",
          ...fc
        })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      
      btn.innerHTML = `<i data-lucide="check" style="width:16px;height:16px;"></i> Saved!`;
      btn.classList.replace("primary", "success"); // Assuming success class exists, or just change bg
      btn.style.backgroundColor = "#10b981";
      btn.style.color = "#fff";
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      
      setTimeout(() => {
        const modal = document.getElementById('qbank-ai-flashcard-modal');
        if(modal) modal.close();
      }, 1500);
      
    } catch(err) {
      alert("Error saving flashcard: " + err.message);
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  };

  window.openPerformance = function() {
      if (window.hideAllMainViews) window.hideAllMainViews();
      
      const pv = document.getElementById("performance-view");
      if (pv) {
          pv.style.display = "flex";
      }

      // Update active nav class
      document.querySelectorAll('nav a').forEach(a => {
          a.classList.remove('border-primary', 'bg-primary/10', 'text-primary', 'font-bold');
          a.classList.add('border-transparent', 'text-on-surface-variant', 'font-medium');
        });
        const pt = document.querySelector('nav a[data-path="performance"]');
        if (pt) {
          pt.classList.remove('border-transparent', 'text-on-surface-variant', 'font-medium');
          pt.classList.add('border-primary', 'bg-primary/10', 'text-primary', 'font-bold');
        }

      if (window.innerWidth < 1024 && typeof window.toggleSidebar === 'function') {
          // Close mobile sidebar if needed
      }

      renderPerformanceView();
  };

  let performanceChartInstance = null;

  function renderPerformanceView() {
      const area = document.getElementById("performance-content");
      if (!area) return;

      if (!window.db || !window.db.selectedQBankId) {
          area.innerHTML = '<div class="text-center p-12 mt-12 bg-surface-container-lowest rounded-2xl shadow-sm"><p class="text-on-surface-variant">Please select a Question Bank from the Home Dashboard first to view your analytics.</p></div>';
          return;
      }

      const activeQBankId = window.db.selectedQBankId;
      const qbanks = window.db.qbanks || [];
      const activeQBankMeta = qbanks.find(qb => qb.id === activeQBankId) || qbanks[0];
      const activeQBankName = activeQBankMeta ? activeQBankMeta.name : "Your QBank";

      let totalQuestions = 0;
      let totalAnswered = 0;
      let totalCorrect = 0;
      let subjectStats = {};

      const qData = cachedQBanks[activeQBankId];
      if (qData) {
        totalQuestions = (qData.questions || []).length;
        const prog = qData.progress || {};
        for (const q of (qData.questions || [])) {
           const sub = (q.data && q.data.subject) || "Uncategorized";
           if (!subjectStats[sub]) subjectStats[sub] = { total: 0, answered: 0, correct: 0, incorrect: 0, marked: 0 };
           subjectStats[sub].total++;
           
           if (prog[q.id]) {
             if (prog[q.id].correct !== undefined) { 
               totalAnswered++; 
               subjectStats[sub].answered++;
               if (prog[q.id].correct) {
                 totalCorrect++; 
                 subjectStats[sub].correct++;
               } else {
                 subjectStats[sub].incorrect++;
               }
             }
             if (prog[q.id].marked) {
                 subjectStats[sub].marked++;
             }
           }
        }
      }

      const globalScore = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
      
      let specialtyStats = [];
      for (const [sub, stat] of Object.entries(subjectStats)) {
          if (sub === "Uncategorized") continue;
          let specScore = stat.answered > 0 ? Math.round((stat.correct / stat.answered) * 100) : 0;
          specialtyStats.push({ name: sub, ...stat, score: specScore });
      }
      specialtyStats.sort((a, b) => b.score - a.score || b.answered - a.answered);

      let specialtyListHtml = '';
      let labels = [];
      let dataScore = [];
      
      if (specialtyStats.length > 0) {
          specialtyStats.forEach(spec => {
              labels.push(spec.name);
              dataScore.push(spec.score);
              
              const colorClass = spec.score >= 80 ? 'background:#10b981' : (spec.score >= 50 ? 'background:#007a7a' : 'background:#e11d48');
              const textClass = spec.score >= 80 ? 'color:#10b981' : (spec.score >= 50 ? 'color:#111827' : 'color:#e11d48');
              
              specialtyListHtml += `
              <div class="rounded-2xl p-6 shadow-sm flex flex-col hover:-translate-y-1 transition-transform group" style="background:#fff; border:1px solid #e2e8f0;">
                  <div class="flex items-start justify-between mb-2">
                      <div>
                          <h3 class="font-title-md text-[18px] mb-1" style="color:#111827;">${window.escapeHtml ? window.escapeHtml(spec.name) : spec.name}</h3>
                          <p class="font-label-sm" style="color:#6b7280;">${spec.answered} / ${spec.total} Answered</p>
                      </div>
                      <div class="text-right">
                          <span class="font-headline-lg" style="${textClass}">${spec.score}%</span>
                      </div>
                  </div>
                  
                  <div class="w-full rounded-full h-2 mb-4" style="background:#f8fafc;">
                    <div class="h-2 rounded-full" style="${colorClass}; width: ${spec.score}%"></div>
                  </div>

                  <div class="mt-auto pt-4 flex justify-between items-center" style="border-top:1px solid #e2e8f0;">
                      <div class="flex gap-4 text-[12px]" style="color:#6b7280;">
                          <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:#10b981;"></span> ${spec.correct} Correct</div>
                          <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:#e11d48;"></span> ${spec.incorrect} Incorrect</div>
                      </div>
                      <button class="px-3 py-1.5 text-[12px] font-bold uppercase rounded-lg border transition-colors flex items-center gap-1 cursor-pointer"
                          style="border-color:#e2e8f0; color:#007a7a; background:transparent;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'"
                          onclick="window.startQBankSession('${activeQBankId}', '${window.escapeHtml ? window.escapeHtml(activeQBankName).replace(/'/g, "\\'") : activeQBankName}', '${window.escapeHtml ? window.escapeHtml(spec.name).replace(/'/g, "\\'") : spec.name}', true)">
                          <span class="material-symbols-outlined text-[14px]">refresh</span> Review Incorrects
                      </button>
                  </div>
              </div>
              `;
          });
      } else {
          specialtyListHtml = '<div class="col-span-full text-center p-8 text-on-surface-variant">No specialty data available. Answer some questions to see your breakdown.</div>';
      }

      area.innerHTML = `
      <div class="animate-[fade-in_0.5s_ease-out] flex flex-col gap-6">
          <div class="flex items-end justify-between">
              <div>
                  <p class="font-label-caps tracking-[0.1em] mb-2" style="color:#007a7a;">DETAILED ANALYTICS</p>
                  <h1 class="font-headline-xl" style="color:#111827;">My Performance</h1>
              </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div class="rounded-2xl p-6 shadow-sm lg:col-span-1 flex flex-col justify-between" style="background:#fff; border:1px solid #e2e8f0;">
                  <div class="flex items-center justify-between mb-4">
                      <div class="flex items-center gap-2 font-bold tracking-wider text-[13px]" style="color:#007a7a;">
                           <span class="material-symbols-outlined text-[18px]">workspace_premium</span> GLOBAL ACCURACY
                      </div>
                  </div>
                  <div class="flex items-end gap-1 mb-6 mt-4">
                      <h2 class="font-headline-xl text-[64px] leading-none font-black tracking-tight" style="color:#111827;">${globalScore}<span class="text-[32px] font-medium ml-1" style="color:#6b7280;">%</span></h2>
                  </div>
                  
                  <div class="grid grid-cols-3 gap-3 w-full mt-auto">
                      <div class="rounded-xl p-3 flex flex-col justify-center transition-colors border" style="background:#f8fafc; border-color:#e2e8f0;" onmouseover="this.style.borderColor='#007a7a'" onmouseout="this.style.borderColor='#e2e8f0'">
                          <div class="text-[10px] uppercase font-bold tracking-wider mb-1" style="color:#6b7280;">Answered</div>
                          <div class="font-title-md font-bold text-[18px]" style="color:#007a7a;">${totalAnswered}</div>
                      </div>
                      <div class="rounded-xl p-3 flex flex-col justify-center transition-colors border" style="background:#f8fafc; border-color:#e2e8f0;" onmouseover="this.style.borderColor='#10b981'" onmouseout="this.style.borderColor='#e2e8f0'">
                          <div class="text-[10px] uppercase font-bold tracking-wider mb-1" style="color:#6b7280;">Correct</div>
                          <div class="font-title-md font-bold text-[18px]" style="color:#10b981;">${totalCorrect}</div>
                      </div>
                      <div class="rounded-xl p-3 flex flex-col justify-center transition-colors border" style="background:#f8fafc; border-color:#e2e8f0;" onmouseover="this.style.borderColor='#9ca3af'" onmouseout="this.style.borderColor='#e2e8f0'">
                          <div class="text-[10px] uppercase font-bold tracking-wider mb-1" style="color:#6b7280;">Remaining</div>
                          <div class="font-title-md font-bold text-[18px]" style="color:#111827;">${totalQuestions - totalAnswered}</div>
                      </div>
                  </div>
              </div>

              <div class="rounded-2xl p-6 shadow-sm lg:col-span-2" style="background:#fff; border:1px solid #e2e8f0;">
                  <h3 class="font-title-md mb-4" style="color:#111827;">Accuracy by Specialty</h3>
                  <div class="relative h-[250px] w-full">
                      <canvas id="performanceChart"></canvas>
                  </div>
              </div>
          </div>

          <div>
              <h3 class="font-headline-lg text-[22px] mb-4 mt-4" style="color:#111827;">Specialty Breakdown</h3>
              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  ${specialtyListHtml}
              </div>
          </div>
      </div>
      `;

      // Initialize Chart
      if (labels.length > 0 && window.Chart) {
          const ctx = document.getElementById('performanceChart');
          if (ctx) {
              if (performanceChartInstance) {
                  performanceChartInstance.destroy();
              }

              // Top 10 specialties to avoid chart clutter
              const chartLabels = labels.slice(0, 10);
              const chartData = dataScore.slice(0, 10);

              performanceChartInstance = new Chart(ctx.getContext('2d'), {
                  type: 'bar',
                  data: {
                      labels: chartLabels,
                      datasets: [{
                          label: 'Accuracy (%)',
                          data: chartData,
                          backgroundColor: 'rgba(0, 122, 122, 0.7)',
                          hoverBackgroundColor: 'rgba(0, 122, 122, 1)',
                          borderColor: 'rgba(0, 122, 122, 1)',
                          borderWidth: 1,
                          borderRadius: 6
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      layout: {
                          padding: {
                              top: 20
                          }
                      },
                      scales: {
                          y: {
                              beginAtZero: true,
                              max: 100,
                              grid: {
                                  color: 'rgba(0, 0, 0, 0.08)',
                                  drawBorder: false
                              },
                              ticks: {
                                  stepSize: 20,
                                  color: '#6f797b',
                                  font: { family: 'Inter', size: 11, weight: '600' }
                              }
                          },
                          x: {
                              grid: {
                                  display: false,
                                  drawBorder: false
                              },
                              ticks: {
                                  color: '#6f797b',
                                  font: { family: 'Inter', size: 11, weight: '600' }
                              }
                          }
                      },
                      plugins: {
                          legend: {
                              display: false
                          },
                          tooltip: {
                              backgroundColor: '#005c5c',
                              titleFont: { family: 'Inter', size: 13, weight: 'bold' },
                              bodyFont: { family: 'Inter', size: 12 },
                              padding: 10,
                              displayColors: false,
                              cornerRadius: 8
                          }
                      }
                  },
                  plugins: [{
                      id: 'customDataLabels',
                      afterDatasetsDraw: (chart) => {
                          const ctx = chart.ctx;
                          chart.data.datasets.forEach((dataset, i) => {
                              const meta = chart.getDatasetMeta(i);
                              meta.data.forEach((bar, index) => {
                                  const data = dataset.data[index];
                                  if (data > 0) {
                                      ctx.fillStyle = '#007a7a';
                                      ctx.font = 'bold 12px Inter';
                                      ctx.textAlign = 'center';
                                      ctx.textBaseline = 'bottom';
                                      ctx.fillText(data + '%', bar.x, bar.y - 6);
                                  }
                              });
                          });
                      }
                  }]
              });
          }
      }
  }
  
  window.renderDashboardPlannerWidget = function() {
      const widget = document.getElementById("dashboard-planner-widget");
      if (!widget) return;
      
      let tasks = [];
      try {
          tasks = JSON.parse(localStorage.getItem("omnote_planner_tasks") || "[]");
      } catch (e) {
          tasks = [];
      }
      
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      
      const todayTasks = tasks.filter(t => t.date === todayKey);
      const completed = todayTasks.filter(t => t.completed).length;
      
      let taskHtml = '';
      if (todayTasks.length === 0) {
          taskHtml = '<div class="text-sm text-on-surface-variant p-3 text-center">No tasks for today. <br> Add one in the Full Calendar.</div>';
      } else {
          // Show up to 4 tasks on the dashboard widget
          todayTasks.slice(0, 4).forEach(t => {
              taskHtml += `
              <label class="flex items-start gap-3 p-3 rounded-lg hover:bg-surface-container transition-colors cursor-pointer group">
                  <input type="checkbox" ${t.completed ? 'checked' : ''} class="mt-1 rounded text-primary focus:ring-primary/20" onchange="window.plannerToggleTask && window.plannerToggleTask('${t.id}')">
                  <span class="text-sm flex-1 ${t.completed ? 'line-through opacity-50' : ''}">${window.escapeHtml ? window.escapeHtml(t.title) : t.title}</span>
              </label>
              `;
          });
          if (todayTasks.length > 4) {
              taskHtml += `<div class="text-center text-xs text-on-surface-variant mt-2">+${todayTasks.length - 4} more tasks</div>`;
          }
      }

      widget.innerHTML = `
      <div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30">
          <h2 class="font-headline-lg text-[20px] text-on-surface mb-4">Study Planner</h2>
          <div class="flex justify-between items-center mb-4 text-sm font-medium">
              <span class="text-on-surface-variant">Today</span>
              <span class="text-primary">${completed} / ${todayTasks.length} Tasks</span>
          </div>
          <div class="space-y-1 max-h-[220px] overflow-y-auto pr-1">
              ${taskHtml}
          </div>
          <button class="w-full mt-4 py-2 border border-outline-variant rounded-xl text-sm font-medium hover:bg-surface-container transition-colors" onclick="window.openPlanner && window.openPlanner()">View Full Calendar</button>
      </div>
      `;
  };

  // --- Answer Party Hooks ---
  window.qbankPartyStateChanged = function(questionChanged, statusChanged) {
      if (!window.QBankParty || !window.QBankParty.state.party) return;
      const state = window.QBankParty.state;
      
      if (state.isHost && state.party.status === "waiting" && !state.party.currentQuestionId) {
          if (currentQuestions && currentQuestions[currentIndex]) {
               window.firebase.firestore().collection("answerParties").doc(state.code).update({
                   currentQuestionId: currentQuestions[currentIndex].id
               }).catch(e => console.error(e));
          }
      }
      
      if (state.party.status === "playing" || state.party.status === "waiting") {
          if (questionChanged && currentQuestions && state.party.currentQuestionId) {
             const idx = currentQuestions.findIndex(q => q.id === state.party.currentQuestionId);
             if (idx >= 0 && currentIndex !== idx) {
                 currentIndex = idx;
                 window.currentIndex = idx;
                 if (typeof window.qbankRenderSidebar === 'function') {
                    window.qbankRenderSidebar();
                 }
                 if (typeof window.qbankRenderCurrent === 'function') {
                    window.qbankRenderCurrent();
                 }
             }
          }
          const expl = document.getElementById("qbank-explanation-container");
          if (expl) expl.style.display = "none";
          
          const submitBtn = document.getElementById("qbank-submit-btn");
          if (submitBtn) {
              submitBtn.style.display = "block";
              if (state.party.status === "waiting") {
                  submitBtn.disabled = true;
                  submitBtn.innerHTML = 'Waiting for Host...';
              } else if (state.hasLocked) {
                  submitBtn.disabled = true;
                  submitBtn.innerHTML = '<i data-lucide="lock" style="width:16px;height:16px;"></i> Locked';
                  if (window.lucide) window.lucide.createIcons();
              } else {
                  submitBtn.disabled = false;
                  submitBtn.innerHTML = 'Lock Answer';
              }
          }
      } else if (state.party.status === "revealing") {
          window.qbankRevealPartyAnswers();
      }
  };

  window.qbankPartyMembersChanged = function() {};
  window.qbankPartyChatChanged = function() {};

  window.qbankPartyLockAnswer = function() {
      if (!window.QBankParty || !window.QBankParty.state.party) return;
      const q = currentQuestions[currentIndex];
      const data = q.data || {};
      const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
      const isMultiple = correctIndices.length > 1;

      let selectedIndices = [];
      const inputs = document.getElementsByName("qbank-radio");
      inputs.forEach(r => { if (r.checked) selectedIndices.push(parseInt(r.value, 10)); });
      
      if (selectedIndices.length === 0) {
          window.qbankToast("Please select an answer to lock.", true);
          return;
      }
      
      window.QBankParty.state.hasLocked = true;
      window.QBankParty.lockAnswer(selectedIndices);
      window.qbankPartyStateChanged(false, false);
  };
  
  window.qbankRevealPartyAnswers = function() {
       const q = currentQuestions[currentIndex];
       const data = q.data || {};
       const correctIndices = Array.isArray(data.correctIndices) ? data.correctIndices : (data.correctOptionIndex !== undefined ? [data.correctOptionIndex] : []);
       
       let u = null;
       if (window.firebase && window.firebase.auth) u = window.firebase.auth().currentUser;
       const uid = u ? u.uid : null;
       
       const myLock = window.QBankParty.state.members.find(m => m.uid === uid)?.lockedAnswer || [];
       
       let isCorrect = false;
       if (myLock.length === correctIndices.length && myLock.every(v => correctIndices.includes(v))) {
           isCorrect = true;
       }
       
       if (isCorrect && window.lastScoredQuestionId !== q.id) {
           window.lastScoredQuestionId = q.id;
           window.QBankParty.updateScore(100);
       }
       
       const inputs = document.getElementsByName("qbank-radio");
       inputs.forEach(r => {
           r.disabled = true;
           const val = parseInt(r.value, 10);
           const label = r.closest('label');
           if (correctIndices.includes(val)) {
               label.classList.add("correct");
               label.style.background = "rgba(34,197,94,0.1)";
               label.style.border = "1px solid #22c55e";
               label.style.borderRadius = "8px";
               label.style.padding = "8px";
           } else if (myLock.includes(val)) {
               label.classList.add("incorrect");
               label.style.background = "rgba(244,63,94,0.1)";
               label.style.border = "1px solid #f43f5e";
               label.style.borderRadius = "8px";
               label.style.padding = "8px";
           }
       });
       
       const expl = document.getElementById("qbank-explanation-container");
       if (expl) expl.style.display = "block";
       
       const submitBtn = document.getElementById("qbank-submit-btn");
       if (submitBtn) submitBtn.style.display = "none";
       
       const resultHeader = document.getElementById("qbank-result-header");
       if (resultHeader) {
           if (isCorrect) {
               resultHeader.innerHTML = '<span style="color:#22c55e;"><i data-lucide="check-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Correct</span>';
           } else {
               resultHeader.innerHTML = '<span style="color:#f43f5e;"><i data-lucide="x-circle" style="width:18px;height:18px;vertical-align:-3px;"></i> Incorrect</span>';
           }
           if (window.lucide) window.lucide.createIcons();
       }
       
       if (qbankTimer) {
          clearInterval(qbankTimer);
          qbankTimer = null;
       }
       
       window.QBankParty.revealOthers();
  };

  window.openQBankResourcesTab = async function() {
      if (window.hideAllMainViews) window.hideAllMainViews();
      const view = document.getElementById('resources-view');
      if (view) {
          view.style.display = 'flex';
          view.style.flexDirection = 'column';
      }
      
      // Update Sidebar active state
      document.querySelectorAll('nav a').forEach(a => {
          a.classList.remove('border-primary', 'bg-primary/10', 'text-primary', 'font-bold');
          a.classList.add('border-transparent', 'text-on-surface-variant', 'font-medium');
        });
        const tab = document.querySelector('nav a[data-path="resources"]');
        if (tab) {
          tab.classList.remove('border-transparent', 'text-on-surface-variant', 'font-medium');
          tab.classList.add('border-primary', 'bg-primary/10', 'text-primary', 'font-bold');
        }
      
      let html = `<div style="max-width:1400px; margin:0 auto; width:100%; padding-bottom:40px;">
          <h2 style="font-size:1.8rem; font-weight:700; margin-bottom:8px; color:var(--text-primary);">Study Resources</h2>
          <p style="margin:0 0 30px 0; font-size:1rem; color:var(--text-muted);">Explore hand-picked study materials for your question banks.</p>
      `;
      
      // Ensure we have the latest qbanks data
      try {
          const res = await apiGet("list_categories");
          qbanks = res.qbanks || [];
          cachedCategories = res.qbanks || [];
      } catch(e) {
          console.error("Failed to refresh resources:", e);
      }

      let hasAnyResources = false;
      
      if (qbanks && qbanks.length > 0) {
          for (const q of qbanks) {
              const res = q.resources || [];
              if (res.length > 0) {
                  hasAnyResources = true;
                  html += `<div style="margin-bottom:40px;">`;
                  html += `<h3 style="font-size:1.3rem; font-weight:600; margin-bottom:20px; color:var(--accent-cyan); display:flex; align-items:center; gap:8px;">
                     <i data-lucide="folder" style="width:20px;height:20px;"></i> ${window.escapeHtml ? window.escapeHtml(q.name) : q.name}
                  </h3>`;
                  
                  let normalizedResources = [];
                  let uncategorized = [];
                  
                  res.forEach(r => {
                      if (r.isCategory) {
                          normalizedResources.push(r);
                      } else {
                          uncategorized.push(r);
                      }
                  });
                  if (uncategorized.length > 0) {
                      normalizedResources.push({ id: 'cat-general', isCategory: true, title: 'General Resources', items: uncategorized });
                  }
                  
                  for (const catData of normalizedResources) {
                      if (!catData.items || catData.items.length === 0) continue;
                      html += `<div style="margin-bottom:24px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:12px; padding:20px;">`;
                      html += `<h4 style="font-size:1.1rem; font-weight:600; margin-top:0; margin-bottom:16px; color:var(--text-primary);">${window.escapeHtml(catData.title)}</h4>`;
                      html += `<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap:16px;">`;
                      
                      catData.items.forEach(r => {
                          const isYT = r.url && (r.url.includes("youtube.com") || r.url.includes("youtu.be"));
                          const clickHandler = isYT ? `onclick="window.openYouTubeModal('${r.url}')"` : `href="${r.url}" target="_blank"`;
                          const tag = isYT ? 'div' : 'a';
                          
                          let icon = "link";
                          let color = "var(--text-muted)";
                          if (r.type === "youtube" || r.type === "video") { icon = "play-circle"; color = "#ef4444"; }
                          else if (r.type === "pdf") { icon = "file-text"; color = "#3b82f6"; }
                          else if (r.type === "flashcards" || r.type === "deck") { icon = "layers"; color = "#10b981"; }
                          
                          html += `<${tag} ${clickHandler} style="display:flex; align-items:flex-start; gap:12px; padding:16px; background:var(--bg-card); border:1px solid var(--border-color); border-radius:10px; text-decoration:none; color:inherit; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor='var(--accent-cyan)'; this.style.transform='translateY(-2px)';" onmouseout="this.style.borderColor='var(--border-color)'; this.style.transform='translateY(0)';">
                              <i data-lucide="${icon}" style="width:24px;height:24px;color:${color}; flex-shrink:0;"></i>
                              <div style="flex:1;">
                                  <div style="font-weight:600; font-size:1rem; margin-bottom:4px; color:var(--text-primary); line-height:1.3;">${window.escapeHtml(r.title)}</div>
                                  ${r.description ? `<div style="font-size:0.85rem; color:var(--text-muted); line-height:1.4;">${window.escapeHtml(r.description)}</div>` : ''}
                              </div>
                              <i data-lucide="${isYT ? 'play' : 'external-link'}" style="width:16px;height:16px;color:var(--text-muted);opacity:0.5;flex-shrink:0;"></i>
                          </${tag}>`;
                      });
                      
                      html += `</div></div>`;
                  }
                  
                  html += `</div>`;
              }
          }
      }
      
      if (!hasAnyResources) {
          html += `
          <div style="text-align:center; padding:60px 20px; background:rgba(255,255,255,0.02); border:1px dashed rgba(255,255,255,0.1); border-radius:16px;">
              <i data-lucide="folder-open" style="width:48px;height:48px;color:var(--text-muted);opacity:0.5;margin-bottom:16px;"></i>
              <h3 style="font-size:1.2rem; color:var(--text-primary); margin:0 0 8px 0;">No Resources Available</h3>
              <p style="color:var(--text-muted); margin:0;">There are no study materials linked to any of the available question banks yet.</p>
          </div>`;
      }
      
      html += `</div>`;
      
            if (view) view.innerHTML = html;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  // ---------- EXAM PREP STANDALONE SIDEBAR TAB (countries -> colleges -> banks) ----------
  const EP_FLAG_CODES = { global: "un", usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma" };
  const EP_COUNTRY_LABELS = { global: "Global", usa: "USA", uk: "UK", australia: "Australia", canada: "Canada", india: "India", europe: "Europe", tunisia: "Tunisia", algeria: "Algeria", egypt: "Egypt", morocco: "Morocco" };

  const getEpFlagImg = (c, size = 40) => {
      const code = EP_FLAG_CODES[c] || "un";
      return `<img src="https://flagcdn.com/${code}.svg" style="width:${size}px; border-radius:4px; vertical-align:middle; display:inline-block;" alt=""/>`;
  };

  window.__epState = { country: null };

  window.epShowCountries = function() {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl || !window.__epBanks) return;
      window.__epState.country = null;

      // group counts by country
      const counts = {};
      window.__epBanks.forEach(q => {
          const c = q.country || "global";
          counts[c] = (counts[c] || 0) + 1;
      });

      let out = '<div class="ep-countries" style="display:flex; flex-wrap:wrap; gap:20px;">';
      Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(c => {
          out += `<button onclick="window.epShowColleges('${c}')" style="background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:24px; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:12px; width:160px; transition:all 0.2s; box-shadow:0 1px 3px rgba(0,0,0,0.05);" onmouseover="this.style.transform='translateY(-2px)'; this.style.borderColor='#007a7a'; this.style.boxShadow='0 4px 6px -1px rgba(0,0,0,0.1)';" onmouseout="this.style.transform='translateY(0)'; this.style.borderColor='#e2e8f0'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.05)';">
              <span style="display:flex; justify-content:center; align-items:center;">${getEpFlagImg(c, 48)}</span>
              <span style="font-weight:700; font-size:1.1rem; color:#111827;">${window.escapeHtml ? window.escapeHtml(EP_COUNTRY_LABELS[c] || c) : (EP_COUNTRY_LABELS[c] || c)}</span>
              <span style="font-size:0.8rem; font-weight:600; color:#007a7a; background:#e6f2f2; padding:4px 12px; border-radius:999px;">${counts[c]} bank${counts[c] > 1 ? 's' : ''}</span>
          </button>`;
      });
      out += '</div>';
      listEl.innerHTML = out;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.epShowColleges = function(country) {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl || !window.__epBanks) return;
      window.__epState.country = country;

      const banks = window.__epBanks.filter(q => (q.country || "global") === country);
      const byCollege = {};
      banks.forEach(q => {
          const col = q.college || "General";
          if (!byCollege[col]) byCollege[col] = [];
          byCollege[col].push(q);
      });

      let out = `<div style="max-width:1000px; margin:0 auto;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:24px;">
              <div style="display:flex; align-items:center; gap:8px;">
                  <a href="#" onclick="window.openExamPrepTab(); return false;" style="color:#6b7280; font-size:0.9rem; text-decoration:none; transition:color 0.2s;" onmouseover="this.style.color='#007a7a'" onmouseout="this.style.color='#6b7280'">Exam Prep</a>
                  <i data-lucide="chevron-right" style="width:14px;height:14px;color:#9ca3af;"></i>
                  <h3 style="display:flex; align-items:center; gap:8px; margin:0; font-size:1.1rem; font-weight:600; color:#111827;">${getEpFlagImg(country, 24)} ${window.escapeHtml ? window.escapeHtml(EP_COUNTRY_LABELS[country] || country) : country}</h3>
              </div>
              <button onclick="window.epShowCountries()" style="display:flex; align-items:center; gap:6px; padding:8px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; color:#6b7280; font-size:0.85rem; font-weight:500; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f8fafc'">
                  <i data-lucide="arrow-left" style="width:14px;height:14px;"></i> All countries
              </button>
          </div>
          <div style="display:flex; flex-direction:column; gap:12px;">`;

      if (Object.keys(byCollege).length === 1 && byCollege["General"]) {
          banks.forEach(q => {
              out += window.__epBankRow(q);
          });
      } else {
          Object.keys(byCollege).sort().forEach(col => {
              const collegeBanks = byCollege[col];
              const firstBank = collegeBanks[0];
              const safeName = (window.escapeHtml ? window.escapeHtml(firstBank.name) : firstBank.name).replace(/'/g, "\\'");
              
              const actionBtn = firstBank.locked
                  ? `<button style="background:#fff1f2; color:#e11d48; border:none; padding:8px 16px; border-radius:8px; font-weight:600; font-size:0.9rem; cursor:pointer;" onclick="event.stopPropagation(); window.qbankRequestAccess('${firstBank.id}', '${safeName}')">Request Access</button>`
                  : `<button style="background:#007a7a; color:#fff; border:none; padding:8px 16px; border-radius:8px; font-weight:600; font-size:0.9rem; cursor:pointer; display:flex; align-items:center; gap:6px; transition:background 0.2s;" onmouseover="this.style.background='#006666'" onmouseout="this.style.background='#007a7a'" onclick="event.stopPropagation(); window.startQBankSession('${firstBank.id}', '${safeName}')">Practice <i data-lucide="arrow-right" style="width:14px;height:14px;"></i></button>`;

              out += `
              <div onclick="${firstBank.locked ? `window.qbankRequestAccess('${firstBank.id}', '${safeName}')` : `window.startQBankSession('${firstBank.id}', '${safeName}')`}" style="background:transparent; border:none; border-bottom:1px solid #e2e8f0; padding:16px 0; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; justify-content:space-between; opacity:${firstBank.locked ? '0.6' : '1'};" onmouseover="this.style.transform='translateX(4px)'; this.style.borderBottomColor='#007a7a';" onmouseout="this.style.transform='translateX(0)'; this.style.borderBottomColor='#e2e8f0';">
                  <div style="display:flex; align-items:center; gap:16px;">
                      <div style="flex-shrink:0; display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;">
                          <i data-lucide="${firstBank.locked ? 'lock' : 'graduation-cap'}" style="width:20px;height:20px;color:${firstBank.locked ? '#9ca3af' : '#007a7a'};"></i>
                      </div>
                      <div style="display:flex; flex-direction:column; justify-content:center;">
                          <h4 style="font-size:1rem; font-weight:600; margin:0; color:#111827;">${window.escapeHtml ? window.escapeHtml(col) : col}</h4>
                          <div style="font-size:0.8rem; color:#6b7280; margin-top:4px;">${window.escapeHtml ? window.escapeHtml(firstBank.name) : firstBank.name} • ${collegeBanks.length} bank${collegeBanks.length > 1 ? 's' : ''}</div>
                      </div>
                  </div>
                  ${actionBtn}
              </div>`;
          });
      }

      out += `</div></div>`;
      listEl.innerHTML = out;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.__epBankRow = function(q) {
      const cached = cachedQBanks[q.id];
      const qCount = cached && cached.questions ? cached.questions.length : 0;
      const countLabel = qCount > 0 ? `${qCount.toLocaleString()} questions` : "No questions yet";
      const yearBadge = q.year ? `<span style="font-size:0.7rem; color:var(--text-muted); background:rgba(255,255,255,0.05); padding:2px 8px; border-radius:4px;">${window.escapeHtml ? window.escapeHtml(q.year) : q.year}</span>` : "";
      const safeName = (window.escapeHtml ? window.escapeHtml(q.name) : q.name).replace(/'/g, "\\'");
      const college = q.college || "General";
      
      const actionBtn = q.locked
          ? `<button style="background:#fff1f2; color:#e11d48; border:none; padding:8px 16px; border-radius:8px; font-weight:600; font-size:0.9rem; cursor:pointer;" onclick="event.stopPropagation(); window.qbankRequestAccess('${q.id}', '${safeName}')">Request Access</button>`
          : `<button style="background:#007a7a; color:#fff; border:none; padding:8px 16px; border-radius:8px; font-weight:600; font-size:0.9rem; cursor:pointer; display:flex; align-items:center; gap:6px; transition:background 0.2s;" onmouseover="this.style.background='#006666'" onmouseout="this.style.background='#007a7a'" onclick="event.stopPropagation(); window.startQBankSession('${q.id}', '${safeName}')">Practice <i data-lucide="arrow-right" style="width:14px;height:14px;"></i></button>`;

      return `
      <div onclick="${q.locked ? `window.qbankRequestAccess('${q.id}', '${safeName}')` : `window.startQBankSession('${q.id}', '${safeName}')`}" style="background:transparent; border:none; border-bottom:1px solid #e2e8f0; padding:16px 0; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; justify-content:space-between; opacity:${q.locked ? '0.6' : '1'};" onmouseover="this.style.transform='translateX(4px)'; this.style.borderBottomColor='#007a7a';" onmouseout="this.style.transform='translateX(0)'; this.style.borderBottomColor='#e2e8f0';">
          <div style="display:flex; align-items:center; gap:16px;">
              <div style="flex-shrink:0; display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;">
                  <i data-lucide="${q.locked ? 'lock' : 'graduation-cap'}" style="width:20px;height:20px;color:${q.locked ? '#9ca3af' : '#007a7a'};"></i>
              </div>
              <div style="display:flex; flex-direction:column; justify-content:center;">
                  <h4 style="font-size:1rem; font-weight:600; margin:0; color:#111827;">${window.escapeHtml ? window.escapeHtml(college) : college}</h4>
                  <div style="font-size:0.8rem; color:#6b7280; margin-top:4px;">${window.escapeHtml ? window.escapeHtml(q.name) : q.name} • ${countLabel}</div>
              </div>
          </div>
          ${actionBtn}
      </div>`;
  };

  window.epShowBanks = function(country, college) {
      const listEl = document.getElementById("exam-prep-content");
      if (!listEl || !window.__epBanks) return;

      const banks = window.__epBanks.filter(q =>
          (q.country || "global") === country &&
          (q.college || "General") === college
      );

      let out = `<div style="max-width:1000px; margin:0 auto;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:24px;">
              <div style="display:flex; align-items:center; gap:8px;">
                  <a href="#" onclick="window.openExamPrepTab(); return false;" style="color:#6b7280; font-size:0.9rem; text-decoration:none; transition:color 0.2s;" onmouseover="this.style.color='#007a7a'" onmouseout="this.style.color='#6b7280'">Exam Prep</a>
                  <i data-lucide="chevron-right" style="width:14px;height:14px;color:#9ca3af;"></i>
                  <button onclick="window.epShowColleges('${country}')" style="display:flex; align-items:center; gap:4px; padding:4px 8px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; color:#6b7280; font-size:0.85rem; font-weight:500; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor='#9ca3af'" onmouseout="this.style.borderColor='#e2e8f0'">
                      ${getEpFlagImg(country, 16)} ${window.escapeHtml ? window.escapeHtml(EP_COUNTRY_LABELS[country] || country) : country}
                  </button>
                  <i data-lucide="chevron-right" style="width:14px;height:14px;color:#9ca3af;"></i>
                  <h3 style="margin:0; font-size:1.1rem; font-weight:600; color:#111827;">${window.escapeHtml ? window.escapeHtml(college) : college}</h3>
              </div>
          </div>
          <div style="display:flex; flex-direction:column; gap:12px;">`;

      banks.forEach(q => {
          out += window.__epBankRow(q);
      });

      out += `</div></div>`;
      listEl.innerHTML = out;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };



  window.openExamPrepTab = async function() {
      if (window.hideAllMainViews) window.hideAllMainViews();
      const view = document.getElementById('resources-view');
      if (view) {
          view.style.display = 'flex';
          view.style.flexDirection = 'column';
      }

      document.querySelectorAll('nav a').forEach(a => {
          a.classList.remove('border-[#007a7a]', 'bg-[#007a7a]/5', 'text-[#007a7a]', 'font-bold');
          a.classList.add('border-transparent', 'text-gray-600', 'font-medium');
      });
      const tab = document.querySelector('nav a[data-path="exam-prep"]');
      if (tab) {
          tab.classList.remove('border-transparent', 'text-gray-600', 'font-medium');
          tab.classList.add('border-[#007a7a]', 'bg-[#007a7a]/5', 'text-[#007a7a]', 'font-bold');
      }

      if (view) view.innerHTML = `<div style="max-width:1000px; margin:0 auto; width:100%; padding-bottom:40px;">
          <h2 style="font-size:1.8rem; font-weight:700; margin-bottom:8px; color:#111827; display:flex; align-items:center; gap:12px;">
              <i data-lucide="graduation-cap" style="width:30px;height:30px;color:#007a7a;"></i> Exam Prep
          </h2>
          <p style="margin:0 0 28px 0; font-size:1rem; color:#6b7280;">Browse past exams by country, then pick your college.</p>
          <div id="exam-prep-content" style="color:#6b7280; text-align:center; padding:24px;">Loading…</div>
      </div>`;
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

      try {
          await window.preloadQBank();
          qbanks = cachedCategories || [];
      } catch (e) { console.error("preload failed:", e); }

      await window.bootstrapAccess(); // always fresh
      const acc = window.db.access || null;
      const prepAllowed = (id) => !acc || acc.legacy || !acc.country || acc.grants.includes(id) || acc.prepIds.includes(id);
      window.__epBanks = (qbanks || []).filter(q => q.kind === "exam_prep").map(q => ({
        ...q,
        locked: !prepAllowed(q.id),
      }));
      window.epShowCountries();

      if (view) view.scrollTop = 0;
  };

  window.openYouTubeModal = function(url) {
      let videoId = '';
      if (url.includes('youtube.com/watch?v=')) {
          videoId = url.split('v=')[1].split('&')[0];
      } else if (url.includes('youtu.be/')) {
          videoId = url.split('youtu.be/')[1].split('?')[0];
      } else if (url.includes('youtube.com/embed/')) {
          videoId = url.split('youtube.com/embed/')[1].split('?')[0];
      }
      
      if (!videoId) {
          window.open(url, '_blank');
          return;
      }
      
      let modal = document.getElementById("youtube-player-modal");
      if (!modal) {
          modal = document.createElement("div");
          modal.id = "youtube-player-modal";
          modal.className = "fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6";
          modal.style.backgroundColor = "rgba(0,0,0,0.85)";
          modal.style.backdropFilter = "blur(8px)";
          
          modal.innerHTML = `
              <div class="bg-surface-container-high rounded-2xl shadow-2xl w-full max-w-5xl overflow-hidden flex flex-col relative border border-outline-variant/20 transform scale-95 opacity-0 transition-all duration-300" id="youtube-player-content">
                  <button onclick="document.getElementById('youtube-player-modal').style.opacity='0'; document.getElementById('youtube-player-content').style.transform='scale(0.95)'; setTimeout(()=>{document.getElementById('youtube-player-modal').style.display='none'; document.getElementById('youtube-iframe').src='';}, 300);" class="absolute top-4 right-4 w-10 h-10 rounded-full bg-surface-container-highest hover:bg-surface-container flex items-center justify-center text-on-surface transition-colors z-10">
                      <span class="material-symbols-outlined">close</span>
                  </button>
                  <div class="relative w-full" style="padding-top: 56.25%;">
                      <iframe id="youtube-iframe" class="absolute inset-0 w-full h-full border-0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
                  </div>
              </div>
          `;
          document.body.appendChild(modal);
      }
      
      document.getElementById("youtube-iframe").src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
      modal.style.display = "flex";
      
      // Animate in
      setTimeout(() => {
          modal.style.opacity = "1";
          document.getElementById('youtube-player-content').style.opacity = "1";
          document.getElementById('youtube-player-content').style.transform = "scale(1)";
      }, 10);
  };

})();

// Admin Diagnostic System
(function() {
  let diagnosticData = { reads: 0, writes: 0, logs: [] };
  
  window.logAdminDiagnostic = function(action, reads, writes) {
    diagnosticData.reads += reads;
    diagnosticData.writes += writes;
    diagnosticData.logs.unshift({
      time: new Date().toLocaleTimeString(),
      action, reads, writes
    });
    if (diagnosticData.logs.length > 50) diagnosticData.logs.pop();
    
    if (window.isQBankAdmin) {
       renderAdminDiagnosticWidget();
    }
  };

  // Global fetch interceptor
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    if (!args[0] || typeof args[0] === 'string' && !args[0].includes('/api/')) return originalFetch.apply(this, args);
    let logName = "API Call";
    let isApi = false;
    
    try {
      const urlStr = args[0] instanceof Request ? args[0].url : args[0];
      const urlObj = new URL(urlStr, window.location.origin);
      
      if (urlObj.pathname.startsWith('/api/')) {
        isApi = true;
        let method = 'GET';
        if (args[0] instanceof Request) method = args[0].method;
        else if (args[1] && args[1].method) method = args[1].method;
        method = method.toUpperCase();
        
        let action = urlObj.searchParams.get('action');
        if (!action && method !== 'GET' && args[1] && args[1].body) {
           try {
             const bodyStr = typeof args[1].body === 'string' ? args[1].body : '';
             if (bodyStr) {
               const parsed = JSON.parse(bodyStr);
               action = parsed.action;
             }
           } catch(e) {}
        }
        
        let endpoint = urlObj.pathname.replace('/api/', '');
        logName = `${method} /api/${endpoint}${action ? ' [' + action + ']' : ''}`;
      }
    } catch (e) {}
    
    const res = await originalFetch.apply(this, args);
    
    if (isApi) {
        try {
            let reads = parseInt(res.headers.get('x-firestore-reads') || '0', 10);
            let writes = parseInt(res.headers.get('x-firestore-writes') || '0', 10);
            
            // Fallback heuristics if backend headers are missing
            if (!res.headers.has('x-firestore-reads')) {
                const m = logName.split(' ')[0];
                reads = m === 'GET' ? 1 : 0;
                writes = m !== 'GET' ? 1 : 0;
            }
            
            window.logAdminDiagnostic(logName, reads, writes);
        } catch(e) {}
    }
    
    return res;
  };
  
  function renderAdminDiagnosticWidget() {
    let w = document.getElementById('admin-diagnostic-widget');
    if (!w) {
      w = document.createElement('div');
      w.id = 'admin-diagnostic-widget';
      w.style.cssText = 'position:fixed;bottom:20px;left:20px;background:var(--surface-container-high, #1e1e1e);color:var(--on-surface, #e2e2e2);z-index:99999;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-size:12px;font-family:monospace;overflow:hidden;border:1px solid var(--outline, #444);width:280px;';
      
      const head = document.createElement('div');
      head.style.cssText = 'padding:8px 12px;background:var(--surface-container-highest, #2d2d2d);cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-weight:bold;user-select:none;';
      head.innerHTML = `<span>Admin DB Diagnostics</span><span id="adw-toggle">▲</span>`;
      head.onclick = () => {
        const body = document.getElementById('adw-body');
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        document.getElementById('adw-toggle').textContent = isHidden ? '▼' : '▲';
      };
      w.appendChild(head);
      
      const body = document.createElement('div');
      body.id = 'adw-body';
      body.style.cssText = 'display:none;';
      w.appendChild(body);
      
      document.body.appendChild(w);
    }
    
    const body = document.getElementById('adw-body');
    let html = `<div style="padding:8px 12px;border-bottom:1px solid var(--outline, #444);display:flex;gap:12px;">
      <div style="color:#22c55e;">Reads: <b>${diagnosticData.reads}</b></div>
      <div style="color:#eab308;">Writes: <b>${diagnosticData.writes}</b></div>
    </div>`;
    
    html += `<div style="max-height:200px;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:6px;">`;
    diagnosticData.logs.forEach(l => {
      let cost = [];
      if (l.reads > 0) cost.push(`<span style="color:#22c55e;white-space:nowrap;">${l.reads}r</span>`);
      if (l.writes > 0) cost.push(`<span style="color:#eab308;white-space:nowrap;">${l.writes}w</span>`);
      if (cost.length === 0) cost.push(`<span style="color:var(--text-muted);white-space:nowrap;">0</span>`);
      html += `<div style="display:flex;justify-content:space-between;opacity:0.9;border-bottom:1px solid var(--outline-variant, #333);padding-bottom:2px;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px;" title="${l.action}">[${l.time}] ${l.action}</span>
        <span>${cost.join(' ')}</span>
      </div>`;
    });
    html += `</div>`;
    
    body.innerHTML = html;
  }

  // Ensure it renders if admin status resolves late
  setInterval(async () => {
     if (window.checkAdmin && typeof window.isQBankAdmin === 'undefined') {
         window.isQBankAdmin = await window.checkAdmin();
     }
     if (window.isQBankAdmin && !document.getElementById('admin-diagnostic-widget')) {
         renderAdminDiagnosticWidget();
     }
  }, 1000);

})();
