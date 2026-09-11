import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Exora — The Ultimate Free Medical QBank" },
      {
        name: "description",
        content:
          "Exora is a free Medical QBank featuring over 32,000+ high-yield questions for Examen blanc Résidanat, PLAB, and USMLE across all specialties.",
      },
      { property: "og:title", content: "Exora — Free Medical QBank" },
      {
        property: "og:description",
        content:
          "Practice with 32,000+ questions for the Examen blanc Résidanat, covering all specialties and years. 100% free forever.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800&family=Figtree:wght@400;500;600;700&display=swap",
      },
      {
        rel: "stylesheet",
        href: "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css",
      },
    ],
    scripts: [
      { src: "https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js" },
      { src: "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js" },
    ],
  }),
  component: Landing,
});

const firebaseConfig = {
  apiKey: "AIzaSyD_gavsIcvvxe3inU4gSMxe9YRHoW2U9eA",
  authDomain: "exora-web.firebaseapp.com",
  projectId: "exora-web",
  storageBucket: "exora-web.firebasestorage.app",
  messagingSenderId: "294931423657",
  appId: "1:294931423657:web:b440fdd5ce28c31bb6e4b8",
  measurementId: "G-LTCWM5CPVE"
};

const isLocalDev = typeof location !== "undefined" &&
  ["localhost", "127.0.0.1", "0.0.0.0"].includes(location.hostname);

async function ensureLandingAppCheckReady() {
  const fb = (window as any).firebase;
  if (!fb) throw new Error("Firebase is still loading. Please try again.");
  if (!fb.apps?.length) fb.initializeApp(firebaseConfig);
}

function bootstrapLandingFirebase() {
  const w = window as any;
  const fb = w.firebase;
  if (!fb || w.omnoteLandingBootstrapped) return !!fb;
  try {
    if (!fb.apps?.length) fb.initializeApp(firebaseConfig);
    try { fb.auth().setPersistence(fb.auth.Auth.Persistence.LOCAL).catch(() => {}); } catch {}
    w.omnoteLandingBootstrapped = true;
    return true;
  } catch { return false; }
}

type AuthMode = "signin" | "signup";

const AVATARS = [
  "/app/avatars/avatar-1.png",
  "/app/avatars/avatar-2.png",
  "/app/avatars/avatar-3.png",
  "/app/avatars/avatar-4.png",
  "/app/avatars/avatar-5.png",
];

const APP_URL = "/app/index.html";

function ExoraMark({ size = 26 }: { size?: number }) {
  return (
    <img src="/app/assets/logo.png" alt="Exora Logo" style={{ width: size, height: size, borderRadius: '25%', objectFit: 'cover' }} />
  );
}

/* Live self-answering MCQ demo */
const DEMO_Q = {
  specialty: "Cardiologie",
  text: "Quel est le traitement de première intention d'un OAP cardiogéné ?",
  options: [
    { label: "A", text: "Furosémide IV + dérivés nitrés", correct: true },
    { label: "B", text: "Amiodarone orale", correct: false },
    { label: "C", text: "Aténolol IV", correct: false },
    { label: "D", text: "Digoxine en bolus", correct: false },
  ],
};

function LiveQuestionCard() {
  const [picked, setPicked] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let alive = true;
    const cycle = async () => {
      while (alive) {
        setPicked(null); setRevealed(false);
        await new Promise(r => setTimeout(r, 1600));
        if (!alive) break;
        setPicked(0);
        await new Promise(r => setTimeout(r, 900));
        if (!alive) break;
        setRevealed(true);
        await new Promise(r => setTimeout(r, 3200));
      }
    };
    cycle();
    return () => { alive = false; };
  }, []);

  return (
    <div className="qx-card">
      <div className="qx-top">
        <span className="qx-spec">{DEMO_Q.specialty}</span>
        <span className="qx-timer">⏱ 00:47</span>
      </div>
      <div className="qx-progress"><span /></div>
      <p className="qx-text">{DEMO_Q.text}</p>
      <div className="qx-options">
        {DEMO_Q.options.map((o, i) => (
          <div key={o.label} className={
            "qx-opt" +
            (revealed && o.correct ? " is-correct" : "") +
            (picked === i && !o.correct ? " is-wrong" : "")
          }>
            <span className="qx-key">{o.label}</span>
            <span className="qx-opt-text">{o.text}</span>
            {revealed && o.correct && <span className="qx-check">✓</span>}
            {picked === i && !o.correct && revealed && <span className="qx-cross">✕</span>}
          </div>
        ))}
      </div>
      {revealed && (
        <div className="qx-explain">
          <b>Explication</b> — Le furosémide est le diurétique de l'urgence : il décharge la surcharge volumique.
        </div>
      )}
    </div>
  );
}

