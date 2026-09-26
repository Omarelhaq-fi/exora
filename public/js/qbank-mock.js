/* QBank Mock Exam — tunable time + per-subject counts, Tunisia Résidanat defaults.
 *
 * Setup: window.openQBankMockSetup(qbankId?)
 *   - lists every subject/category in the bank with a number input
 *   - groups subjects into 4 Résidanat modules (auto-classified by keywords)
 *   - Tunisia "Concours de Résidanat" default: 150 QCM, 180 min,
 *     ~80 clinical-case Qs + ~70 isolated Qs
 *   - sampling is stratified: round-robin across chapters inside each
 *     subject so "Cas clinique 1..N" style banks spread evenly, then
 *     case-subjects are preferred up to ~55% of each module quota
 *
 * Exam run: fullscreen #mock-exam-modal
 *   - left: our usmle-question-card style question page
 *   - right: Navigator grid + Pace card (layout from reference, teal theme)
 *   - no instant reveal; Finish & Score at the end with per-module report
 */
(function () {
  "use strict";

  var BRAND = "#007a7a";
  var BRAND_LIGHT = "#e6f2f2";

  // ---------- module classification ----------
  // Order matters: most-specific first (neurochir -> surgical before neuro -> medical).
  var MODULES = [
    {
      id: "surgical",
      label: "Spécialités Chirurgicales",
      hint: "Chirurgie, Orthopédie, Urologie, Neurochir, ORL, Ophtalmologie",
      keywords: [
        "neurochir", "neuro-chir", "chirurg", "surg", "orthop", "traumato",
        "urolog", "urol", "orl", "oto", "ophtal", "ophthal", "viscéral",
        "visceral", "thoracique", "vasculaire", "plastique", "stomato",
        "maxillo", "pédiatrie chirurg", "pediatric surg", "neuro-chirurg"
      ],
    },
    {
      id: "peds_gyn",
      label: "Pédiatrie & Gynécologie-Obstétrique",
      hint: "Pédiatrie, Néonatologie, Gynécologie, Obstétrique",
      keywords: [
        "pédiat", "pediat", "pédi", "neonat", "néonat", "gyneco", "gynéco",
        "gyn", "obst", "sage", "mater", "pueri", "enfant", "nourrisson"
      ],
    },
    {
      id: "basic",
      label: "Sciences Fondamentales & Préventives",
      hint: "Pharmacologie, Santé publique, Urgences, Réanimation",
      keywords: [
        "pharma", "santé publique", "sante publique", "prévent", "prevent",
        "épidémio", "epidemi", "hygiène", "hygiene", "médecine légale",
        "medecine legale", "urgence", "réanima", "reanima", "intensif",
        "soins intens", "toxico", "biostat", "éthique", "ethique",
        "santé communaut", "anesth", "radiologie d'urgence"
      ],
    },
    {
      id: "medical",
      label: "Spécialités Médicales",
      hint: "Cardio, Pneumo, Gastro, Neuro, Endocrino, Infectieux, Néphro, Hémato, Dermato",
      keywords: [
        "cardio", "pneumo", "pulmo", "respira", "gastro", "hepato",
        "digest", "neuro", "endocrin", "diab", "metabol", "infect",
        "nephro", "néphro", "hemato", "hémato", "dermato", "rhumat",
        "interne", "onco", "cancer", "allergo", "immuno", "geria",
        "psychi", "nephro", "urologie médicale", "pneumologie"
      ],
    },
  ];

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function isCaseSubject(name) {
    var n = " " + norm(name) + " ";
    return n.indexOf("cas clinique") !== -1 ||
      n.indexOf("clinical case") !== -1 ||
      n.indexOf(" cas ") !== -1 ||
      n.trim() === "cas";
  }

  function classifySubject(name) {
    var n = " " + norm(name) + " ";
    for (var m = 0; m < MODULES.length; m++) {
      var mod = MODULES[m];
      for (var k = 0; k < mod.keywords.length; k++) {
        if (n.indexOf(norm(mod.keywords[k])) !== -1) return mod.id;
      }
    }
    return "medical"; // default bucket — medical is the largest ECN module
  }

  // Bank metadata lookup across the exam-prep list + full bank list.
  function bankMetaOf(qbankId) {
    if (!qbankId) return null;
    try {
      var lists = [];
      if (window.__epBanks) lists.push(window.__epBanks);
      if (window.getQBankList) lists.push(window.getQBankList() || []);
      for (var l = 0; l < lists.length; l++) {
        var arr = lists[l] || [];
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] && arr[i].id === qbankId) return arr[i];
        }
      }
    } catch (_) {}
    return null;
  }

  function isTunisiaBank(qbankId, qbankName) {
    var meta = bankMetaOf(qbankId) || {};
    var hay = norm([qbankId, qbankName, meta.name, meta.country, meta.college].join(" "));
    if (hay.indexOf("residanat") !== -1 || hay.indexOf("residana") !== -1) return true;
    if (hay.indexOf("concours") !== -1 && hay.indexOf("tunis") !== -1) return true;
    return false;
  }

  // Tunisia default quotas per module (sum = 150).
  // Mirrors the real ECN split: ~80 case-dependent + ~70 isolated.
  var TUNISIA_MODULE_QUOTA = { medical: 45, surgical: 35, peds_gyn: 40, basic: 30 };
  var TUNISIA_DEFAULT_MIN = 180; // 3h per day session
  var GENERIC_DEFAULT_MIN = 60;
  var CASE_RATIO_TARGET = 0.53; // ~80/150

  // ---------- data access ----------
  function getBankQuestions(qbankId) {
    try {
      if (window.__mockExamQuestionCache && window.__mockExamQuestionCache[qbankId]) {
        return window.__mockExamQuestionCache[qbankId];
      }
    } catch (_) {}
    var entry = null;
    try {
      // cachedQBanks lives inside qbank.js closure — not global.
      // Fall back to what the UI already loaded.
      if (window.qbankCurrentSubjectStats && window.currentQuestions && window.currentQuestions.length) {
        return window.currentQuestions.slice();
      }
    } catch (_) {}
    return entry;
  }

  async function ensureBankLoaded(qbankId) {
    // Prefer the canonical loader so answer-split + progress stay consistent.
    if (window.startQBankSession && qbankId) {
      // startQBankSession renders the subject list as a side effect; we
      // immediately overwrite the area with our setup screen afterwards.
      try { await window.startQBankSession(qbankId, bankNameOf(qbankId)); } catch (_) {}
    }
    return collectStats();
  }

  function bankNameOf(qbankId) {
    var meta = bankMetaOf(qbankId);
    if (meta && meta.name) return meta.name;
    try {
      var el = document.getElementById("qbank-active-name");
      if (el && el.textContent) {
        var t = String(el.textContent).trim();
        if (t && t.toLowerCase() !== "none") return t;
      }
    } catch (_) {}
    return qbankId || "QBank";
  }

  // All known banks (exam-prep + regular) for the picker fallback.
  function allBanksList() {
    var out = [], seen = {};
    function push(arr) {
      (arr || []).forEach(function (b) {
        if (!b || !b.id || seen[b.id]) return;
        seen[b.id] = 1;
        out.push(b);
      });
    }
    try { push(window.__epBanks); } catch (_) {}
    try { if (window.getQBankList) push(window.getQBankList()); } catch (_) {}
    return out;
  }

  function collectStats() {
    var stats = window.qbankCurrentSubjectStats || {};
    var names = Object.keys(stats).filter(function (s) { return s !== "Uncategorized"; });
    return { stats: stats, names: names };
  }

  function esc(s) {
    if (window.escapeHtml) return window.escapeHtml(String(s == null ? "" : s));
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function jsEsc(s) {
    return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  // ---------- SETUP SCREEN ----------
  window.openQBankMockSetup = async function (requestedQBankId) {
    if (window.hideAllMainViews) window.hideAllMainViews();
    var view = document.getElementById("qbank-home-view");
    if (view) view.style.display = "flex";
    if (window.setQBankNav) window.setQBankNav("mock-exam");
    var area = document.getElementById("qbank-home-content");
    if (!area) return;

    var qbankId = requestedQBankId || null;
    try { if (!qbankId && window.getCurrentQBankId) qbankId = window.getCurrentQBankId(); } catch (_) {}
    if (!qbankId) qbankId = window.currentQBankId || (window.db && window.db.selectedQBankId) || null;

    area.innerHTML =
      '<div style="max-width:1100px;margin:0 auto;padding:24px 20px 60px;font-family:Inter,-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;">' +
      '<div style="width:40px;height:40px;border-radius:10px;background:' + BRAND_LIGHT + ';display:flex;align-items:center;justify-content:center;"><i data-lucide="timer" style="width:20px;height:20px;color:' + BRAND + ';"></i></div>' +
      '<h2 style="margin:0;font-size:1.5rem;font-weight:800;color:var(--text-primary, #0F172A);">Mock Exam Builder</h2></div>' +
      '<p style="margin:0 0 18px;color:var(--text-muted, #64748B);font-size:0.9rem;">Choose exam time and how many questions to pull from each subject. Sampling is stratified across chapters.</p>' +
      '<div style="background:var(--surface-color, #fff);border:1px solid var(--border-color, #E2E8F0);border-radius:12px;padding:28px;text-align:center;color:var(--text-muted, #64748B);">Loading subjects…</div></div>';
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

    // Metadata first: without the bank list, name lookup falls back to the
    // "None" placeholder and Tunisia detection misses (→ wrong 60-min default).
    try { if (window.preloadQBank) await window.preloadQBank(); } catch (_) {}

    if (!qbankId) {
      try { if (!qbankId && window.getCurrentQBankId) qbankId = window.getCurrentQBankId(); } catch (_) {}
      if (!qbankId) qbankId = window.currentQBankId || (window.db && window.db.selectedQBankId) || null;
    }
    if (!qbankId) {
      renderBankPicker(area);
      return;
    }

    // Load bank (renders subject list internally, then we overwrite).
    try {
      var nm = bankNameOf(qbankId);
      if (window.startQBankSession) await window.startQBankSession(qbankId, nm);
    } catch (e) { console.warn("[mock] bank load failed", e); }

    // Re-assert our view (startQBankSession switched it to subject list).
    if (window.hideAllMainViews) window.hideAllMainViews();
    if (view) view.style.display = "flex";

    var collected = collectStats();
    var stats = collected.stats;
    var names = collected.names;
    var bankName = bankNameOf(qbankId);

    if (!names.length) {
      area.innerHTML =
        '<div style="max-width:800px;margin:0 auto;padding:24px;font-family:Inter,sans-serif;">' +
        '<div style="background:var(--surface-color, #fff);border:1px solid var(--border-color, #E2E8F0);border-radius:12px;padding:28px;text-align:center;color:var(--text-muted, #64748B);">This QBank has no subjects yet.</div></div>';
      return;
    }

    var tunisia = isTunisiaBank(qbankId, bankName);
    renderSetup(area, qbankId, bankName, stats, names, tunisia);
  };

  // Bank picker shown when Mock Exam opens with no active bank.
  function renderBankPicker(area) {
    var banks = allBanksList();
    // Résidanat-style banks first.
    banks.sort(function (a, b) {
      var ta = isTunisiaBank(a.id, a.name) ? 0 : 1;
      var tb = isTunisiaBank(b.id, b.name) ? 0 : 1;
      return ta - tb || String(a.name || "").localeCompare(String(b.name || ""));
    });
    var rows = banks.map(function (q) {
      var sub = [q.college, q.country].filter(Boolean).join(" · ");
      return '<div style="display:flex; align-items:center; gap:10px; padding:10px 6px; margin:0 -6px; border-bottom:1px solid #F1F5F9; border-radius:4px;" onmouseover="this.style.background=\'#F8FAFC\'" onmouseout="this.style.background=\'transparent\'">' +
        '<div style="flex-shrink:0; display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:#e6f2f2; border-radius:6px;">' +
        '<i data-lucide="graduation-cap" style="width:20px;height:20px;color:#007a7a;"></i></div>' +
        '<div style="flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:2px;">' +
        '<div style="font-size:15px; font-weight:700; color:#0F172A; line-height:1.3;">' + esc(q.name || q.id) + "</div>" +
        (sub ? '<div style="font-size:12px; color:#64748B;">' + esc(sub) + "</div>" : "") + "</div>" +
        '<button onclick="window.openQBankMockSetup(\'' + jsEsc(q.id) + '\')" style="background:#007a7a; color:#fff; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; flex-shrink:0;" onmouseover="this.style.background=\'#006666\'" onmouseout="this.style.background=\'#007a7a\'">Build Mock</button>' +
        "</div>";
    }).join("");
    area.innerHTML =
      '<div style="max-width:1000px; margin:0 auto; font-family:Inter,-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif; padding-bottom:40px;">' +
      '<div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">' +
      '<div style="display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:#e6f2f2; border-radius:6px; flex-shrink:0;">' +
      '<i data-lucide="timer" style="width:20px;height:20px;color:#007a7a;"></i></div>' +
      '<h2 style="font-size:1.5rem; font-weight:700; margin:0; color:#0F172A;">Mock Exam</h2></div>' +
      '<p style="margin:0 0 24px 0; font-size:0.9rem; color:#64748B;">Pick a QBank to build your mock exam from.</p>' +
      '<div style="font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#64748B; margin:0 0 10px 0;">QBanks</div>' +
      '<div class="ep-card-rows" style="background:#fff; border:1px solid #E2E8F0; border-radius:6px; padding:6px 16px;">' +
      (rows || '<div style="padding:16px 12px; font-size:12px; color:#64748B; text-align:center;">No banks available yet.</div>') +
      "</div></div>";
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    try { if (window.__epEnsureRowStyle) window.__epEnsureRowStyle(); } catch (_) {}
  }

  function defaultQuotaFor(stats, names, tunisia) {
    // Returns { subjectName: count }
    var out = {};
    if (!tunisia) {
      names.forEach(function (n) { out[n] = Math.min(10, (stats[n] && stats[n].total) || 10); });
      return out;
    }
    // Group subjects per module, then split the module quota proportionally
    // to availability (so small subjects are not over-asked).
    var byMod = { medical: [], surgical: [], peds_gyn: [], basic: [] };
    names.forEach(function (n) { byMod[classifySubject(n)].push(n); });
    // Anything unclassified already fell into medical by classifySubject.
    Object.keys(TUNISIA_MODULE_QUOTA).forEach(function (mod) {
      var list = byMod[mod] || [];
      if (!list.length) return;
      var quota = TUNISIA_MODULE_QUOTA[mod];
      var avail = list.map(function (n) { return (stats[n] && stats[n].total) || 0; });
      var totalAvail = avail.reduce(function (a, b) { return a + b; }, 0) || 1;
      var assigned = 0;
      list.forEach(function (n, i) {
        var share = i === list.length - 1
          ? quota - assigned
          : Math.max(0, Math.round((avail[i] / totalAvail) * quota));
        share = Math.min(share, avail[i]);
        out[n] = share;
        assigned += share;
      });
    });
    // Fix rounding drift so the sum is exactly 150 (or max available).
    var sum = names.reduce(function (a, n) { return a + (out[n] || 0); }, 0);
    var target = 150;
    var totalAvailAll = names.reduce(function (a, n) { return a + ((stats[n] && stats[n].total) || 0); }, 0);
    if (totalAvailAll < target) target = totalAvailAll;
    var guard = 0;
    while (sum !== target && guard++ < 500) {
      var needMore = sum < target;
      var progressed = false;
      for (var i = 0; i < names.length && sum !== target; i++) {
        var n = names[i];
        var availN = (stats[n] && stats[n].total) || 0;
        if (needMore && (out[n] || 0) < availN) { out[n]++; sum++; progressed = true; }
        else if (!needMore && (out[n] || 0) > 0) { out[n]--; sum--; progressed = true; }
      }
      if (!progressed) break;
    }
    return out;
  }

  // Split `target` across buckets proportionally to `avails`, capped per
  // bucket, drift-corrected so the sum is exactly target (or max available).
  function splitQuota(avails, target) {
    var out = [], sum = 0, i;
    var totalAvail = avails.reduce(function (a, b) { return a + b; }, 0);
    target = Math.max(0, Math.min(target, totalAvail));
    for (i = 0; i < avails.length; i++) {
      var share = (i === avails.length - 1)
        ? target - sum
        : Math.round((totalAvail ? avails[i] / totalAvail : 0) * target);
      share = Math.max(0, Math.min(share, avails[i]));
      out.push(share);
      sum += share;
    }
    var guard = 0;
    while (sum !== target && guard++ < 2000) {
      var needMore = sum < target, progressed = false;
      for (var k = 0; k < avails.length && sum !== target; k++) {
        if (needMore && out[k] < avails[k]) { out[k]++; sum++; progressed = true; }
        else if (!needMore && out[k] > 0) { out[k]--; sum--; progressed = true; }
      }
      if (!progressed) break;
    }
    return out;
  }

  function renderSetup(area, qbankId, bankName, stats, names, tunisia) {
    var quota = defaultQuotaFor(stats, names, tunisia);
    var defaultMin = tunisia ? TUNISIA_DEFAULT_MIN : GENERIC_DEFAULT_MIN;
    var totalDefault = names.reduce(function (a, n) { return a + (quota[n] || 0); }, 0);

    // group for display
    var groups = { medical: [], surgical: [], peds_gyn: [], basic: [] };
    names.forEach(function (n) { groups[classifySubject(n)].push(n); });
    var groupMeta = {};
    MODULES.forEach(function (m) { groupMeta[m.id] = m; });

    var modOrder = ["medical", "surgical", "peds_gyn", "basic"].filter(function (id) {
      return (groups[id] || []).length > 0;
    });

    // Same row language as the Exam Prep bank lists: icon tile + titles +
    // divider rows inside one white card. Subjects with chapters
    // (sub-categories) get an expandable per-chapter breakdown so banks
    // with a single subject can still tune counts finely.
    try { if (window.__epEnsureRowStyle) window.__epEnsureRowStyle(); } catch (_) {}
    var expandChapters = names.length === 1;
    var caseFirstAlpha = function (a, b) {
      var ca = isCaseSubject(a) ? 0 : 1, cb = isCaseSubject(b) ? 0 : 1;
      return ca - cb || a.localeCompare(b);
    };
    // The French ECN module grouping belongs to the Tunisian Résidanat
    // bank only — every other bank gets a flat subject list.
    var sections;
    if (tunisia) {
      sections = modOrder.map(function (modId) {
        return {
          id: modId,
          label: groupMeta[modId].label,
          hint: groupMeta[modId].hint,
          list: groups[modId].slice().sort(caseFirstAlpha)
        };
      });
    } else {
      sections = [{
        id: "all",
        label: "Subjects",
        hint: names.length + (names.length === 1 ? " subject" : " subjects"),
        list: names.slice().sort(caseFirstAlpha)
      }];
    }
    var groupHtml = sections.map(function (sec) {
      var modId = sec.id;
      var list = sec.list;
      var rows = list.map(function (sub) {
        var st = stats[sub] || { total: 0, chapters: {} };
        var chMap = st.chapters || {};
        var chNames = Object.keys(chMap);
        var isCase = isCaseSubject(sub);
        var avail = st.total || 0;
        var icon = "book-open";
        try { if (window.getSubjectDesign) icon = window.getSubjectDesign(sub).icon || icon; } catch (_) {}
        var subQuota = quota[sub] || 0;
        // Chapter entries + defaults (proportional split of the subject quota).
        var chEntries = chNames.map(function (c) { return { name: c, avail: (chMap[c] && chMap[c].total) || 0 }; });
        var chAvailSum = chEntries.reduce(function (a, e) { return a + e.avail; }, 0);
        var unchap = Math.max(0, avail - chAvailSum);
        if (chNames.length && unchap > 0) chEntries.push({ name: "__all", label: "General", avail: unchap });
        var hasCh = chEntries.length > 0 && chNames.length > 0;
        var chDefaults = hasCh ? splitQuota(chEntries.map(function (e) { return e.avail; }), subQuota) : [];
        var stepper = function (inputHtml) {
          return '<div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">' +
          '<button type="button" onclick="window.mockStep(this,-1)" style="width:28px; height:28px; border-radius:6px; border:1px solid #E2E8F0; background:#F8FAFC; font-weight:700; color:#475569; cursor:pointer; font-size:14px; line-height:1;">−</button>' +
          inputHtml +
          '<button type="button" onclick="window.mockStep(this,1)" style="width:28px; height:28px; border-radius:6px; border:1px solid #E2E8F0; background:#F8FAFC; font-weight:700; color:#475569; cursor:pointer; font-size:14px; line-height:1;">+</button>' +
          '</div>';
        };
        var numStyle = 'width:64px; text-align:center; padding:7px 4px; font-size:14px; border-radius:6px; border:1px solid #E2E8F0; background:#fff; color:#0F172A; outline:none; font-weight:700;';
        var chRows = hasCh ? chEntries.map(function (e, idx) {
          return '<div style="display:flex; align-items:center; gap:10px; padding:8px 6px 8px 50px; margin:0 -6px; border-bottom:1px solid #F1F5F9;">' +
          '<div style="flex:1; min-width:0; font-size:13.5px; font-weight:600; color:#0F172A; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + esc(e.name) + '">' + esc(e.label || e.name) + '</div>' +
          stepper('<input type="number" class="mock-count-input mock-chapter-input" data-subject="' + esc(sub) + '" data-chapter="' + esc(e.name) + '" value="' + chDefaults[idx] + '" min="0" max="' + e.avail + '" ' +
          'style="' + numStyle + '" oninput="window.mockRecalc()" onfocus="this.style.borderColor=\'#007a7a\'" onblur="this.style.borderColor=\'#E2E8F0\'" />') +
          '</div>';
        }).join("") : "";
        return (
          '<div class="mock-sub-block" data-subject="' + esc(sub) + '">' +
          '<div style="display:flex; align-items:center; gap:10px; padding:10px 6px; margin:0 -6px; border-bottom:1px solid #F1F5F9; border-radius:4px;" onmouseover="this.style.background=\'#F8FAFC\'" onmouseout="this.style.background=\'transparent\'">' +
          (hasCh ? '<button type="button" onclick="window.mockToggleChapters(this)" title="Sub-categories" style="width:26px; height:26px; border-radius:6px; border:1px solid #E2E8F0; background:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; padding:0;"><i data-lucide="' + (expandChapters ? "chevron-down" : "chevron-right") + '" style="width:14px;height:14px;color:#64748B;"></i></button>' : '') +
          '<div style="flex-shrink:0; display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:#e6f2f2; border-radius:6px;">' +
          '<i data-lucide="' + icon + '" style="width:20px;height:20px;color:#007a7a;"></i></div>' +
          '<div style="flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:2px;">' +
          '<div style="font-size:15px; font-weight:700; color:#0F172A; line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(sub) +
          (isCase ? ' <span style="font-size:11px; font-weight:700; color:#007a7a; background:#e6f2f2; padding:2px 9px; border-radius:999px; white-space:nowrap;">CAS</span>' : '') +
          '</div>' +
          (hasCh ? '<div style="font-size:12px; color:#64748B;">' + chEntries.length + ' sub-categories · tap the arrow to tune each</div>' : '') +
          '</div>' +
          stepper('<input type="number" class="mock-count-input mock-subject-input" data-subject="' + esc(sub) + '" value="' + subQuota + '" min="0" max="' + avail + '" ' +
          'style="' + numStyle + '" oninput="' + (hasCh ? "window.mockSubjectChanged(this)" : "window.mockRecalc()") + '" onfocus="this.style.borderColor=\'#007a7a\'" onblur="this.style.borderColor=\'#E2E8F0\'" />') +
          '</div>' +
          (hasCh ? '<div class="mock-chapters" style="display:' + (expandChapters ? "block" : "none") + ';">' + chRows + '</div>' : '') +
          '</div>'
        );
      }).join("");
      var modQuota = list.reduce(function (a, s) { return a + (quota[s] || 0); }, 0);
      var labelHtml = esc(sec.label) +
        (sec.hint ? ' <span style="font-weight:400; letter-spacing:0; text-transform:none; color:#94A3B8;">· ' + esc(sec.hint) + '</span>' : '');
      return (
        '<div style="font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#64748B; margin:0 0 10px 0; display:flex; align-items:center; gap:8px;">' + labelHtml +
        ' <span style="font-size:11px; font-weight:700; color:#007a7a; background:#e6f2f2; padding:2px 9px; border-radius:999px; white-space:nowrap; letter-spacing:0; text-transform:none;"><span class="mock-mod-sum" data-module-sum="' + modId + '">' + modQuota + '</span> Qs</span></div>' +
        '<div class="ep-card-rows" style="background:#fff; border:1px solid #E2E8F0; border-radius:6px; padding:6px 16px; margin-bottom:18px;">' + rows + '</div>'
      );
    }).join("");

    area.innerHTML =
      '<div style="max-width:1000px; margin:0 auto; font-family:Inter,-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif; padding-bottom:40px;">' +
      '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">' +
      '<div style="display:flex; align-items:center; gap:8px; min-width:0;">' +
      '<a href="#" onclick="window.openExamPrepTab(); return false;" style="color:#64748B; font-size:12.5px; text-decoration:none; font-weight:600;" onmouseover="this.style.color=\'#007a7a\'" onmouseout="this.style.color=\'#64748B\'">Exam Prep</a>' +
      '<i data-lucide="chevron-right" style="width:14px;height:14px;color:#94A3B8;flex-shrink:0;"></i>' +
      '<h3 style="margin:0; font-size:14px; font-weight:700; color:#0F172A; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(bankName) + '</h3>' +
      '<i data-lucide="chevron-right" style="width:14px;height:14px;color:#94A3B8;flex-shrink:0;"></i>' +
      '<h3 style="margin:0; font-size:14px; font-weight:700; color:#0F172A;">Mock exam</h3>' +
      '</div>' +
      '<button onclick="window.showQBankSubjects && window.showQBankSubjects()" style="display:flex; align-items:center; gap:8px; padding:8px 16px; background:#F8FAFC; border:1px solid #E2E8F0; color:#0F172A; border-radius:999px; font-size:12.5px; font-weight:600; cursor:pointer; flex-shrink:0;" onmouseover="this.style.background=\'#E2E8F0\'" onmouseout="this.style.background=\'#F8FAFC\'">' +
      '<i data-lucide="arrow-left" style="width:14px;height:14px;"></i> Subjects</button>' +
      '</div>' +
      '<div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">' +
      '<div style="display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:#e6f2f2; border-radius:6px; flex-shrink:0;">' +
      '<i data-lucide="timer" style="width:20px;height:20px;color:#007a7a;"></i></div>' +
      '<h2 style="font-size:1.5rem; font-weight:700; margin:0; color:#0F172A;">Mock Exam</h2>' +
      (tunisia ? '<span style="font-size:11px; font-weight:700; color:#007a7a; background:#e6f2f2; padding:2px 9px; border-radius:999px; white-space:nowrap;">RESIDANAT PRESET</span>' : '') +
      '</div>' +
      '<p style="margin:0 0 24px 0; font-size:0.9rem; color:#64748B;">' + (tunisia
        ? 'Concours de Résidanat: <b>150 QCM</b> · <b>180 min</b> · ~80 cas cliniques + ~70 isolées · 2 days × 2.5–3h in the real exam'
        : 'Pick the exam time and how many questions to pull from each subject.') + '</p>' +

      '<div style="font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#64748B; margin:0 0 10px 0;">Exam settings</div>' +
      '<div class="ep-card-rows" style="background:#fff; border:1px solid #E2E8F0; border-radius:6px; padding:6px 16px; margin-bottom:18px;">' +
      '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0 24px;">' +
      '<div style="padding:12px 6px; margin:0 -6px; border-bottom:1px solid #F1F5F9;">' +
      '<div style="font-size:15px; font-weight:700; color:#0F172A; margin-bottom:2px;">Total time (minutes)</div>' +
      '<div style="font-size:12px; color:#64748B; margin-bottom:8px;" id="mock-pace-preview"></div>' +
      '<input id="mock-minutes" type="number" value="' + defaultMin + '" min="5" max="600" style="width:100%; box-sizing:border-box; padding:12px 16px; font-size:1rem; border-radius:6px; border:1px solid #E2E8F0; background:#fff; color:#111827; outline:none; font-weight:700;" oninput="window.mockRecalc()" onfocus="this.style.borderColor=\'#007a7a\'" onblur="this.style.borderColor=\'#E2E8F0\'" />' +
      '</div>' +
      '<div style="padding:12px 6px; margin:0 -6px; border-bottom:1px solid #F1F5F9;">' +
      '<div style="font-size:15px; font-weight:700; color:#0F172A; margin-bottom:2px;">Total questions</div>' +
      '<div style="font-size:12px; color:#64748B; margin-bottom:8px;" id="mock-case-split"></div>' +
      '<input id="mock-total-input" type="number" value="' + totalDefault + '" min="0" style="width:100%; box-sizing:border-box; padding:12px 16px; font-size:1rem; border-radius:6px; border:1px solid #E2E8F0; background:#fff; color:#111827; outline:none; font-weight:700;" oninput="window.mockSetTotal()" onfocus="this.style.borderColor=\'#007a7a\'" onblur="this.style.borderColor=\'#E2E8F0\'" />' +
      '</div>' +
      '</div>' +
      '<div style="display:flex; align-items:center; gap:10px; padding:12px 6px; margin:0 -6px; flex-wrap:wrap;">' +
      '<div style="flex-shrink:0; display:flex; align-items:center; justify-content:center; width:40px; height:40px; background:#e6f2f2; border-radius:6px;">' +
      '<i data-lucide="info" style="width:20px;height:20px;color:#007a7a;"></i></div>' +
      '<div style="flex:1; min-width:200px; font-size:12px; color:#64748B; line-height:1.5;">' + (tunisia
        ? 'Day 1 + Day 2 · ~20–24 cas cliniques (≈80 QCM) + ~70 isolées. '
        : '') + 'Editing the total spreads it across subjects &amp; sub-categories automatically.</div>' +
      (tunisia ? '<button style="background:#007a7a; color:#fff; border:none; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; flex-shrink:0;" onmouseover="this.style.background=\'#006666\'" onmouseout="this.style.background=\'#007a7a\'" onclick="window.mockApplyPreset(\'' + jsEsc(qbankId) + '\')">Reset preset</button>' : '') +
      '<button style="background:#F8FAFC; color:#0F172A; border:1px solid #E2E8F0; padding:9px 18px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; flex-shrink:0;" onmouseover="this.style.background=\'#E2E8F0\'" onmouseout="this.style.background=\'#F8FAFC\'" onclick="window.mockZeroAll()">Clear all</button>' +
      '</div>' +
      '</div>' +

      groupHtml +

      '<div style="position:sticky; bottom:16px; background:#fff; border:1px solid #E2E8F0; border-radius:6px; padding:12px 16px; display:flex; align-items:center; gap:14px; box-shadow:0 8px 24px rgba(15,23,42,0.10); flex-wrap:wrap;">' +
      '<div style="flex:1; min-width:200px;"><div id="mock-summary-line" style="font-weight:700; font-size:14px; color:#0F172A;"></div><div id="mock-warn-line" style="font-size:12px; color:#B45309;"></div></div>' +
      '<button onclick="window.mockStartExam(\'' + jsEsc(qbankId) + '\')" style="background:#007a7a; color:#fff; border:none; padding:12px 28px; border-radius:6px; font-weight:700; font-size:14px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; flex-shrink:0;" onmouseover="this.style.background=\'#006666\'" onmouseout="this.style.background=\'#007a7a\'">Start Mock Exam <i data-lucide="arrow-right" style="width:14px;height:14px;"></i></button>' +
      '</div>' +
      '<div id="mock-qbank-id" data-qbank="' + esc(qbankId) + '" style="display:none;"></div>' +
      '</div>';

    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    window.mockRecalc();
  }

  window.mockZeroAll = function () {
    document.querySelectorAll(".mock-count-input").forEach(function (el) { el.value = 0; });
    window.mockRecalc();
  };

  // Editable total: typing a number spreads it across the leaf inputs
  // (sub-category inputs where present, else subject inputs).
  window.mockSetTotal = function () {
    var tEl = document.getElementById("mock-total-input");
    if (!tEl) return;
    var target = Math.max(0, parseInt(tEl.value || "0", 10) || 0);
    var leaves = [];
    document.querySelectorAll(".mock-sub-block").forEach(function (block) {
      var chInputs = block.querySelectorAll(".mock-chapter-input");
      if (chInputs.length) chInputs.forEach(function (c) { leaves.push(c); });
      else {
        var s = block.querySelector("input.mock-count-input:not(.mock-chapter-input)");
        if (s) leaves.push(s);
      }
    });
    if (!leaves.length) return;
    if (target <= 0) {
      leaves.forEach(function (el) { el.value = 0; });
      window.mockRecalc();
      return;
    }
    var avails = leaves.map(function (el) { return Math.max(0, parseInt(el.max || "0", 10) || 0); });
    var assigned = splitQuota(avails, target);
    leaves.forEach(function (el, idx) { el.value = assigned[idx]; });
    window.mockRecalc();
  };

  window.mockApplyPreset = function () {
    var qbankId = (document.getElementById("mock-qbank-id") || {}).dataset
      ? document.getElementById("mock-qbank-id").dataset.qbank : null;
    var collected = collectStats();
    var q = defaultQuotaFor(collected.stats, collected.names, true);
    document.querySelectorAll(".mock-sub-block").forEach(function (block) {
      var s = block.querySelector("input.mock-count-input:not(.mock-chapter-input)");
      if (!s) return;
      s.value = q[s.getAttribute("data-subject")] || 0;
      distributeSubjectToChapters(block, parseInt(s.value || "0", 10) || 0);
    });
    var m = document.getElementById("mock-minutes");
    if (m) m.value = TUNISIA_DEFAULT_MIN;
    window.mockRecalc();
  };

  window.mockStep = function (btn, d) {
    var row = btn.closest("div");
    var input = row ? row.querySelector("input.mock-count-input") : null;
    if (!input) {
      var wrap = btn.parentElement;
      input = wrap ? wrap.querySelector("input") : null;
    }
    if (!input) return;
    var max = parseInt(input.max || "9999", 10);
    var v = (parseInt(input.value || "0", 10) || 0) + d;
    v = Math.max(0, Math.min(max, v));
    input.value = v;
    // Stepping a subject with sub-categories spreads the change across them.
    if (!input.classList.contains("mock-chapter-input")) {
      var block = input.closest ? input.closest(".mock-sub-block") : null;
      if (block && block.querySelector(".mock-chapter-input")) distributeSubjectToChapters(block, v);
    }
    window.mockRecalc();
  };

  // Push a subject total down into its chapter inputs (proportional split).
  function distributeSubjectToChapters(block, target) {
    var chInputs = block.querySelectorAll(".mock-chapter-input");
    if (!chInputs.length) return;
    var avails = [];
    chInputs.forEach(function (c) { avails.push(Math.max(0, parseInt(c.max || "0", 10) || 0)); });
    var assigned = splitQuota(avails, target);
    chInputs.forEach(function (c, idx) { c.value = assigned[idx]; });
  }

  window.mockToggleChapters = function (btn) {
    var block = btn.closest ? btn.closest(".mock-sub-block") : null;
    if (!block) return;
    var box = null;
    for (var i = 0; i < block.children.length; i++) {
      if (block.children[i].classList && block.children[i].classList.contains("mock-chapters")) { box = block.children[i]; break; }
    }
    if (!box) return;
    var open = box.style.display === "none";
    box.style.display = open ? "block" : "none";
    btn.innerHTML = '<i data-lucide="' + (open ? "chevron-down" : "chevron-right") + '" style="width:14px;height:14px;color:#64748B;"></i>';
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  // Subject input edited: spread it across its sub-categories.
  window.mockSubjectChanged = function (el) {
    var block = el.closest ? el.closest(".mock-sub-block") : null;
    var target = Math.max(0, parseInt(el.value || "0", 10) || 0);
    if (block) distributeSubjectToChapters(block, target);
    window.mockRecalc();
  };

  window.mockRecalc = function () {
    var total = 0, caseN = 0;
    var modSums = {};
    document.querySelectorAll(".mock-sub-block").forEach(function (block) {
      var subInput = block.querySelector("input.mock-count-input:not(.mock-chapter-input)");
      if (!subInput) return;
      var sub = subInput.getAttribute("data-subject") || "";
      var chInputs = block.querySelectorAll(".mock-chapter-input");
      var v;
      if (chInputs.length) {
        // Chapters are the source of truth; subject shows their sum.
        var s = 0;
        chInputs.forEach(function (c) {
          var cv = Math.max(0, parseInt(c.value || "0", 10) || 0);
          var mx = parseInt(c.max || "9999", 10);
          if (cv > mx) { cv = mx; c.value = cv; }
          s += cv;
        });
        v = s;
        if (String(subInput.value) !== String(v)) subInput.value = v;
      } else {
        v = Math.max(0, parseInt(subInput.value || "0", 10) || 0);
        var mx2 = parseInt(subInput.max || "9999", 10);
        if (v > mx2) { v = mx2; subInput.value = v; }
      }
      total += v;
      if (isCaseSubject(sub)) caseN += v;
      var mod = classifySubject(sub);
      modSums[mod] = (modSums[mod] || 0) + v;
    });
    Object.keys(modSums).forEach(function (mod) {
      document.querySelectorAll('[data-module-sum="' + mod + '"]').forEach(function (el) { el.textContent = modSums[mod]; });
    });
    // Flat (non-Tunisia) section pill shows the grand total.
    document.querySelectorAll('[data-module-sum="all"]').forEach(function (el) { el.textContent = total; });
    // Keep the editable total in sync with the per-subject sum.
    // (Programmatic set — does not fire oninput, so no loop with mockSetTotal.)
    var totalEl = document.getElementById("mock-total-input");
    if (totalEl && String(totalEl.value) !== String(total)) totalEl.value = total;
    var splitEl = document.getElementById("mock-case-split");
    if (splitEl) splitEl.textContent = caseN + " case-based · " + (total - caseN) + " isolated (auto-detected by “cas” in name)";
    var mins = parseInt((document.getElementById("mock-minutes") || {}).value || "0", 10) || 0;
    var paceEl = document.getElementById("mock-pace-preview");
    if (paceEl) {
      if (total > 0 && mins > 0) {
        var secPerQ = Math.floor((mins * 60) / total);
        paceEl.textContent = "≈ " + fmtClock(secPerQ) + " per question · " + mins + " min total";
      } else paceEl.textContent = "Set time + questions to see pace.";
    }
    var sum = document.getElementById("mock-summary-line");
    if (sum) sum.textContent = total > 0 ? ("Ready: " + total + " questions · " + mins + " minutes") : "Select at least 1 question to start.";
    var warn = document.getElementById("mock-warn-line");
    if (warn) {
      warn.textContent = "";
      if (total > 600) warn.textContent = "Large exam — consider splitting over 2 days like the real Résidanat.";
      else if (total > 0 && mins > 0 && mins * 60 / total < 45) warn.textContent = "Very tight pace (<0:45/Q). The real exam allows ~1:12/Q.";
    }
  };

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }
  function fmtLong(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var p = function (n) { return String(n).padStart(2, "0"); };
    return h > 0 ? h + ":" + p(m) + ":" + p(s) : p(m) + ":" + p(s);
  }

  // ---------- EXAM BUILD (stratified sampling) ----------
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Exam plan: per subject { total, chapters: null | {chapterName: n} }.
  // Subjects with sub-category inputs use exact per-chapter counts;
  // the rest fall back to round-robin stratification at sampling time.
  function readMockPlan() {
    var plan = {};
    var chapBySub = {};
    document.querySelectorAll(".mock-chapter-input").forEach(function (el) {
      var sub = el.getAttribute("data-subject");
      var ch = el.getAttribute("data-chapter");
      if (!sub || ch == null) return;
      var v = Math.max(0, parseInt(el.value || "0", 10) || 0);
      if (!chapBySub[sub]) chapBySub[sub] = {};
      chapBySub[sub][ch] = v;
    });
    document.querySelectorAll(".mock-sub-block").forEach(function (block) {
      var subInput = block.querySelector("input.mock-count-input:not(.mock-chapter-input)");
      if (!subInput) return;
      var sub = subInput.getAttribute("data-subject") || "";
      if (!sub) return;
      if (chapBySub[sub]) {
        var sum = 0, k;
        for (k in chapBySub[sub]) sum += chapBySub[sub][k];
        if (sum > 0) plan[sub] = { total: sum, chapters: chapBySub[sub] };
      } else {
        var v = Math.max(0, parseInt(subInput.value || "0", 10) || 0);
        if (v > 0) plan[sub] = { total: v, chapters: null };
      }
    });
    return plan;
  }

  function allBankQuestions(qbankId) {
    try {
      if (window.getQBankCachedQuestions) {
        var qs = window.getQBankCachedQuestions(qbankId || (run && run.qbankId) || window.currentQBankId || (window.db && window.db.selectedQBankId));
        if (qs && qs.length) return qs;
      }
    } catch (_) {}
    if (window.__mockFullBank && window.__mockFullBank.length) return window.__mockFullBank;
    if (window.currentQuestions && window.currentQuestions.length) return window.currentQuestions.slice();
    return [];
  }

  // Stash the full bank whenever a session loads so the builder never sees
  // a pre-filtered subset.
  var _origStartFiltered = null;
  function hookStash() {
    if (_origStartFiltered || !window.startQBankFiltered) return;
    _origStartFiltered = window.startQBankFiltered;
  }

  window.mockStartExam = async function (qbankId) {
    var plan = readMockPlan();
    var totalWanted = Object.keys(plan).reduce(function (a, k) { return a + plan[k].total; }, 0);
    if (!totalWanted) { alert("Select at least 1 question."); return; }
    var minsEl = document.getElementById("mock-minutes");
    var mins = Math.max(5, Math.min(600, parseInt((minsEl || {}).value || "0", 10) || 0));
    if (!mins) { alert("Set the exam duration in minutes."); return; }

    // Resolve the full question pool.
    var pool = allBankQuestions(qbankId);
    if (!pool.length) {
      // Try loading via API-backed session first.
      try {
        if (window.startQBankSession) {
          await window.startQBankSession(qbankId, bankNameOf(qbankId));
          pool = allBankQuestions(qbankId);
        }
      } catch (e) { console.warn(e); }
    }
    // Last resort: the subject page computed stats from `allQuestions`
    // inside the qbank closure — but window.currentQuestions after
    // startQBankSession(targetSubject=null) path holds the mix. Force it:
    if (!pool.length && window.startQBankFiltered) {
      try { await window.startQBankFiltered(null); } catch (_) {}
      try { pool = (window.currentQuestions || []).slice(); } catch (_) {}
      // Close the practice modal that startQBankFiltered opened.
      try { var m = document.getElementById("qbank-modal"); if (m) m.style.display = "none"; } catch (_) {}
      if (window.hideAllMainViews) window.hideAllMainViews();
      var v = document.getElementById("qbank-home-view");
      if (v) v.style.display = "flex";
    }
    if (!pool.length) { alert("Could not load questions for this bank."); return; }
    window.__mockFullBank = pool.slice();

    // Group pool by subject -> chapter.
    var bySubj = {};
    pool.forEach(function (q) {
      var sub = (q.data && q.data.subject) || "Uncategorized";
      if (!bySubj[sub]) bySubj[sub] = [];
      bySubj[sub].push(q);
    });

    var picked = [];
    var shortfalls = [];
    Object.keys(plan).forEach(function (sub) {
      var want = plan[sub].total;
      var chapWant = plan[sub].chapters; // null => round-robin
      var avail = bySubj[sub] || [];
      if (!avail.length) { shortfalls.push(sub + " (empty)"); return; }
      // Stratify across chapters: round-robin so every "Cas clinique N"
      // chapter contributes instead of one chapter dominating.
      var byChap = {};
      avail.forEach(function (q) {
        var ch = (q.data && q.data.chapter) || "__all";
        if (!byChap[ch]) byChap[ch] = [];
        byChap[ch].push(q);
      });
      Object.keys(byChap).forEach(function (ch) {
        // Preserve clinical-case order inside a chapter; shuffle isolated.
        var isCase = isCaseSubject(sub);
        if (!isCase) byChap[ch] = shuffle(byChap[ch]);
        else byChap[ch].sort(function (a, b) {
          return ((a.data && a.data.createdAt) || 0) - ((b.data && b.data.createdAt) || 0);
        });
      });
      var take = [];
      if (chapWant) {
        // Exact per-sub-category counts from the setup screen.
        Object.keys(chapWant).forEach(function (ch) {
          var need = chapWant[ch] || 0;
          var bucket = byChap[ch] || [];
          while (need > 0 && bucket.length) { take.push(bucket.shift()); need--; }
        });
      } else {
        var chapters = Object.keys(byChap);
        var ci = 0, guard = 0;
        // Round-robin across chapters.
        while (take.length < want && guard++ < want * (chapters.length + 2) + 50) {
          var ch = chapters[ci % chapters.length];
          var bucket = byChap[ch];
          if (bucket && bucket.length) take.push(bucket.shift());
          ci++;
          // stop if every bucket drained
          if (chapters.every(function (c) { return !byChap[c].length; })) break;
        }
      }
      if (take.length < want) shortfalls.push(sub + " (only " + take.length + "/" + want + ")");
      picked.push.apply(picked, take);
    });

    if (!picked.length) { alert("No questions could be sampled."); return; }

    // Order: keep case-blocks together — group by subject (case order
    // preserved), subjects ordered Medical → Surgical → Peds/Gyn → Basic,
    // case-subjects first inside each module (mirrors Day1/Day2 blocks).
    var modRank = { medical: 0, surgical: 1, peds_gyn: 2, basic: 3 };
    var bySubPick = {};
    picked.forEach(function (q) {
      var sub = (q.data && q.data.subject) || "Uncategorized";
      if (!bySubPick[sub]) bySubPick[sub] = [];
      bySubPick[sub].push(q);
    });
    var orderedSubs = Object.keys(bySubPick).sort(function (a, b) {
      var ma = modRank[classifySubject(a)], mb = modRank[classifySubject(b)];
      if (ma !== mb) return ma - mb;
      var ca = isCaseSubject(a) ? 0 : 1, cb = isCaseSubject(b) ? 0 : 1;
      return ca - cb || a.localeCompare(b);
    });
    var ordered = [];
    orderedSubs.forEach(function (s) { ordered.push.apply(ordered, bySubPick[s]); });

    startMockRun(qbankId, bankNameOf(qbankId), ordered, mins * 60, shortfalls);
  };

  // ---------- EXAM RUN ----------
  var run = null;

  // CuraQ Book slide-over inside the mock modal. Same tab header as the
  // practice-mode right column, so it feels like the same feature.
  function ensureDrawer() {
    var modal = document.getElementById("mock-exam-modal");
    if (!modal || document.getElementById("mock-book-drawer")) return;
    var body = modal.querySelector(".usmle-body");
    if (!body) return;
    var drawer = document.createElement("div");
    drawer.id = "mock-book-drawer";
    drawer.style.cssText = "display:none;flex-direction:column;width:380px;min-width:380px;max-width:92vw;flex-shrink:0;background:var(--surface-color, #fff);border:1px solid var(--border-color, rgba(0,0,0,0.1));border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);min-height:0;max-height:100%;";
    drawer.innerHTML =
      '<div style="display:flex;border-bottom:1px solid var(--border-color, rgba(0,0,0,0.1));background:var(--header-bg, rgba(0,0,0,0.02));align-items:stretch;">' +
      '<div style="padding:12px 24px;background:var(--surface-color, #fff);border-right:1px solid var(--border-color, rgba(0,0,0,0.1));border-bottom:2px solid var(--primary-color, #007a7a);font-weight:600;font-size:0.95rem;color:var(--text-primary);">CuraQ Book</div>' +
      '<div style="flex:1;"></div>' +
      '<button onclick="window.mockBookClose()" title="Close" style="background:transparent;border:none;padding:12px 16px;color:var(--text-muted);cursor:pointer;font-size:16px;">✕</button>' +
      "</div>" +
      '<div id="mock-book-content" class="qbank-rich" style="padding:24px;overflow-y:auto;flex:1;font-size:0.95rem;line-height:1.7;color:var(--text-color);"></div>';
    body.appendChild(drawer);
  }

  function ensureModal() {
    var modal = document.getElementById("mock-exam-modal");
    if (modal) { ensureDrawer(); return modal; }
    modal = document.createElement("div");
    modal.id = "mock-exam-modal";
    modal.className = "usmle-fullscreen";
    modal.style.display = "none";
    modal.innerHTML =
      '<div class="usmle-topbar">' +
      '<div class="usmle-topbar-left"><span class="usmle-item-info">Mock Exam: <span id="mock-active-name">—</span></span>' +
      '<span id="mock-timer-display" class="usmle-block-info" style="margin-left:10px;font-variant-numeric:tabular-nums;"></span></div>' +
      '<div class="usmle-topbar-center"><button class="usmle-nav-btn" onclick="window.mockPrev()">◀ Previous</button>' +
      '<span class="usmle-nav-counter" id="mock-nav-counter">1 / 1</span>' +
      '<button class="usmle-nav-btn" onclick="window.mockNext()">Next ▶</button></div>' +
      '<div class="usmle-topbar-right"><button class="usmle-tool-btn" onclick="window.mockFinishPrompt()"><i class="fa-solid fa-flag-checkered"></i> Finish</button>' +
      '<button class="usmle-tool-btn" onclick="window.mockExit()"><i class="fa-solid fa-times"></i> Exit</button></div></div>' +
      '<div class="usmle-body" style="display:flex;gap:16px;align-items:stretch;">' +
      '<div class="usmle-content" style="flex:1;min-width:0;"><div class="usmle-question-area" id="mock-question-area"></div></div>' +
      '<div id="mock-side" style="width:300px;min-width:300px;max-width:300px;flex-shrink:0;display:flex;flex-direction:column;gap:12px;min-height:0;max-height:100%;overflow-y:auto;padding-bottom:8px;"></div>' +
      '</div>' +
      '<div class="usmle-statusbar"><span id="mock-status-text">Answer to continue — timer is running</span>' +
      '<span id="mock-progress-text" style="font-variant-numeric:tabular-nums;"></span></div>' +
      '<style>' +
      "#mock-exam-modal .mock-nav-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;}" +
      "#mock-exam-modal .mock-nav-btn{aspect-ratio:1/1;border-radius:8px;border:1px solid #E2E8F0;background:#F1F5F9;color:#475569;font-weight:800;font-size:12.5px;cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;transition:all .15s;}" +
      "#mock-exam-modal .mock-nav-btn:hover{border-color:" + BRAND + ";}" +
      "#mock-exam-modal .mock-nav-btn.is-current{background:" + BRAND + ";border-color:" + BRAND + ";color:#fff;box-shadow:0 4px 12px rgba(0,122,122,0.35);}" +
      "#mock-exam-modal .mock-nav-btn.is-answered{background:#D7F0EE;border-color:#99D9D5;color:#0A4A4A;}" +
      "#mock-exam-modal .mock-nav-btn.is-current.is-answered{background:" + BRAND + ";color:#fff;}" +
      "#mock-exam-modal .mock-nav-btn.is-flagged::after{content:'';position:absolute;top:4px;right:4px;width:8px;height:8px;border-radius:50%;background:#F59E0B;}" +
      "#mock-exam-modal .mock-opt{display:flex;align-items:flex-start;gap:12px;width:100%;text-align:left;background:#fff;border:1.5px solid #E2E8F0;border-radius:12px;padding:14px 16px;cursor:pointer;font-size:14.5px;color:#0F172A;transition:all .15s;box-sizing:border-box;}" +
      "#mock-exam-modal .mock-opt:hover{border-color:" + BRAND + ";background:#F6FBFB;}" +
      "#mock-exam-modal .mock-opt.is-picked{border-color:" + BRAND + ";background:" + BRAND_LIGHT + ";box-shadow:0 0 0 1px " + BRAND + " inset;}" +
      "#mock-exam-modal .mock-opt-letter{flex-shrink:0;width:28px;height:28px;border-radius:8px;background:#F1F5F9;color:#475569;font-weight:800;font-size:12.5px;display:flex;align-items:center;justify-content:center;}" +
      "#mock-exam-modal .mock-opt.is-picked .mock-opt-letter{background:" + BRAND + ";color:#fff;}" +
      "#mock-exam-modal .mock-flag-btn{display:inline-flex;align-items:center;gap:8px;border:1px solid #E2E8F0;background:#fff;border-radius:999px;padding:7px 14px;font-size:12.5px;font-weight:700;color:#475569;cursor:pointer;}" +
      "#mock-exam-modal .mock-flag-btn.is-on{border-color:#F59E0B;background:#FFFBEB;color:#B45309;}" +
      "#mock-exam-modal .usmle-content{min-height:0;}" +
      "#mock-exam-modal .usmle-question-area{overscroll-behavior:contain;}" +
      "#mock-side{overscroll-behavior:contain;}" +
      "#mock-book-content{overscroll-behavior:contain;}" +
      "@media (max-width: 900px){#mock-exam-modal .usmle-body{flex-direction:column;}#mock-exam-modal .usmle-content{flex:1 1 auto;min-height:0;}#mock-side{width:100%!important;min-width:0!important;max-width:100%!important;max-height:38%!important;}#mock-book-drawer{width:100%!important;min-width:0!important;max-width:100%!important;max-height:42%!important;}}" +
      "@keyframes qbspin{100%{transform:rotate(360deg);}}" +
      "</style>";
    document.body.appendChild(modal);
    return modal;
  }

  function startMockRun(qbankId, bankName, questions, totalSeconds, shortfalls) {
    ensureModal();
    run = {
      qbankId: qbankId,
      bankName: bankName,
      questions: questions,
      totalSeconds: totalSeconds,
      endsAt: Date.now() + totalSeconds * 1000,
      startedAt: Date.now(),
      idx: 0,
      answers: {},   // idx -> array of selected option indices
      flagged: {},
      timerId: null,
      finished: false,
      shortfalls: shortfalls || [],
    };
    var modal = document.getElementById("mock-exam-modal");
    modal.style.display = "flex";
    try { window.mockBookClose(); } catch (_) {}
    run.bookIdx = null;
    document.body.style.overflow = "hidden";
    var nm = document.getElementById("mock-active-name");
    if (nm) nm.textContent = bankName + " · " + questions.length + " Qs";
    tick(true);
    run.timerId = setInterval(tick, 1000);
    renderQ();
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  function remainingSec() {
    if (!run) return 0;
    return Math.max(0, Math.round((run.endsAt - Date.now()) / 1000));
  }

  function answeredCount() {
    if (!run) return 0;
    return Object.keys(run.answers).filter(function (k) {
      var v = run.answers[k];
      return v && v.length;
    }).length;
  }

  function tick(force) {
    if (!run || run.finished) return;
    var left = remainingSec();
    var el = document.getElementById("mock-timer-display");
    if (el) {
      el.innerHTML = '<i class="fa-regular fa-clock"></i> ' + fmtLong(left) + " left";
      el.style.color = left < 300 ? "#FCA5A5" : "";
      el.style.fontWeight = "800";
    }
    renderSide();
    if (left <= 0 && !force) finish(true);
    else if (left <= 0 && force) { /* just painted */ }
  }

  function currentQ() { return run.questions[run.idx]; }
  function currentData() { var q = currentQ(); return (q && q.data) || {}; }
  function isMulti(q) {
    var d = (q && q.data) || {};
    if (Array.isArray(d.correctIndices)) return d.correctIndices.length > 1;
    return d.multi === true;
  }

  function rich(html) {
    try {
      if (window.renderRichText) return window.renderRichText(html);
      if (window.marked && window.DOMPurify) return window.DOMPurify.sanitize(window.marked.parse(String(html || "")));
    } catch (_) {}
    return esc(html);
  }

  function renderQ() {
    if (!run || run.finished) return;
    var area = document.getElementById("mock-question-area");
    var q = currentQ(), d = currentData();
    var total = run.questions.length;
    var multi = isMulti(q);
    var sel = run.answers[run.idx] || [];
    var flagged = !!run.flagged[run.idx];

    var counter = document.getElementById("mock-nav-counter");
    if (counter) counter.textContent = (run.idx + 1) + " / " + total;

    var opts = (d.options || []).map(function (opt, i) {
      var picked = sel.indexOf(i) !== -1;
      return (
        '<button class="mock-opt' + (picked ? " is-picked" : "") + '" onclick="window.mockPick(' + i + ')">' +
        '<span class="mock-opt-letter">' + String.fromCharCode(65 + i) + '</span>' +
        '<span style="flex:1;">' + rich(opt) + "</span>" +
        (picked ? '<i class="fa-solid fa-check" style="color:' + BRAND + ';margin-top:2px;"></i>' : "") +
        "</button>"
      );
    }).join("");

    area.innerHTML =
      '<div class="usmle-question-card" style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;">' +
      '<div style="padding:12px 20px;border-bottom:1px solid #F1F5F9;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<span style="font-size:13px;color:#475569;">Question ' + (run.idx + 1) + " of " + total + "</span>" +
      '<span style="font-size:10.5px;font-weight:800;letter-spacing:0.05em;color:' + BRAND + ';background:' + BRAND_LIGHT + ';padding:4px 10px;border-radius:6px;">' + (multi ? "MULTIPLE ANSWERS (QCM)" : "SINGLE BEST ANSWER") + "</span>" +
      (d.subject ? '<span style="font-size:11px;color:#64748B;background:#F8FAFC;border:1px solid #E2E8F0;padding:4px 10px;border-radius:999px;">' + esc(d.subject) + "</span>" : "") +
      '<span style="flex:1;"></span>' +
      '<button class="mock-flag-btn' + (flagged ? " is-on" : "") + '" onclick="window.mockFlag()">' +
      '<i class="fa-regular fa-flag"></i> ' + (flagged ? "Flagged" : "Flag for review") + "</button>" +
      "</div>" +
      '<div style="padding:22px 22px 8px;font-size:15px;line-height:1.7;color:#0F172A;font-weight:500;" class="qbank-rich">' + rich((q && q.text) || "(empty stem)") + "</div>" +
      '<div style="padding:12px 22px 22px;display:flex;flex-direction:column;gap:10px;">' + (opts || '<div style="color:#94A3B8;">No options.</div>') + "</div>" +
      '<div style="padding:14px 22px;border-top:1px solid #F1F5F9;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<button class="usmle-nav-btn" onclick="window.mockPrev()" ' + (run.idx === 0 ? 'disabled style="opacity:0.4;"' : "") + '>◀ Previous</button>' +
      '<span style="flex:1;"></span>' +
      '<span style="font-size:12.5px;color:' + (sel.length ? "#0A4A4A" : "#94A3B8") + ';font-weight:600;">' + (sel.length ? ("Selected: " + sel.map(function (i) { return String.fromCharCode(65 + i); }).join(", ")) : "Select an answer") + "</span>" +
      (run.idx < total - 1
        ? '<button onclick="window.mockNext()" style="background:' + BRAND + ';color:#fff;border:none;border-radius:10px;padding:11px 22px;font-weight:800;font-size:13.5px;cursor:pointer;">Next →</button>'
        : '<button onclick="window.mockFinishPrompt()" style="background:#0F172A;color:#fff;border:none;border-radius:10px;padding:11px 22px;font-weight:800;font-size:13.5px;cursor:pointer;">Review & Finish</button>') +
      "</div></div>";

    renderSide();
    var st = document.getElementById("mock-status-text");
    if (st) st.textContent = sel.length ? ("Q" + (run.idx + 1) + " answered (" + sel.map(function (i) { return String.fromCharCode(65 + i); }).join(", ") + ")") : ("Q" + (run.idx + 1) + " unanswered — timer is running");
    var pr = document.getElementById("mock-progress-text");
    if (pr) pr.textContent = answeredCount() + "/" + total + " answered";
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    if (window.qbankEnhanceImages) try { window.qbankEnhanceImages(area); } catch (_) {}
    // keep question top visible
    try {
      // #mock-question-area is the real scroller (.usmle-body is overflow:hidden).
      var scroller = document.getElementById("mock-question-area");
      if (scroller) scroller.scrollTop = 0;
    } catch (_) {}
  }

  function renderSide() {
    if (!run) return;
    var side = document.getElementById("mock-side");
    if (!side) return;
    var total = run.questions.length;
    var ans = answeredCount();
    var unans = total - ans;
    var flagN = Object.keys(run.flagged).filter(function (k) { return run.flagged[k]; }).length;
    var left = remainingSec();
    var perRemaining = unans > 0 ? Math.floor(left / unans) : 0;
    var expectedPerQ = total > 0 ? run.totalSeconds / total : 90;
    var onPace = unans === 0 || (left / Math.max(1, unans)) >= expectedPerQ * 0.9;

    var grid = run.questions.map(function (_, i) {
      var cls = "mock-nav-btn";
      if (i === run.idx) cls += " is-current";
      if (run.answers[i] && run.answers[i].length) cls += " is-answered";
      if (run.flagged[i]) cls += " is-flagged";
      return '<button class="' + cls + '" onclick="window.mockJump(' + i + ')" title="Q' + (i + 1) + '">' + (i + 1) + "</button>";
    }).join("");

    side.innerHTML =
      '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
      '<div style="font-weight:800;font-size:14px;color:#0F172A;">Navigator</div>' +
      '<div style="font-size:12px;color:#94A3B8;font-variant-numeric:tabular-nums;">' + ans + "/" + total + "</div></div>" +
      '<div class="mock-nav-grid">' + grid + "</div>" +
      '<div style="margin-top:14px;border-top:1px solid #F1F5F9;padding-top:12px;display:flex;flex-direction:column;gap:6px;font-size:12.5px;">' +
      '<div style="display:flex;align-items:center;gap:8px;"><span style="width:10px;height:10px;border-radius:3px;background:#D7F0EE;border:1px solid #99D9D5;"></span><span style="color:#475569;">Answered</span><span style="flex:1;"></span><b>' + ans + "</b></div>" +
      '<div style="display:flex;align-items:center;gap:8px;"><span style="width:10px;height:10px;border-radius:3px;background:#F1F5F9;border:1px solid #E2E8F0;"></span><span style="color:#475569;">Unanswered</span><span style="flex:1;"></span><b>' + unans + "</b></div>" +
      '<div style="display:flex;align-items:center;gap:8px;"><span style="width:10px;height:10px;border-radius:50%;background:#F59E0B;"></span><span style="color:#475569;">Flagged</span><span style="flex:1;"></span><b>' + flagN + "</b></div>" +
      '<div style="display:flex;align-items:center;gap:8px;"><span style="width:10px;height:10px;border-radius:3px;background:' + BRAND + ';"></span><span style="color:#475569;">Current</span><span style="flex:1;"></span><b>' + (run.idx + 1) + "</b></div>" +
      "</div></div>" +
      '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px;">' +
      '<div style="font-size:11px;font-weight:800;letter-spacing:0.08em;color:#64748B;">PACE</div>' +
      '<div style="font-size:1.7rem;font-weight:800;color:#0F172A;margin:4px 0;font-variant-numeric:tabular-nums;">' + fmtClock(perRemaining) + ' <span style="font-size:12px;font-weight:600;color:#64748B;">per remaining question</span></div>' +
      '<div style="font-size:12.5px;font-weight:700;color:' + (onPace ? "#0A7A3A" : "#B45309") + ';">' + (unans === 0 ? "All answered — review flagged, then finish." : onPace ? "On exam pace — keep going." : "Behind pace — pick up the speed.") + "</div>" +
      '<div style="font-size:12px;color:#64748B;margin-top:6px;font-variant-numeric:tabular-nums;">' + fmtLong(left) + " left · " + fmtClock(expectedPerQ) + "/Q planned</div>" +
      '<button onclick="window.mockFinishPrompt()" style="margin-top:12px;width:100%;background:#0F172A;color:#fff;border:none;border-radius:10px;padding:11px;font-weight:800;font-size:13px;cursor:pointer;">Finish Exam</button>' +
      "</div>";
  }

  window.mockPick = function (optIdx) {
    if (!run || run.finished) return;
    var q = currentQ();
    var multi = isMulti(q);
    var cur = (run.answers[run.idx] || []).slice();
    if (multi) {
      var at = cur.indexOf(optIdx);
      if (at === -1) cur.push(optIdx);
      else cur.splice(at, 1);
      cur.sort(function (a, b) { return a - b; });
    } else {
      cur = cur.length === 1 && cur[0] === optIdx ? [] : [optIdx];
    }
    if (!cur.length) delete run.answers[run.idx];
    else run.answers[run.idx] = cur;
    renderQ();
  };

  window.mockFlag = function () {
    if (!run || run.finished) return;
    run.flagged[run.idx] = !run.flagged[run.idx];
    if (!run.flagged[run.idx]) delete run.flagged[run.idx];
    renderQ();
  };

  // After Finish, top-bar + navigator must stay in REVIEW mode.
  // Routing them back into renderQ() is what bounced users to the exam page.
  function inReview() {
    return !!(run && run.finished && run.reviewRows);
  }
  window.mockJump = function (i) {
    if (!run || i < 0 || i >= run.questions.length) return;
    if (inReview()) { window.mockReview(i); return; }
    run.idx = i;
    renderQ();
  };
  window.mockNext = function () {
    if (!run) return;
    if (inReview()) {
      var ri = (run.reviewIdx == null ? -1 : run.reviewIdx) + 1;
      if (ri < run.reviewRows.length) window.mockReview(ri);
      return;
    }
    if (run.idx < run.questions.length - 1) { run.idx++; renderQ(); }
  };
  window.mockPrev = function () {
    if (!run) return;
    if (inReview()) {
      var ri = (run.reviewIdx == null ? run.reviewRows.length : run.reviewIdx) - 1;
      if (ri >= 0) window.mockReview(ri);
      else window.mockBackToResults();
      return;
    }
    if (run.idx > 0) { run.idx--; renderQ(); }
  };

  window.mockExit = function () {
    if (run && !run.finished && !confirm("Exit the mock exam? Progress in this attempt will be lost.")) return;
    closeMock();
  };

  function closeMock() {
    if (run && run.timerId) { try { clearInterval(run.timerId); } catch (_) {} }
    var modal = document.getElementById("mock-exam-modal");
    if (modal) modal.style.display = "none";
    document.body.style.overflow = "";
  }

  window.mockFinishPrompt = function () {
    if (!run) return;
    if (run.finished) {
      // Already finished — Finish button becomes "back to results" in review.
      if (run.reviewIdx != null) window.mockBackToResults();
      return;
    }
    var un = run.questions.length - answeredCount();
    if (un > 0 && !confirm(un + " question" + (un > 1 ? "s" : "") + " unanswered. Finish anyway?")) return;
    finish(false);
  };

  function correctOf(q) {
    var d = (q && q.data) || {};
    if (Array.isArray(d.correctIndices)) return d.correctIndices.slice().sort(function (a, b) { return a - b; });
    if (d.correctOptionIndex !== undefined) return [d.correctOptionIndex];
    return null; // unknown until answer slice loads
  }

  async function finish(timedOut) {
    if (!run || run.finished) return;
    run.finished = true;
    try { clearInterval(run.timerId); } catch (_) {}
    var area = document.getElementById("mock-question-area");
    if (area) area.innerHTML = '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:40px;text-align:center;color:#64748B;">Grading… loading answer keys…</div>';

    // Answer-split: stems may not carry keys yet — fetch missing slices.
    try {
      var missing = run.questions.filter(function (q) {
        return q && q.id && !(q.data && (q.data.correctIndices !== undefined || q.data.correctOptionIndex !== undefined));
      }).map(function (q) { return q.id; });
      if (missing.length && typeof window.ensureQBankAnswers === "function") {
        await window.ensureQBankAnswers(run.qbankId, missing);
        if (typeof window.mergeQBankAnswers === "function") window.mergeQBankAnswers(run.questions, run.qbankId);
      }
    } catch (e) { console.warn("[mock] answer fetch failed", e); }

    var total = run.questions.length;
    var score = 0, partial = 0, unans = 0;
    var perMod = {}; // mod -> {total, correct}
    var rows = run.questions.map(function (q, i) {
      var d = (q && q.data) || {};
      var corr = correctOf(q) || [];
      var sel = ((run.answers[i] || []).slice()).sort(function (a, b) { return a - b; });
      var mod = classifySubject(d.subject || "");
      if (!perMod[mod]) perMod[mod] = { total: 0, correct: 0 };
      perMod[mod].total++;
      var state = "unanswered", ok = false, isPartial = false;
      if (!sel.length) { unans++; }
      else if (corr.length && sel.length === corr.length && sel.every(function (v, k) { return v === corr[k]; })) {
        ok = true; score++; perMod[mod].correct++;
        state = "correct";
      } else if (corr.length > 1 && sel.length && sel.every(function (v) { return corr.indexOf(v) !== -1; })) {
        isPartial = true; partial++;
        state = "partial";
      } else {
        state = corr.length ? "incorrect" : "ungraded";
        if (!corr.length) { /* no key — count as ungraded, not wrong */ }
      }
      return { i: i, q: q, sel: sel, corr: corr, state: state, mod: mod };
    });

    var pct = total ? Math.round((score / total) * 100) : 0;
    var used = Math.min(run.totalSeconds, Math.round((Date.now() - run.startedAt) / 1000));
    var modMeta = {};
    MODULES.forEach(function (m) { modMeta[m.id] = m.label; });

    var chips = rows.map(function (r) {
      var bg = "#F1F5F9", bd = "#E2E8F0", fg = "#64748B";
      if (r.state === "correct") { bg = "#D1FAE5"; bd = "#6EE7B7"; fg = "#065F46"; }
      else if (r.state === "incorrect") { bg = "#FEE2E2"; bd = "#FCA5A5"; fg = "#991B1B"; }
      else if (r.state === "partial") { bg = "#FEF3C7"; bd = "#FCD34D"; fg = "#92400E"; }
      return '<button onclick="window.mockReview(' + r.i + ')" style="aspect-ratio:1/1;border-radius:8px;border:1px solid ' + bd + ";background:" + bg + ";color:" + fg + ';font-weight:800;font-size:12.5px;cursor:pointer;" title="Q' + (r.i + 1) + " — " + r.state + '">' + (r.i + 1) + "</button>";
    }).join("");

    var modRows = Object.keys(perMod).map(function (mod) {
      var m = perMod[mod];
      var p = m.total ? Math.round((m.correct / m.total) * 100) : 0;
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #F1F5F9;font-size:13px;">' +
        '<span style="flex:1;color:#0F172A;font-weight:600;">' + esc(modMeta[mod] || mod) + '</span>' +
        '<span style="color:#64748B;">' + m.correct + "/" + m.total + "</span>" +
        '<b style="color:' + (p >= 70 ? "#0A7A3A" : p >= 50 ? "#B45309" : "#B91C1C") + ';">' + p + "%</b></div>";
    }).join("");

    run.reviewRows = rows;

    if (area) {
      area.innerHTML =
        '<div class="usmle-question-card" style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:28px;max-width:860px;margin:0 auto;">' +
        '<div style="font-size:12px;font-weight:800;letter-spacing:0.08em;color:#64748B;">' + (timedOut ? "TIME IS UP — " : "") + "MOCK EXAM RESULT</div>" +
        '<div style="font-size:2.6rem;font-weight:800;color:#0F172A;margin:6px 0;">' + pct + '%</div>' +
        '<div style="color:#475569;font-size:14px;margin-bottom:16px;">' + score + " of " + total + " correct" +
        (partial ? " · " + partial + " partially correct (QCM subset)" : "") +
        (unans ? " · " + unans + " unanswered" : "") +
        " · " + fmtLong(used) + " used of " + fmtLong(run.totalSeconds) + "</div>" +
        (run.shortfalls && run.shortfalls.length ? '<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:10px 14px;font-size:12.5px;color:#92400E;margin-bottom:14px;">Shortfalls: ' + esc(run.shortfalls.join("; ")) + "</div>" : "") +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:18px;">' +
        statCard(score, "Correct", "#0A7A3A", "#ECFDF5") +
        statCard(total - score - unans, "Incorrect", "#B91C1C", "#FEF2F2") +
        statCard(unans, "Unanswered", "#64748B", "#F8FAFC") +
        statCard(fmtLong(used), "Time used", "#0F172A", "#F8FAFC") +
        "</div>" +
        (modRows ? '<div style="margin-bottom:18px;"><div style="font-weight:800;font-size:13px;color:#0F172A;margin-bottom:6px;">Per-module breakdown</div>' + modRows + "</div>" : "") +
        '<div style="font-weight:800;font-size:13px;color:#0F172A;margin-bottom:8px;">Question review — click a number for the full explanation</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(40px,1fr));gap:8px;margin-bottom:20px;">' + chips + "</div>" +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
        '<button onclick="window.openQBankMockSetup(\'' + jsEsc(run.qbankId) + '\');window.mockCloseOnly();" style="flex:1;min-width:160px;background:' + BRAND + ';color:#fff;border:none;border-radius:10px;padding:12px;font-weight:800;cursor:pointer;">New Mock Exam</button>' +
        '<button onclick="window.mockExitForce()" style="flex:1;min-width:160px;background:#F1F5F9;color:#0F172A;border:1px solid #E2E8F0;border-radius:10px;padding:12px;font-weight:800;cursor:pointer;">Back to QBank</button>' +
        "</div></div>";
    }
    var side = document.getElementById("mock-side");
    if (side) side.innerHTML =
      '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px;font-size:13px;color:#475569;">' +
      "<b>Review mode.</b><br/>Click any question number to revisit your answer with its explanation." +
      "</div>";
    var st = document.getElementById("mock-status-text");
    var statusTxt = timedOut ? "Time is up — exam auto-submitted." : "Exam finished in " + fmtLong(used) + ".";
    if (st) st.textContent = statusTxt;
    var counter = document.getElementById("mock-nav-counter");
    if (counter) counter.textContent = total + " / " + total;
    // Cache the results view so Back-to-Results restores instantly
    // (no re-grade, no timer touch, no exam-page flash).
    try {
      var areaEl = document.getElementById("mock-question-area");
      run.resultsHtml = areaEl ? areaEl.innerHTML : "";
      run.resultsSideHtml = side ? side.innerHTML : "";
      run.resultsStatus = statusTxt;
      run.reviewIdx = null;
      window.mockBookClose();
    } catch (_) {}
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  function statCard(v, label, fg, bg) {
    return '<div style="background:' + bg + ";border-radius:10px;padding:12px;text-align:center;'>" +
      '<div style="font-size:1.3rem;font-weight:800;color:' + fg + ';">' + v + "</div>" +
      '<div style="font-size:11px;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:0.05em;">' + label + "</div></div>";
  }

  function renderReviewSide() {
    if (!run || !run.reviewRows) return;
    var side = document.getElementById("mock-side");
    if (!side) return;
    var chips = run.reviewRows.map(function (r) {
      var bg = "#F1F5F9", bd = "#E2E8F0", fg = "#64748B";
      if (r.state === "correct") { bg = "#D1FAE5"; bd = "#6EE7B7"; fg = "#065F46"; }
      else if (r.state === "incorrect") { bg = "#FEE2E2"; bd = "#FCA5A5"; fg = "#991B1B"; }
      else if (r.state === "partial") { bg = "#FEF3C7"; bd = "#FCD34D"; fg = "#92400E"; }
      var cur = (run.reviewIdx === r.i) ? ";box-shadow:0 0 0 2px #007a7a" : "";
      return '<button onclick="window.mockReview(' + r.i + ')" style="aspect-ratio:1/1;border-radius:8px;border:1px solid ' + bd + ";background:" + bg + ";color:" + fg + ';font-weight:800;font-size:12.5px;cursor:pointer' + cur + ';" title="Q' + (r.i + 1) + " — " + r.state + '">' + (r.i + 1) + "</button>";
    }).join("");
    side.innerHTML =
      '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
      '<div style="font-weight:800;font-size:14px;color:#0F172A;">Review</div>' +
      '<div style="font-size:12px;color:#94A3B8;">' + ((run.reviewIdx == null ? 0 : run.reviewIdx + 1)) + "/" + run.reviewRows.length + "</div></div>" +
      '<div class="mock-nav-grid">' + chips + "</div>" +
      '<button onclick="window.mockBackToResults()" style="margin-top:12px;width:100%;background:#F1F5F9;color:#0F172A;border:1px solid #E2E8F0;border-radius:10px;padding:11px;font-weight:800;font-size:13px;cursor:pointer;">← Back to Results</button>' +
      "</div>";
  }

  window.mockReview = function (i) {
    if (!run || !run.reviewRows) return;
    var r = run.reviewRows[i];
    if (!r) return;
    run.reviewIdx = r.i;
    var area = document.getElementById("mock-question-area");
    if (!area) return;
    var counter = document.getElementById("mock-nav-counter");
    if (counter) counter.textContent = (r.i + 1) + " / " + run.reviewRows.length;
    var d = (r.q && r.q.data) || {};
    var letters = function (arr) { return (arr || []).map(function (x) { return String.fromCharCode(65 + x); }).join(", ") || "—"; };
    var verdict = r.state === "correct"
      ? '<span style="color:#0A7A3A;font-weight:800;">✅ Correct</span>'
      : r.state === "partial" ? '<span style="color:#B45309;font-weight:800;">🟡 Partially correct (QCM subset)</span>'
      : r.state === "incorrect" ? '<span style="color:#B91C1C;font-weight:800;">❌ Incorrect</span>'
      : r.state === "unanswered" ? '<span style="color:#64748B;font-weight:800;">⚪ Unanswered</span>'
      : '<span style="color:#64748B;font-weight:800;">No answer key</span>';
    var optsHtml = (d.options || []).map(function (opt, oi) {
      var isCorr = r.corr.indexOf(oi) !== -1;
      var isSel = r.sel.indexOf(oi) !== -1;
      var bg = "#fff", bd = "#E2E8F0", badge = "";
      if (isCorr && isSel) {
        // Your pick AND correct -> yellow so your answer stands out.
        bg = "#FEF3C7"; bd = "#F59E0B";
        badge = '<span style="font-size:11px;font-weight:800;color:#B45309;background:#fff;border:1px solid #F59E0B;border-radius:6px;padding:2px 8px;white-space:nowrap;">YOUR PICK ✓</span>' +
          '<span style="font-size:11px;font-weight:800;color:#0A7A3A;white-space:nowrap;">CORRECT</span>';
      } else if (isCorr) {
        bg = "#ECFDF5"; bd = "#10B981";
        badge = '<span style="font-size:11px;font-weight:800;color:#0A7A3A;white-space:nowrap;">CORRECT</span>' +
          (r.state === "partial" ? '<span style="font-size:11px;font-weight:800;color:#B45309;white-space:nowrap;">MISSED</span>' : "");
      } else if (isSel) {
        bg = "#FEF2F2"; bd = "#EF4444";
        badge = '<span style="font-size:11px;font-weight:800;color:#B91C1C;white-space:nowrap;">YOUR PICK</span>';
      }
      return '<div style="display:flex;gap:12px;align-items:flex-start;background:' + bg + ";border:1.5px solid " + bd + ';border-radius:12px;padding:12px 14px;font-size:14px;">' +
        '<span style="font-weight:800;color:#0F172A;">' + String.fromCharCode(65 + oi) + ".</span>" +
        '<span style="flex:1;" class="qbank-rich">' + rich(opt) + "</span>" +
        (badge ? '<span style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex-shrink:0;">' + badge + "</span>" : "") +
        "</div>";
    }).join("");
    var expl = "";
    try {
      var blocks = window.renderExplanationBlocks ? window.renderExplanationBlocks(d.explanationBlocks) : "";
      var txt = d.explanation
        ? (window.marked && window.DOMPurify ? window.DOMPurify.sanitize(window.marked.parse(d.explanation)) : esc(d.explanation))
        : "No explanation provided.";
      var combined = blocks + txt;
      expl = window.formatExplanationSections ? window.formatExplanationSections(combined, d.options || [], d.correctIndices || []) : combined;
    } catch (_) { expl = "No explanation provided."; }
    area.innerHTML =
      '<div class="usmle-question-card" style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;max-width:860px;margin:0 auto;">' +
      '<div style="padding:12px 20px;border-bottom:1px solid #F1F5F9;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
      '<button onclick="window.mockBackToResults()" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:999px;padding:7px 14px;font-size:12.5px;font-weight:700;cursor:pointer;">← Results</button>' +
      "<b>Question " + (r.i + 1) + "</b><span style='flex:1;'></span>" + verdict + "</div>" +
      '<div style="padding:14px 22px 0;">' +
      '<button onclick="window.mockBookOpen(' + r.i + ')" style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#007a7a;color:#fff;border:none;border-radius:10px;padding:13px 16px;font-size:14px;font-weight:800;cursor:pointer;box-shadow:0 4px 14px rgba(0,122,122,0.35);" onmouseover="this.style.background=\'#006666\'" onmouseout="this.style.background=\'#007a7a\'"><i class="fa-solid fa-book-open"></i> Study this part in CuraQ Book</button>' +
      "</div>" +
      '<div style="padding:20px 22px 6px;font-size:15px;line-height:1.7;" class="qbank-rich">' + rich((r.q && r.q.text) || "") + "</div>" +
      '<div style="padding:10px 22px;display:flex;flex-direction:column;gap:8px;">' + optsHtml + "</div>" +
      '<div style="margin:6px 22px 22px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:14px 16px;font-size:13.5px;line-height:1.7;" class="qbank-rich"><b>Your answer:</b> ' + letters(r.sel) + " &nbsp;·&nbsp; <b>Correct:</b> " + letters(r.corr) + '<div style="margin-top:10px;">' + expl + "</div></div>" +
      '<div style="padding:12px 22px;border-top:1px solid #F1F5F9;display:flex;gap:10px;">' +
      (r.i > 0 ? '<button class="usmle-nav-btn" onclick="window.mockReview(' + (r.i - 1) + ')">◀ Prev</button>' : '<button class="usmle-nav-btn" onclick="window.mockBackToResults()">← Results</button>') +
      '<span style="flex:1;"></span>' +
      (r.i < run.reviewRows.length - 1 ? '<button class="usmle-nav-btn" onclick="window.mockReview(' + (r.i + 1) + ')">Next ▶</button>' : '<button class="usmle-nav-btn" onclick="window.mockBackToResults()">Results →</button>') +
      "</div></div>";
    renderReviewSide();
    var st = document.getElementById("mock-status-text");
    if (st) st.textContent = "Reviewing Q" + (r.i + 1) + " of " + run.reviewRows.length + ".";
    var pr = document.getElementById("mock-progress-text");
    if (pr) pr.textContent = "Review mode";
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    if (window.qbankEnhanceImages) try { window.qbankEnhanceImages(area); } catch (_) {}
    try {
      // #mock-question-area is the real scroller (.usmle-body is overflow:hidden).
      var scroller = document.getElementById("mock-question-area");
      if (scroller) scroller.scrollTop = 0;
    } catch (_) {}
  };

  window.mockBookClose = function () {
    var drawer = document.getElementById("mock-book-drawer");
    if (drawer) drawer.style.display = "none";
  };

  // Opens the CuraQ Book drawer for a review question. The drawer itself
  // opens SYNCHRONOUSLY (instant visible feedback) — content loads after.
  window.mockBookOpen = function (i) {
    if (!run || !run.reviewRows) return;
    ensureDrawer();
    var r = run.reviewRows[i];
    if (!r || !r.q) return;
    run.bookIdx = r.i;
    var drawer = document.getElementById("mock-book-drawer");
    var box = document.getElementById("mock-book-content");
    if (!drawer || !box) return;
    drawer.style.display = "flex";
    box.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;gap:16px;color:var(--text-secondary);">' +
      '<div style="width:36px;height:36px;border:3px solid rgba(128,128,128,0.2);border-top-color:var(--accent-cyan, #007a7a);border-radius:50%;animation:qbspin 1s linear infinite;"></div>' +
      "<span>Extracting relevant textbook excerpt…</span></div>";
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch (_) {}
    window.mockLoadBook(r.i);
  };

  // CuraQ Book excerpt inside mock review. Mirrors generateStudyConcept
  // (memory -> IDB forever-cache -> server -> AI generate -> save) but
  // renders into the mock drawer instead of #qbank-right-col.
  // Legacy alias (older review cards called this directly).
  window.mockLoadBook = async function (i) {
    if (!run || !run.reviewRows) { console.warn("[mock-book] no active run"); return; }
    var r = run.reviewRows[i];
    if (!r || !r.q) { console.warn("[mock-book] question not found:", i); return; }
    ensureDrawer();
    var box = document.getElementById("mock-book-content");
    if (!box) { console.warn("[mock-book] drawer content missing"); return; }
    var q = r.q;
    var qid = q.id;
    var bankId = run.qbankId;
    var conceptLang = (window.qbankAiLang && window.qbankAiLang()) || "auto";
    var usable = window.qbankConceptUsable || function () { return true; };
    function paint(md) {
      var el = document.getElementById("mock-book-content");
      if (!el) return;
      // Stale guard: user navigated to another question mid-load.
      if (run.bookIdx !== undefined && run.bookIdx !== r.i) return;
      try {
        el.innerHTML = (window.marked && window.DOMPurify)
          ? window.DOMPurify.sanitize(window.marked.parse(md))
          : esc(md);
      } catch (_) { el.textContent = String(md || ""); }
      if (window.lucide && window.lucide.createIcons) try { window.lucide.createIcons(); } catch (_) {}
      if (window.qbankEnhanceImages) try { window.qbankEnhanceImages(el); } catch (_) {}
    }
    // 1) In-memory (shared refs with the bank cache, so practice-mode
    // concepts show up here automatically).
    if (q.studyConcept && usable(q.studyConceptLang, conceptLang)) { paint(q.studyConcept); return; }
    box.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;gap:16px;color:var(--text-secondary);"><div style="width:36px;height:36px;border:3px solid rgba(128,128,128,0.2);border-top-color:var(--accent-cyan, #007a7a);border-radius:50%;animation:qbspin 1s linear infinite;"></div><span>Extracting relevant textbook excerpt…</span></div>';
    // 2) IDB forever-cache.
    try {
      if (window.idbKvGet) {
        var hit = await window.idbKvGet("study_concept:v1:" + bankId + ":" + qid + ":" + conceptLang);
        if (hit && hit.html && usable(hit.lang, conceptLang)) {
          q.studyConcept = hit.html; q.studyConceptLang = hit.lang || null;
          paint(hit.html); return;
        }
      }
    } catch (_) {}
    // 3) Server-saved concept.
    var token = null;
    try { token = window.firebase && firebase.auth().currentUser ? await firebase.auth().currentUser.getIdToken() : null; } catch (_) {}
    if (!token) { box.textContent = "Sign in to load the CuraQ Book excerpt."; return; }
    try {
      var getRes = await fetch("/api/qbank?action=get_study_concept&qbankId=" + encodeURIComponent(bankId) + "&questionId=" + encodeURIComponent(qid) + "&lang=" + encodeURIComponent(conceptLang), {
        headers: { Authorization: "Bearer " + token }
      });
      if (getRes.ok) {
        var getData = await getRes.json();
        if (getData.studyConcept && usable(getData.studyConceptLang, conceptLang)) {
          q.studyConcept = getData.studyConcept; q.studyConceptLang = getData.studyConceptLang || null;
          try { if (window.idbKvSet) window.idbKvSet("study_concept:v1:" + bankId + ":" + qid + ":" + conceptLang, { html: q.studyConcept, lang: q.studyConceptLang }); } catch (_) {}
          paint(q.studyConcept); return;
        }
      }
    } catch (_) {}
    // 4) Generate via AI, then save for everyone.
    try {
      var d = (q.data) || {};
      var optionsText = Array.isArray(d.options) ? d.options.map(function (opt, k) { return String.fromCharCode(65 + k) + ". " + opt; }).join("\n") : "";
      var correctAns = "Unknown";
      var ci = Array.isArray(d.correctIndices) ? d.correctIndices : (d.correctOptionIndex !== undefined ? [d.correctOptionIndex] : []);
      if (ci.length && Array.isArray(d.options)) correctAns = ci.map(function (k) { return String.fromCharCode(65 + k) + ". " + d.options[k]; }).join(", ");
      var res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          task: "qbank_study_concept",
          lang: conceptLang,
          vars: { question: (q.text || "") + "\n\n" + optionsText, answer: correctAns, explanation: d.explanation || "No explanation provided." }
        })
      });
      var resData = await res.json();
      if (!res.ok) throw new Error(resData.error || resData.message || "AI failed.");
      if (!resData.content) throw new Error("AI returned empty response.");
      q.studyConcept = resData.content; q.studyConceptLang = conceptLang;
      try { if (window.idbKvSet) window.idbKvSet("study_concept:v1:" + bankId + ":" + qid + ":" + conceptLang, { html: q.studyConcept, lang: conceptLang }); } catch (_) {}
      paint(q.studyConcept);
      fetch("/api/qbank", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          action: "save_study_concept", qbankId: bankId, questionId: qid,
          studyConcept: q.studyConcept, lang: conceptLang,
          code: (d.code) || "", subject: (d.subject) || "", chapter: (d.chapter) || ""
        })
      }).catch(function () {});
    } catch (err) {
      console.warn("[mock-book] load failed:", err);
      var el = document.getElementById("mock-book-content");
      if (run.bookIdx !== undefined && run.bookIdx !== r.i) return;
      if (el) el.innerHTML = '<div style="background:rgba(244,63,94,0.08);color:#B91C1C;padding:16px;border-radius:8px;border:1px solid rgba(244,63,94,0.2);text-align:center;">Could not load the excerpt: ' + esc((err && err.message) || err) + '<br/><button onclick="window.mockBookOpen(' + r.i + ')" style="margin-top:10px;background:var(--surface-color, #fff);border:1px solid var(--border-color, #E2E8F0);border-radius:999px;padding:7px 16px;font-size:12px;font-weight:700;cursor:pointer;">Retry</button></div>';
    }
  };

  window.mockBackToResults = function () {
    // Restore the cached results view — never re-enter the exam renderer.
    if (!run || !run.reviewRows) return;
    run.reviewIdx = null;
    try { window.mockBookClose(); } catch (_) {}
    var area = document.getElementById("mock-question-area");
    var side = document.getElementById("mock-side");
    if (area && run.resultsHtml) area.innerHTML = run.resultsHtml;
    if (side && run.resultsSideHtml) side.innerHTML = run.resultsSideHtml;
    var counter = document.getElementById("mock-nav-counter");
    if (counter) counter.textContent = run.reviewRows.length + " / " + run.reviewRows.length;
    var st = document.getElementById("mock-status-text");
    if (st && run.resultsStatus) st.textContent = run.resultsStatus;
    var pr = document.getElementById("mock-progress-text");
    if (pr) pr.textContent = "Review mode";
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  window.mockCloseOnly = function () { closeMock(); run = null; };
  window.mockExitForce = function () {
    closeMock(); run = null;
    if (window.showQBankSubjects) window.showQBankSubjects();
  };

  // ---------- entry-point wiring ----------
  // 1) "Mock Exam" button on the subject-selection page (injected without
  //    touching qbank.js — wraps showQBankSubjects).
  function injectSetupButton() {
    try {
      var area = document.getElementById("qbank-home-content");
      if (!area || document.getElementById("mock-launch-btn")) return;
      var h2 = null;
      var heads = area.querySelectorAll("h2");
      for (var i = 0; i < heads.length; i++) {
        if (/sub-category|subjects/i.test(heads[i].textContent || "")) { h2 = heads[i]; break; }
      }
      if (!h2) return;
      var bar = h2.parentElement;
      if (!bar) return;
      var btn = document.createElement("button");
      btn.id = "mock-launch-btn";
      btn.innerHTML = '<i class="fa-solid fa-stopwatch" style="font-size:13px;"></i> Mock Exam';
      btn.style.cssText = "margin-left:auto;background:" + BRAND + ";color:#fff;border:none;border-radius:999px;padding:9px 18px;font-weight:800;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;white-space:nowrap;";
      btn.onclick = function () {
        var id = null;
        try { if (window.getCurrentQBankId) id = window.getCurrentQBankId(); } catch (_) {}
        if (!id) id = window.currentQBankId || (window.db && window.db.selectedQBankId);
        window.openQBankMockSetup(id);
      };
      bar.appendChild(btn);
      // Stash full bank for the sampler (subject page already computed it).
      try {
        if (window.currentQuestions && window.currentQuestions.length) {
          window.__mockFullBank = window.currentQuestions.slice();
        }
      } catch (_) {}
    } catch (_) {}
  }

  // Wrap showQBankSubjects so the button appears every time the page renders.
  var _origShow = null, _wrapTimer = null;
  function armWrapper() {
    if (_origShow || !window.showQBankSubjects) return false;
    _origShow = window.showQBankSubjects;
    window.showQBankSubjects = async function () {
      var r = await _origShow.apply(this, arguments);
      // Stash full-bank snapshot if this render had it.
      try {
        // showQBankSubjects sets module allQuestions from cache — mirror it
        // via currentQuestions when it holds the whole bank (All Subjects mix
        // not yet filtered). We capture opportunistically in startQBankFiltered
        // wrapper below instead; here just inject the button.
      } catch (_) {}
      setTimeout(injectSetupButton, 0);
      return r;
    };
    return true;
  }

  // Capture the full bank inside startQBankFiltered's closure by observing
  // the "All Subjects" mix call (subject==null => currentQuestions == all).
  var _origFiltered = null;
  function armFilteredHook() {
    if (_origFiltered || !window.startQBankFiltered) return false;
    _origFiltered = window.startQBankFiltered;
    window.startQBankFiltered = async function (subject, chapter, reviewOnly) {
      var r = await _origFiltered.apply(this, arguments);
      try {
        if (!subject && !reviewOnly && window.currentQuestions && window.currentQuestions.length) {
          // Only stash large lists (the whole bank), not tiny chapter mixes.
          if (window.currentQuestions.length > (window.__mockFullBank || []).length) {
            window.__mockFullBank = window.currentQuestions.slice();
          }
        }
      } catch (_) {}
      return r;
    };
    return true;
  }

  // Also stash whenever a session boots (single source of allQuestions).
  var _origSession = null;
  function armSessionHook() {
    if (_origSession || !window.startQBankSession) return false;
    _origSession = window.startQBankSession;
    window.startQBankSession = async function () {
      var r = await _origSession.apply(this, arguments);
      setTimeout(injectSetupButton, 0);
      return r;
    };
    return true;
  }

  var tries = 0;
  var boot = setInterval(function () {
    tries++;
    armWrapper(); armFilteredHook(); armSessionHook();
    hookStash();
    if (document.getElementById("qbank-home-content")) injectSetupButton();
    if (tries > 200) clearInterval(boot);
    if (_origShow && _origFiltered && _origSession) clearInterval(boot);
  }, 500);

  // Expose for debugging / presets.
  window.__mockModules = MODULES;
  window.__mockClassify = classifySubject;
})();