function AuthModal({ open, mode, onClose, onSwitch }: { open: boolean; mode: AuthMode; onClose: () => void; onSwitch: (m: AuthMode) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const fb = (window as any).firebase;
    if (fb && !fb.apps?.length) { try { fb.initializeApp(firebaseConfig); } catch {} }
    setEmail(""); setPassword(""); setName(""); setError("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const fb = (window as any).firebase;
    if (!fb) { setError("Auth is still loading, please try again."); return; }
    if (!fb.apps?.length) { try { fb.initializeApp(firebaseConfig); } catch {} }
    if (!email || !password) { setError("Please fill in both fields."); return; }
    if (mode === "signup") {
      if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    }
    setLoading(true);
    try {
      await ensureLandingAppCheckReady();
      if (mode === "signin") {
        await fb.auth().signInWithEmailAndPassword(email, password);
      } else {
        const cred = await fb.auth().createUserWithEmailAndPassword(email, password);
        try {
          const origin = window.location.origin;
          const photoURL = avatar.startsWith("http") ? avatar : origin + avatar;
          await cred.user.updateProfile({ photoURL });
        } catch {}
        // Name + country are collected in the app's welcome screen so this
        // works identically for brand-new AND legacy accounts.
      }
      window.location.href = APP_URL;
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="on-auth-overlay" onClick={onClose}>
      <div className="on-auth-modal" onClick={(e) => e.stopPropagation()}>
        <button className="on-auth-close" onClick={onClose} aria-label="Close">×</button>
        <div className="on-auth-brand">
          <ExoraMark size={24} />
          <span>Exora</span>
        </div>
        <h3 className="on-auth-title">{mode === "signin" ? "Welcome back" : "Create your account"}</h3>
        <p className="on-auth-sub">{mode === "signin" ? "Sign in to your workspace." : "Start learning smarter — it's free, forever."}</p>

        <form onSubmit={submit} className="on-auth-form">
          <input type="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} className="on-input" autoComplete="email" required />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="on-input" autoComplete={mode === "signin" ? "current-password" : "new-password"} required />
          {mode === "signup" && (
            <div className="on-avatar-block">
              <div className="on-avatar-label">Pick your avatar</div>
              <div className="on-avatar-grid">
                {AVATARS.map((src) => (
                  <button type="button" key={src} className={"on-avatar-opt" + (avatar === src ? " is-sel" : "")} onClick={() => setAvatar(src)} aria-label="Select avatar">
                    <img src={src} alt="" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <div className="on-auth-error">{error}</div>}
          <button type="submit" className="on-btn on-btn-primary on-btn-block" disabled={loading}>
            {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
        <div className="on-auth-switch">
          {mode === "signin" ? (
            <>New here? <button onClick={() => onSwitch("signup")}>Create an account</button></>
          ) : (
            <>Already have an account? <button onClick={() => onSwitch("signin")}>Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}

function Landing() {
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [scrolled, setScrolled] = useState(false);
  const [prices, setPrices] = useState<{ pro: string; aplus: string } | null>(null);
  const [banksData, setBanksData] = useState<{ mains: PublicBank[]; examPrep: PublicBank[] } | null>(null);
  const open = (m: AuthMode) => { setAuthMode(m); setAuthOpen(true); };

  useEffect(() => {
    setBanksData({ mains: MOCK_MAIN_BANKS, examPrep: MOCK_EXAM_PREP_BANKS });
  }, []);

  useEffect(() => {
    let url = "/api/kashier?action=quote";
    try {
      if (Intl.DateTimeFormat().resolvedOptions().timeZone === "Africa/Cairo") {
        url += "&currency=EGP";
      }
    } catch(e) {}

    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (data && data.pro && data.aplus) {
          setPrices({ pro: data.pro.label, aplus: data.aplus.label });
        }
      })
      .catch(e => console.error("Failed to fetch prices", e));
  }, []);

  useEffect(() => {
    let unsub: any;
    const t = setInterval(() => {
      if (!(window as any).firebase) return;
      if (!bootstrapLandingFirebase()) return;
      clearInterval(t);
      const fb = (window as any).firebase;
      unsub = fb.auth().onAuthStateChanged((u: any) => { if (u) window.location.href = APP_URL; });
    }, 100);
    return () => { clearInterval(t); if (typeof unsub === "function") unsub(); };
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="on-landing">
      <style>{css}</style>

      <header className={`on-nav-wrap ${scrolled ? "is-scrolled" : ""}`}>
        <nav className="on-nav">
          <a href="/" className="on-brand">
            <ExoraMark />
            <span>Exora</span>
          </a>
          <div className="on-nav-links">
            <a href="#exams">Exams</a>
            <a href="#exam-prep">Exam Prep</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#download">Download</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="on-nav-cta">
            <button className="on-btn on-btn-ghost" onClick={() => open("signin")}>Sign in</button>
            <button className="on-btn on-btn-primary" onClick={() => open("signup")}>Start free</button>
          </div>
        </nav>
      </header>

      {/* ===== HERO: split, copy left / live question right ===== */}
      <section className="hero">
        <div className="hero-grid">
          <div className="hero-copy">

            <h1>The QBank that <em>gets you</em> through residency.</h1>
            <p className="hero-lede">
              Every specialty. Every past exam since 2015. Detailed explanations, smart review,
              and real exam simulation — without paying a cent.
            </p>
            <div className="hero-cta">
              <button className="on-btn on-btn-primary on-btn-lg" onClick={() => open("signup")}>Create free account</button>
              <a className="on-btn on-btn-outline on-btn-lg" href="#exams">Browse exams</a>
            </div>
            <div className="hero-proof">
              <div className="proof-item"><b>32k+</b><span>questions</span></div>
              <div className="proof-sep" />
              <div className="proof-item"><b>16</b><span>specialties</span></div>
              <div className="proof-sep" />
              <div className="proof-item"><b>10 yrs</b><span>of past papers</span></div>
              <div className="proof-sep" />
              <div className="proof-item"><b>$0</b><span>forever</span></div>
            </div>
          </div>
          <div className="hero-demo">
            <LiveQuestionCard />
            <div className="hero-demo-tag">live preview — answers itself while you read</div>
          </div>
        </div>
      </section>

      {/* ===== SPECIALTY MARQUEE ===== */}
      <section className="marquee-band" aria-hidden>
        <div className="marquee">
          {[...SPECIALTIES, ...SPECIALTIES].map((s, i) => (
            <span className="mq-item" key={i}>{s}<i>·</i></span>
          ))}
        </div>
      </section>

      {/* ===== EXAMS (live data) ===== */}
      <section id="exams" className="section">
        <div className="section-head">

          <h2>Every bank we support.</h2>
          <p>Live from the platform — these are the actual question banks available right now.</p>
        </div>
        {banksData && banksData.mains.length > 0 ? (
          <div className="exam-grid">
            {banksData.mains.map((b) => (
              <div key={b.id} className={"exam-card" + (b.country === "tunisia" ? " is-hot" : "")} onClick={() => open("signup")}>
                <img src={`https://flagcdn.com/w40/${({ global: "un", usa: "us", uk: "gb", australia: "au", canada: "ca", india: "in", europe: "eu", tunisia: "tn", algeria: "dz", egypt: "eg", morocco: "ma" } as Record<string, string>)[b.country] || "un"}.png`} alt="" />
                <h3>{b.name}</h3>
                <p>{COUNTRY_LABELS[b.country] || b.country}{b.college ? ` · ${b.college}` : ""}</p>
                <span className="exam-go">Practice →</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="exam-grid">
            <div className="exam-card is-hot" onClick={() => open("signup")}>
              <img src="https://flagcdn.com/w40/tn.png" alt="" />
              <h3>Examen blanc Résidanat</h3>
              <p>Tunisia · all specialties &amp; years</p>
              <span className="exam-go">Practice →</span>
            </div>
            <div className="exam-card" onClick={() => open("signup")}>
              <img src="https://flagcdn.com/w40/dz.png" alt="" />
              <h3>Concours de Résidanat</h3>
              <p>Algeria · comprehensive coverage</p>
              <span className="exam-go">Practice →</span>
            </div>
            <div className="exam-card" onClick={() => open("signup")}>
              <img src="https://flagcdn.com/w40/gb.png" alt="" />
              <h3>PLAB</h3>
              <p>UK · clinical scenarios</p>
              <span className="exam-go">Practice →</span>
            </div>
            <div className="exam-card" onClick={() => open("signup")}>
              <img src="https://flagcdn.com/w40/us.png" alt="" />
              <h3>USMLE Step 1</h3>
              <p>USA · high-yield MCQs</p>
              <span className="exam-go">Practice →</span>
            </div>
          </div>
        )}
      </section>

      {/* ===== EXAM PREP BROWSER (live, filterable) ===== */}
      <section id="exam-prep" className="section section-alt">
        <div className="section-head">

          <h2>Past exams by country &amp; college.</h2>
          <p>Browse real past papers and college-specific banks. Filter by country, drill into a college, or search directly.</p>
        </div>
        <ExamPrepBrowser banks={banksData?.examPrep ?? null} onSignup={() => open("signup")} />
      </section>

      {/* ===== STRICT FEATURES GRID ===== */}
      <section id="features" className="section section-alt">
        <div className="section-head">

          <h2>One workspace. Every tool.</h2>
          <p>Everything below is included on the free plan — no trials, no locked doors.</p>
        </div>
        <div className="features-grid">
          <article className="feat-cell">
            <div className="feat-icon"><i className="fa-solid fa-layer-group"></i></div>
            <h3>32,000+ High-yield questions</h3>
            <p>A decade of past exams, cleaned, categorized by specialty and year, each with a full explanation.</p>
          </article>
          <article className="feat-cell">
            <div className="feat-icon"><i className="fa-solid fa-bolt"></i></div>
            <h3>Instant explanations</h3>
            <p>The “why” behind every answer, written by doctors.</p>
          </article>
          <article className="feat-cell">
            <div className="feat-icon"><i className="fa-solid fa-clone"></i></div>
            <h3>Spaced-repetition flashcards</h3>
            <p>Built-in SRS so what you learn, stays learned.</p>
          </article>
          <article className="feat-cell">
            <div className="feat-icon"><i className="fa-solid fa-chart-pie"></i></div>
            <h3>Weak-spot analytics</h3>
            <p>Per-specialty scores show exactly where to spend your next hour.</p>
          </article>
          <article className="feat-cell">
            <div className="feat-icon"><i className="fa-solid fa-robot"></i></div>
            <h3>AI study tools</h3>
            <p>Turn any PDF into flashcards, MCQs and summaries. Whiteboard &amp; planner included.</p>
          </article>
          <article className="feat-cell">
            <div className="feat-icon"><i className="fa-solid fa-stopwatch"></i></div>
            <h3>Real exam mode</h3>
            <p>Timed blocks, flagging, and the same interface you'll use on exam day.</p>
          </article>
        </div>
      </section>

      {/* ===== PRICING ===== */}
      <section id="pricing" className="section">
        <div className="section-head">

          <h2>Free forever. Support if you want.</h2>
          <p>Exora is 100% free. Supporters keep the servers humming and get perks.</p>
        </div>
        <div className="price-grid">
          <div className="price-card">
            <div className="price-head">
              <h3>Free</h3>
              <div className="amount">$0<span>/mo</span></div>
            </div>
            <ul className="plan-list">
              <li>All AI features unlocked</li>
              <li>Flashcards, MCQs, summaries</li>
              <li>Whiteboard &amp; scheduler</li>
              <li>Daily soft caps on AI usage</li>
            </ul>
            <button className="on-btn on-btn-outline on-btn-block" onClick={() => open("signup")}>Create free account</button>
          </div>
          <div className="price-card is-popular">
            <div className="price-head">
              <div className="pop-badge">Most Popular</div>
              <h3>Supporter</h3>
              <div className="amount">{prices ? prices.pro.split("/mo")[0] : "$10"}<span>/mo</span></div>
            </div>
            <ul className="plan-list">
              <li>Everything in Free</li>
              <li>Smartest AI models</li>
              <li>3,000 monthly credits</li>
              <li>No per-feature caps</li>
              <li>Priority support</li>
            </ul>
            <button className="on-btn on-btn-primary on-btn-block" onClick={() => open("signup")}>Become a Supporter</button>
          </div>
          <div className="price-card">
            <div className="price-head">
              <h3>Supporter+</h3>
              <div className="amount">{prices ? prices.aplus.split("/mo")[0] : "$20"}<span>/mo</span></div>
            </div>
            <ul className="plan-list">
              <li>Everything in Supporter</li>
              <li>Early access to updates</li>
              <li>15,000 monthly credits</li>
              <li>No per-feature caps</li>
              <li>Priority support</li>
            </ul>
            <button className="on-btn on-btn-outline on-btn-block" onClick={() => open("signup")}>Become a Supporter+</button>
          </div>
        </div>
      </section>

      {/* ===== DOWNLOAD ===== */}
      <section id="download" className="section section-alt">
        <div className="section-head">

          <h2>Your account follows you everywhere.</h2>
        </div>
        <div className="dl-grid">
          <article className="dl-card">
            <div className="dl-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg>
            </div>
            <h3>Web app</h3>
            <p>Full workspace in the browser. Any modern desktop or tablet.</p>
            <a className="on-btn on-btn-primary on-btn-block" href={APP_URL}>Launch web app →</a>
            <div className="dl-meta">No install · syncs to your account</div>
          </article>
          <article className="dl-card">
            <div className="dl-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="8" width="12" height="12" rx="2"/><path d="M9 4l1.5 2M15 4l-1.5 2M9 12v3M15 12v3"/></svg>
            </div>
            <h3>Android APK</h3>
            <p>Native-feel build with offline PDFs and Pomodoro alerts.</p>
            <a className="on-btn on-btn-outline on-btn-block" href="https://files.catbox.moe/wz88aq.apk" download>Download APK ↓</a>
            <div className="dl-meta">~18 MB · Android 8+</div>
          </article>
        </div>
      </section>

      {/* ===== FAQ ===== */}
      <section id="faq" className="section section-narrow">
        <div className="section-head">

          <h2>Common questions.</h2>
        </div>
        <div className="faq-list">
          {faqs.map((f) => (
            <details key={f.q} className="faq-item">
              <summary>{f.q}<span className="faq-plus" /></summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ===== FINAL CTA ===== */}
      <section className="final-edge">
        <div className="final-panel-edge">
          <h2>Your residency starts with one question.</h2>
          <p>Answer it on Exora — free, forever.</p>
          <button className="on-btn on-btn-outline on-btn-lg" style={{ color: '#ffffff', borderColor: '#4b5563', background: 'transparent' }} onClick={() => open("signup")}>Create your free account</button>
        </div>
      </section>

      <footer className="foot">
        <div className="foot-inner">
          <a href="/" className="on-brand">
            <ExoraMark size={22} />
            <span>Exora</span>
          </a>
          <div className="foot-links">
            <button onClick={() => open("signin")}>Sign in</button>
            <a href="#exams">Exams</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#download">Download</a>
            <a href="#faq">FAQ</a>
            <a href="/terms-of-service">Terms of Service</a>
            <a href="/privacy-policy">Privacy Policy</a>
            <a href="/refund-policy">Refund Policy</a>
            <a href="/contact-us">Contact Us</a>
          </div>
          <div style={{ width: "100%", textAlign: "center", marginTop: "24px", color: "#6b7f88", fontSize: "14px" }}>
            <p>Need help? Open a support ticket in the app or visit our <a href="/contact-us" style={{ color: "#0e7c86", fontWeight: 600 }}>Contact page</a>.</p>
          </div>
          <div className="foot-copy" style={{ width: "100%", textAlign: "center", marginTop: "12px" }}>© {new Date().getFullYear()} Exora</div>
        </div>
      </footer>

      <AuthModal open={authOpen} mode={authMode} onClose={() => setAuthOpen(false)} onSwitch={setAuthMode} />
    </div>
  );
}

const SPECIALTIES = [
  "Cardiologie", "Neurologie", "Pédiatrie", "Chirurgie générale", "Gynécologie-obstétrique",
  "Pneumologie", "Néphrologie", "Endocrinologie", "Hématologie", "Gastro-entérologie",
  "Psychiatrie", "Dermatologie", "Ophtalmologie", "ORL", "Urologie", "Réanimation",
];

type PublicBank = { id: string; name: string; country: string; kind: string; college: string; year: string };

const MOCK_MAIN_BANKS: PublicBank[] = [
  { id: "mock_eb_tn", name: "Examen blanc Résidanat", country: "tunisia", kind: "main", college: "", year: "" },
  { id: "mock_eb_dz", name: "Concours de Résidanat", country: "algeria", kind: "main", college: "", year: "" },
  { id: "mock_plab", name: "PLAB", country: "uk", kind: "main", college: "", year: "" },
  { id: "mock_usmle", name: "USMLE Step 1", country: "usa", kind: "main", college: "", year: "" },
];

const MOCK_EXAM_PREP_BANKS: PublicBank[] = [
  { id: "mock_ep_1", name: "FMT 2023", country: "tunisia", kind: "examprep", college: "FMT", year: "2023" },
  { id: "mock_ep_2", name: "FMS 2022", country: "tunisia", kind: "examprep", college: "FMS", year: "2022" },
  { id: "mock_ep_3", name: "FMM 2023", country: "tunisia", kind: "examprep", college: "FMM", year: "2023" },
  { id: "mock_ep_4", name: "Alger 2023", country: "algeria", kind: "examprep", college: "Alger", year: "2023" },
  { id: "mock_ep_5", name: "Oran 2022", country: "algeria", kind: "examprep", college: "Oran", year: "2022" },
  { id: "mock_ep_6", name: "PLAB 1 Nov 2023", country: "uk", kind: "examprep", college: "GMC", year: "2023" },
  { id: "mock_ep_7", name: "NBME 31", country: "usa", kind: "examprep", college: "NBME", year: "2023" },
  { id: "mock_ep_8", name: "NBME 30", country: "usa", kind: "examprep", college: "NBME", year: "2022" },
];

const COUNTRY_FLAGS: Record<string, string> = {
  global: "🌍", usa: "🇺🇸", uk: "🇬🇧", australia: "🇦🇺", canada: "🇨🇦", india: "🇮🇳",
  europe: "🇪🇺", tunisia: "🇹🇳", algeria: "🇩🇿", egypt: "🇪🇬", morocco: "🇲🇦",
};
const COUNTRY_LABELS: Record<string, string> = {
  global: "Global", usa: "USA", uk: "UK", australia: "Australia", canada: "Canada",
  india: "India", europe: "Europe", tunisia: "Tunisia", algeria: "Algeria",
  egypt: "Egypt", morocco: "Morocco",
};

function ExamPrepBrowser({ banks, onSignup }: { banks: PublicBank[] | null; onSignup: () => void }) {
  const [country, setCountry] = useState<string>("all");
  const [college, setCollege] = useState<string>("all");
  const [query, setQuery] = useState("");

  const countries = useMemo(() => {
    if (!banks) return [];
    const set = new Map<string, number>();
    banks.forEach((b) => set.set(b.country || "global", (set.get(b.country || "global") || 0) + 1));
    return Array.from(set.entries()).sort((a, b) => b[1] - a[1]);
  }, [banks]);

  const colleges = useMemo(() => {
    if (!banks) return [];
    const scope = banks.filter((b) => country === "all" || (b.country || "global") === country);
    const set = new Map<string, number>();
    scope.forEach((b) => set.set(b.college || "General", (set.get(b.college || "General") || 0) + 1));
    return Array.from(set.entries()).sort((a, b) => b[1] - a[1]);
  }, [banks, country]);

  const visible = useMemo(() => {
    if (!banks) return [];
    return banks.filter((b) => {
      if (country !== "all" && (b.country || "global") !== country) return false;
      if (college !== "all" && (b.college || "General") !== college) return false;
      if (query.trim()) {
        const q = query.toLowerCase();
        const hay = `${b.name} ${b.college} ${b.year}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [banks, country, college, query]);

  // Group visible by college
  const grouped = useMemo(() => {
    const map = new Map<string, PublicBank[]>();
    visible.forEach((b) => {
      const key = b.college || "General";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(b);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  if (!banks) {
    return <div className="ep-loading">Loading exam prep banks…</div>;
  }

  return (
    <div className="ep-browser">
      {/* Country chips */}
      <div className="ep-chips" role="tablist">
        <button className={"ep-chip" + (country === "all" ? " is-on" : "")} onClick={() => { setCountry("all"); setCollege("all"); }}>
          All countries <i>{banks.length}</i>
        </button>
        {countries.map(([c, n]) => (
          <button key={c} className={"ep-chip" + (country === c ? " is-on" : "")} onClick={() => { setCountry(c); setCollege("all"); }}>
            {COUNTRY_FLAGS[c] || "🌍"} {COUNTRY_LABELS[c] || c} <i>{n}</i>
          </button>
        ))}
      </div>

      {/* College select + search */}
      {banks.length > 0 && (
        <div className="ep-controls">
          <label className="ep-college-label">
            College
            <select
              className="ep-select"
              value={college}
              onChange={(e) => setCollege(e.target.value)}
            >
              <option value="all">All colleges ({colleges.reduce((s, [, n]) => s + n, 0)})</option>
              {colleges.map(([c, n]) => (
                <option key={c} value={c}>{c} ({n})</option>
              ))}
            </select>
          </label>
          <input
            className="ep-search"
            type="search"
            placeholder="Search by name, college or year…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {/* Results */}
      {banks.length === 0 ? (
        <div className="ep-empty">
          <p>No exam prep banks published yet — admins can create them from the admin panel.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="ep-empty">
          <p>Nothing matches this filter. Try another country, college, or search term.</p>
        </div>
      ) : (
        grouped.map(([colName, items]) => (
          <div className="ep-college" key={colName}>
            <h4 className="ep-college-name">
              🏫 {colName} <span className="ep-count">{items.length}</span>
            </h4>
            <div className="ep-grid">
              {items.map((b) => (
                <button key={b.id} className="ep-bank-card" onClick={onSignup} title={`Practice ${b.name}`}>
                  <span className="ep-year">{b.year || COUNTRY_LABELS[b.country] || COUNTRY_FLAGS[b.country]}</span>
                  <span className="ep-name">{b.name}</span>
                  <span className="ep-go">Practice →</span>
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const faqs = [
  { q: "Is the QBank really free?", a: "Yes. Every question, specialty, and explanation is completely free—no credit card, no paywall." },
  { q: "Does it cover all specialties?", a: "Absolutely. The 32,000+ questions cover every specialty tested on the Examen blanc Résidanat." },
  { q: "Do you have a mobile app?", a: "Yes — an Android APK is available for direct download, and the web app is fully mobile-responsive." },
  { q: "Can I review my incorrect answers?", a: "Yes, the QBank automatically tracks your performance and lets you build custom review blocks from your incorrect answers." },
];

const css = `
:root {
  --dash-teal: #0e7c86;
  --dash-teal-dark: #0b6770;
  --dash-teal-soft: #e6f4f5;
  --dash-ink: #0a3d4a;
  --dash-ink-2: #334e59;
  --dash-ink-3: #6b7f88;
  --dash-line: #dbe3e7;
  --dash-line-2: #e4eaee;
  --dash-surface: #ffffff;
  --dash-canvas: #f4f6f8;
  --dash-red: #c0392b;
}

.on-landing { min-height: 100vh; background: var(--dash-canvas); color: var(--dash-ink); font-family: 'Roboto', 'Figtree', sans-serif; -webkit-font-smoothing: antialiased; }
.on-landing *, .on-landing *::before, .on-landing *::after { box-sizing: border-box; }
.on-landing a { text-decoration: none; color: inherit; }
.on-landing h1, .on-landing h2, .on-landing h3 { font-family: 'Outfit', sans-serif; color: var(--dash-ink); margin: 0; font-weight: 700; letter-spacing: -0.01em; }
.on-landing p { color: var(--dash-ink-3); margin: 0; }

/* ---------- Nav ---------- */
.on-nav-wrap { position: sticky; top: 0; z-index: 50; background: var(--dash-surface); border-bottom: 1px solid var(--dash-line); }
.on-nav { max-width: 1200px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 12px 24px; }
.on-brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 19px; color: var(--dash-teal); font-family: 'Outfit', sans-serif; }
.on-nav-links { display: flex; gap: 26px; font-size: 13.5px; font-weight: 600; color: var(--dash-ink-2); }
.on-nav-links a:hover { color: var(--dash-teal); }
.on-nav-cta { display: flex; gap: 8px; }
@media (max-width: 860px) { .on-nav-links { display: none; } }

/* ---------- Buttons ---------- */
.on-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; border-radius: 8px; font-family: 'Roboto', sans-serif; font-size: 13px; font-weight: 600; border: 1px solid transparent; cursor: pointer; transition: all 0.15s ease; white-space: nowrap; line-height: 1; box-shadow: none; }
.on-btn-primary { background: var(--dash-teal); color: #ffffff; border: 1px solid var(--dash-teal); }
.on-btn-primary:hover { background: var(--dash-teal-dark); }
.on-btn-ghost { background: transparent; color: var(--dash-ink-3); }
.on-btn-ghost:hover { background: var(--dash-canvas); color: var(--dash-ink); }
.on-btn-outline { background: var(--dash-surface); color: var(--dash-ink); border-color: var(--dash-line-2); }
.on-btn-outline:hover { border-color: var(--dash-teal); color: var(--dash-teal); }
.on-btn-onaccent { background: var(--dash-teal); color: #ffffff; border: 1px solid var(--dash-teal-dark); }
.on-btn-onaccent:hover { background: var(--dash-teal-dark); }
.on-btn-lg { padding: 10px 18px; font-size: 13.5px; }
.on-btn-block { display: flex; width: 100%; }

/* ---------- Hero ---------- */
.hero { padding: 48px 24px 32px; background: var(--dash-surface); border-bottom: 1px solid var(--dash-line); }
.hero-grid { max-width: 1160px; margin: 0 auto; display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 40px; align-items: center; }
@media (max-width: 980px) { .hero-grid { grid-template-columns: 1fr; gap: 40px; } }
.on-pill { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; background: var(--dash-teal-soft); border: 1px solid transparent; border-radius: 6px; color: var(--dash-teal-dark); font-size: 11.5px; font-weight: 700; margin-bottom: 16px; }
.on-pill-dot { display: none; }
.hero-copy h1 { font-size: clamp(32px, 4vw, 44px); line-height: 1.15; margin-bottom: 16px; font-weight: 800; }
.hero-copy h1 em { font-style: normal; color: var(--dash-teal); }
.hero-lede { font-size: 15px; line-height: 1.6; max-width: 480px; margin-bottom: 24px; color: var(--dash-ink-3); }
.hero-cta { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
.hero-proof { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.proof-item { display: flex; flex-direction: column; }
.proof-item b { font-size: 18px; font-weight: 800; color: var(--dash-ink); line-height: 1.2; font-family: 'Outfit', sans-serif; }
.proof-item span { font-size: 11.5px; color: var(--dash-ink-3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.proof-sep { width: 1px; height: 24px; background: var(--dash-line); }

.hero-demo { display: flex; flex-direction: column; gap: 10px; }
.hero-demo-tag { text-align: center; font-size: 11.5px; color: var(--dash-ink-3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }

/* Live question card */
.qx-card { background: var(--dash-surface); border: 1px solid var(--dash-line); padding: 16px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.02); }
.qx-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.qx-spec { font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: var(--dash-teal-dark); background: var(--dash-teal-soft); padding: 3px 9px; border-radius: 999px; letter-spacing: 0.05em; }
.qx-timer { font-size: 11.5px; font-weight: 600; color: var(--dash-ink-3); }
.qx-progress { height: 4px; background: var(--dash-line); margin-bottom: 14px; border-radius: 2px; overflow: hidden; }
.qx-progress span { display: block; width: 38%; height: 100%; background: var(--dash-teal); border-radius: 2px; animation: qxGrow 5.7s linear infinite; }
@keyframes qxGrow { 0%,4% { width: 38%; } 50%,58% { width: 74%; } 100% { width: 38%; } }
.qx-text { font-size: 14px; font-weight: 600; color: var(--dash-ink); line-height: 1.45; margin-bottom: 14px; font-family: 'Outfit', sans-serif; }
.qx-options { display: flex; flex-direction: column; gap: 6px; }
.qx-opt { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--dash-line); font-size: 13px; color: var(--dash-ink-2); background: var(--dash-surface); border-radius: 8px; transition: border-color 0.15s ease, background 0.15s ease; font-weight: 500; }
.qx-key { width: 22px; height: 22px; background: var(--dash-canvas); color: var(--dash-ink-3); font-weight: 700; font-size: 11px; display: grid; place-items: center; flex-shrink: 0; border-radius: 6px; border: 1px solid var(--dash-line-2); }
.qx-opt.is-correct { border-color: #0f8a5f; background: #f2faf6; color: #0f8a5f; }
.qx-opt.is-correct .qx-key { background: #0f8a5f; color: #fff; border-color: #0f8a5f; }
.qx-opt.is-wrong { border-color: var(--dash-red); background: #fef6f6; color: var(--dash-red); }
.qx-opt.is-wrong .qx-key { background: var(--dash-red); color: #fff; border-color: var(--dash-red); }
.qx-check { margin-left: auto; color: #0f8a5f; font-weight: bold; }
.qx-cross { margin-left: auto; color: var(--dash-red); font-weight: bold; }
.qx-explain { margin-top: 12px; padding: 12px; background: var(--dash-canvas); border: 1px solid var(--dash-line); font-size: 12.5px; line-height: 1.5; color: var(--dash-ink-2); border-radius: 8px; }
.qx-explain b { color: var(--dash-ink); }

/* ---------- Specialty marquee ---------- */
.marquee-band { overflow: hidden; border-bottom: 1px solid var(--dash-line); background: var(--dash-surface); padding: 10px 0; }
.marquee { display: flex; gap: 40px; width: max-content; animation: mq 42s linear infinite; }
.mq-item { font-size: 12px; font-weight: 700; color: var(--dash-ink-3); text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; display: inline-flex; align-items: center; gap: 40px; }
.mq-item i { font-style: normal; color: var(--dash-line-2); }
@keyframes mq { from { transform: translateX(0); } to { transform: translateX(-50%); } }

/* ---------- Sections ---------- */
.section { max-width: 1160px; margin: 0 auto; padding: 48px 24px; border-bottom: 1px solid var(--dash-line); }
.section-alt { max-width: none; background: var(--dash-canvas); border-bottom: 1px solid var(--dash-line); }
.section-alt > div { max-width: 1160px; margin: 0 auto; padding: 48px 24px; }
.section-narrow { max-width: 800px; margin: 0 auto; border: none; }
.section-head { text-align: left; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid var(--dash-line); }
.section-head h2 { font-size: 24px; font-weight: 800; margin-bottom: 6px; }
.section-head p { font-size: 14px; color: var(--dash-ink-3); line-height: 1.5; }
.eyebrow { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--dash-teal); margin-bottom: 8px; letter-spacing: 0.05em; }

/* ---------- Exams ---------- */
.exam-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
@media (max-width: 960px) { .exam-grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 520px) { .exam-grid { grid-template-columns: 1fr; } }
.exam-card { background: var(--dash-surface); border: 1px solid var(--dash-line); padding: 16px; text-align: left; cursor: pointer; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; border-radius: 12px; transition: all 0.15s ease; box-shadow: 0 1px 3px rgba(0,0,0,0.02); }
.exam-card:hover { border-color: var(--dash-teal); }
.exam-card img { width: 32px; border-radius: 4px; }
.exam-card h3 { font-size: 14px; font-weight: 700; color: var(--dash-ink); }
.exam-card p { font-size: 12px; color: var(--dash-ink-3); font-weight: 500; margin-top: -2px; }
.exam-go { margin-top: auto; padding-top: 10px; font-size: 11.5px; font-weight: 700; color: var(--dash-teal); }
.exam-card.is-hot { border: 1px solid var(--dash-teal-soft); background: #fcfdfe; }

/* ---------- Exam Prep browser ---------- */
.ep-browser { display: flex; flex-direction: column; gap: 16px; }
.ep-loading { text-align: left; color: var(--dash-ink-3); font-size: 13px; padding: 24px 0; }
.ep-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.ep-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--dash-line-2); background: var(--dash-surface); color: var(--dash-ink-2); font-size: 12px; font-weight: 600; border-radius: 8px; cursor: pointer; transition: all 0.15s ease; }
.ep-chip i { font-style: normal; font-size: 10.5px; color: var(--dash-ink-3); background: var(--dash-canvas); padding: 2px 6px; border-radius: 4px; }
.ep-chip:hover { border-color: var(--dash-teal); color: var(--dash-teal); }
.ep-chip.is-on { background: var(--dash-teal); border-color: var(--dash-teal); color: #ffffff; }
.ep-chip.is-on i { background: rgba(255,255,255,0.2); color: #ffffff; }
.ep-controls { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.ep-college-label { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--dash-ink-2); }
.ep-select { padding: 6px 10px; border: 1px solid var(--dash-line-2); font-size: 13px; color: var(--dash-ink); background: var(--dash-surface); border-radius: 8px; min-width: 200px; cursor: pointer; }
.ep-search { flex: 1; min-width: 200px; max-width: 320px; padding: 6px 10px; border: 1px solid var(--dash-line-2); border-radius: 8px; font-size: 13px; color: var(--dash-ink); background: var(--dash-surface); }
.ep-select:focus, .ep-search:focus { outline: none; border-color: var(--dash-teal); }
.ep-empty { padding: 24px; border: 1px solid var(--dash-line); background: var(--dash-surface); color: var(--dash-ink-3); font-size: 13px; text-align: center; border-radius: 12px; }
.ep-college { display: flex; flex-direction: column; gap: 10px; }
.ep-college-name { font-size: 14.5px; font-weight: 700; color: var(--dash-ink); display: flex; align-items: center; gap: 8px; padding-bottom: 2px; }
.ep-count { font-size: 10.5px; font-weight: 700; color: var(--dash-teal-dark); background: var(--dash-teal-soft); padding: 2px 6px; border-radius: 999px; }
.ep-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.ep-bank-card { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; background: var(--dash-surface); border: 1px solid var(--dash-line); padding: 12px 14px; cursor: pointer; border-radius: 12px; transition: all 0.15s ease; box-shadow: 0 1px 3px rgba(0,0,0,0.02); }
.ep-bank-card:hover { border-color: var(--dash-teal); }
.ep-year { font-size: 10.5px; font-weight: 700; color: var(--dash-teal-dark); background: var(--dash-teal-soft); padding: 2px 6px; border-radius: 999px; letter-spacing: 0.05em; }
.ep-name { font-size: 13.5px; font-weight: 700; color: var(--dash-ink); line-height: 1.3; font-family: 'Outfit', sans-serif; }
.ep-go { font-size: 10.5px; font-weight: 700; color: var(--dash-teal); margin-top: 2px; }

/* ---------- Strict Features Grid ---------- */
.features-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; border: 1px solid var(--dash-line); background: var(--dash-surface); border-radius: 12px; overflow: hidden; }
@media (max-width: 900px) { .features-grid { grid-template-columns: 1fr; } }
.feat-cell { border-right: 1px solid var(--dash-line); border-bottom: 1px solid var(--dash-line); padding: 20px; display: flex; flex-direction: column; gap: 6px; }
.features-grid .feat-cell:nth-child(3n) { border-right: none; }
.features-grid .feat-cell:nth-last-child(-n+3) { border-bottom: none; }
@media (max-width: 900px) { .features-grid .feat-cell { border-right: none !important; border-bottom: 1px solid var(--dash-line) !important; } .features-grid .feat-cell:last-child { border-bottom: none !important; } }
.feat-cell h3 { font-size: 13.5px; font-weight: 700; color: var(--dash-ink); }
.feat-cell p { font-size: 12.5px; line-height: 1.5; color: var(--dash-ink-3); }
.feat-icon { font-size: 15px; margin-bottom: 2px; color: var(--dash-teal); }

/* ---------- Pricing ---------- */
.price-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; max-width: 960px; margin: 0 auto; border: 1px solid var(--dash-line); border-radius: 12px; overflow: hidden; }
@media (max-width: 900px) { .price-grid { grid-template-columns: 1fr; max-width: 420px; } }
.price-card { background: var(--dash-surface); padding: 24px; display: flex; flex-direction: column; position: relative; border-right: 1px solid var(--dash-line); }
.price-card:last-child { border-right: none; }
@media (max-width: 900px) { .price-card { border-right: none; border-bottom: 1px solid var(--dash-line); } .price-card:last-child { border-bottom: none; } }
.price-card.is-popular { background: var(--dash-canvas); }
.price-head { min-height: 80px; margin-bottom: 20px; border-bottom: 1px solid var(--dash-line); padding-bottom: 12px; }
.pop-badge { display: inline-block; background: var(--dash-teal); color: #ffffff; font-size: 9px; font-weight: 700; padding: 2px 6px; text-transform: uppercase; border-radius: 4px; letter-spacing: 0.05em; margin-bottom: 6px; }
.price-head h3 { font-size: 14.5px; font-weight: 700; margin-bottom: 6px; color: var(--dash-ink); text-transform: uppercase; }
.amount { font-size: 28px; font-weight: 800; color: var(--dash-ink); font-family: 'Outfit', sans-serif; line-height: 1; }
.amount span { font-size: 12px; color: var(--dash-ink-3); font-weight: 500; text-transform: none; }
.plan-list { list-style: none; padding: 0; margin: 0 0 20px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
.plan-list li { position: relative; padding-left: 18px; font-size: 12.5px; color: var(--dash-ink-2); }
.plan-list li::before { content: "■"; position: absolute; left: 0; top: 0; color: var(--dash-teal); font-size: 9px; line-height: 1.8; }

/* ---------- Download ---------- */
.dl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; max-width: 800px; margin: 0 auto; }
@media (max-width: 720px) { .dl-grid { grid-template-columns: 1fr; } }
.dl-card { background: var(--dash-surface); border: 1px solid var(--dash-line); padding: 20px; display: flex; flex-direction: column; gap: 8px; border-radius: 12px; }
.dl-icon { width: 36px; height: 36px; background: var(--dash-teal-soft); border: 1px solid var(--dash-line); color: var(--dash-teal); display: grid; place-items: center; border-radius: 8px; }
.dl-card h3 { font-size: 14.5px; font-weight: 700; color: var(--dash-ink); }
.dl-card p { font-size: 13px; line-height: 1.5; color: var(--dash-ink-3); }
.dl-meta { font-size: 11.5px; font-weight: 600; color: var(--dash-ink-3); text-align: left; margin-top: 4px; }

/* ---------- FAQ ---------- */
.faq-list { display: flex; flex-direction: column; gap: 8px; }
.faq-item { border: 1px solid var(--dash-line); background: var(--dash-surface); border-radius: 10px; overflow: hidden; }
.faq-item summary { list-style: none; padding: 14px 18px; font-size: 14px; font-weight: 700; color: var(--dash-ink); cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 10px; font-family: 'Outfit', sans-serif; }
.faq-item summary:hover { background: var(--dash-canvas); }
.faq-item summary::-webkit-details-marker { display: none; }
.faq-plus { position: relative; width: 12px; height: 12px; flex-shrink: 0; }
.faq-plus::before, .faq-plus::after { content: ""; position: absolute; background: var(--dash-teal); border-radius: 0; }
.faq-plus::before { left: 0; right: 0; top: 5px; height: 2px; }
.faq-plus::after { top: 0; bottom: 0; left: 5px; width: 2px; transition: transform 0.2s ease; }
.faq-item[open] .faq-plus::after { transform: scaleY(0); }
.faq-item p { padding: 0 18px 18px; font-size: 13px; line-height: 1.6; color: var(--dash-ink-3); background: var(--dash-surface); }

/* ---------- Final Edge CTA ---------- */
.final-edge { width: 100%; border-top: 1px solid var(--dash-line); }
.final-panel-edge { background: var(--dash-ink); padding: 64px 24px; text-align: center; }
.final-panel-edge h2 { color: #ffffff; font-size: clamp(24px, 4vw, 32px); margin-bottom: 10px; font-weight: 800; }
.final-panel-edge p { color: var(--dash-ink-3); font-size: 14px; margin-bottom: 24px; }

/* ---------- Footer ---------- */
.foot { background: var(--dash-canvas); border-top: 1px solid var(--dash-line); }
.foot-inner { max-width: 1160px; margin: 0 auto; padding: 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.foot-links { display: flex; gap: 16px; font-size: 12.5px; font-weight: 600; color: var(--dash-ink-3); flex-wrap: wrap; justify-content: center; }
.foot-links button, .foot-links a { background: none; border: none; padding: 0; font-family: inherit; font-size: inherit; color: inherit; cursor: pointer; }
.foot-links button:hover, .foot-links a:hover { color: var(--dash-teal); }
.foot-copy { font-size: 11.5px; color: var(--dash-ink-3); font-weight: 600; }

/* ---------- Auth modal ---------- */
.on-auth-overlay { position: fixed; inset: 0; background: rgba(27, 54, 93, 0.7); z-index: 100; display: grid; place-items: center; padding: 20px; animation: onFade 0.15s ease; }
@keyframes onFade { from { opacity: 0 } to { opacity: 1 } }
.on-auth-modal { background: var(--dash-surface); border-radius: 12px; padding: 28px 24px 20px; width: 100%; max-width: 380px; position: relative; animation: onRise 0.2s ease; border: 1px solid var(--dash-line); box-shadow: 0 10px 25px -5px rgba(27, 54, 93, 0.2); }
@keyframes onRise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
.on-auth-close { position: absolute; top: 10px; right: 10px; background: transparent; border: none; font-size: 18px; color: var(--dash-ink-3); cursor: pointer; width: 28px; height: 28px; border-radius: 8px; transition: background 0.15s ease; display: grid; place-items: center; }
.on-auth-close:hover { background: var(--dash-canvas); color: var(--dash-ink); }
.on-auth-brand { display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 800; font-size: 16px; color: var(--dash-ink); margin-bottom: 12px; font-family: 'Outfit', sans-serif; }
.on-auth-title { font-size: 18px; font-weight: 800; color: var(--dash-ink); text-align: center; margin: 0 0 4px; font-family: 'Outfit', sans-serif; }
.on-auth-sub { font-size: 12.5px; color: var(--dash-ink-3); text-align: center; margin: 0 0 16px; }
.on-auth-form { display: flex; flex-direction: column; gap: 10px; }
.on-input { width: 100%; padding: 8px 12px; border: 1px solid var(--dash-line-2); border-radius: 8px; font-family: 'Roboto', sans-serif; font-size: 13.5px; color: var(--dash-ink); background: var(--dash-surface); transition: border-color 0.15s ease; }
.on-input:focus { border-color: var(--dash-teal); outline: none; }
.on-auth-error { padding: 8px 10px; background: #fef6f6; border: 1px solid #f8c8c9; border-radius: 8px; color: var(--dash-red); font-size: 12.5px; font-weight: 600; }
.on-auth-switch { text-align: center; margin-top: 14px; font-size: 12.5px; color: var(--dash-ink-3); }
.on-auth-switch button { background: none; border: none; color: var(--dash-teal); font-weight: 700; cursor: pointer; font-family: inherit; font-size: inherit; padding: 0 4px; }
.on-auth-switch button:hover { text-decoration: underline; }
.on-avatar-block { padding-top: 2px; }
.on-avatar-label { font-size: 11.5px; font-weight: 700; color: var(--dash-ink-3); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
.on-avatar-grid { display: flex; gap: 6px; }
.on-avatar-opt { padding: 0; background: transparent; border: 2px solid transparent; border-radius: 8px; cursor: pointer; width: 40px; height: 40px; overflow: hidden; }
.on-avatar-opt img { width: 100%; height: 100%; object-fit: cover; display: block; }
.on-avatar-opt.is-sel { border-color: var(--dash-teal); }
`;
