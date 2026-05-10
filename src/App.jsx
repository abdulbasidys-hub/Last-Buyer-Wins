import { useEffect, useState, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, orderBy, limit, onSnapshot, doc } from 'firebase/firestore';

// ─── CONFIG — edit these two lines before deploying ───────────────────────────
const TOKEN_CA = 'PASTE_YOUR_CA_HERE';
const X_LINK   = 'https://x.com/PASTE_YOUR_X_HERE';
const API_KEY  = import.meta.env.VITE_TRACKER_CODE;

const firebaseConfig = {
  apiKey: "AIzaSyD6zrFitiXimD3CIz67_cPN1C1TQ_2upxo",
  authDomain: "last-buyer-wins.firebaseapp.com",
  projectId: "last-buyer-wins",
  storageBucket: "last-buyer-wins.firebasestorage.app",
  messagingSenderId: "344177187543",
  appId: "1:344177187543:web:99797ade8c5ac700016e92",
  measurementId: "G-XCZPQC1P5R"
};

const fbApp = initializeApp(firebaseConfig);
const db    = getFirestore(fbApp);
const TIMER_SECONDS = 60;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const short  = (a) => a ? `${a.slice(0,4)}…${a.slice(-4)}` : '—';
const fmtUSD = (n) => n != null
  ? `$${Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`
  : '—';

function timerColor(pct) {
  if (pct > 0.5) return '#60a5fa';
  if (pct > 0.2) return '#fb923c';
  return '#f87171';
}

// ─── FLOATING CORNER TIMER ────────────────────────────────────────────────────
function FloatingTimer({ secondsLeft }) {
  const pct   = Math.max(0, secondsLeft / TIMER_SECONDS);
  const color = timerColor(pct);
  const r = 20, circ = 2 * Math.PI * r;

  return (
    <div className={`float-timer${pct <= 0.2 ? ' float-timer--urgent' : ''}`}>
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="4"/>
        <circle
          cx="28" cy="28" r={r} fill="none"
          stroke={color} strokeWidth="4"
          strokeDasharray={`${pct * circ} ${circ}`}
          strokeDashoffset={circ / 4} strokeLinecap="round"
          style={{ transition:'stroke-dasharray .6s ease, stroke .4s ease', filter:`drop-shadow(0 0 4px ${color})` }}
        />
      </svg>
      <div className="float-inner">
        <span className="float-num"  style={{ color }}>{secondsLeft}</span>
        <span className="float-label">SEC</span>
      </div>
    </div>
  );
}

// ─── BIG RING ─────────────────────────────────────────────────────────────────
function CountdownRing({ secondsLeft }) {
  const r = 54, circ = 2 * Math.PI * r;
  const pct   = Math.max(0, secondsLeft / TIMER_SECONDS);
  const color = timerColor(pct);

  return (
    <div className="ring-wrap">
      <svg width="140" height="140" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="7"/>
        <circle
          cx="60" cy="60" r={r} fill="none"
          stroke={color} strokeWidth="7"
          strokeDasharray={`${pct * circ} ${circ}`}
          strokeDashoffset={circ / 4} strokeLinecap="round"
          style={{ transition:'stroke-dasharray .6s ease, stroke .4s ease', filter:`drop-shadow(0 0 7px ${color})` }}
        />
      </svg>
      <div className="ring-inner">
        <span className="ring-num" style={{ color }}>{secondsLeft}</span>
        <span className="ring-label">SEC</span>
      </div>
    </div>
  );
}

// ─── ROWS ─────────────────────────────────────────────────────────────────────
function BuyerRow({ buyer, isFirst, index }) {
  const ts = buyer.time?.toDate
    ? buyer.time.toDate()
    : buyer.time ? new Date(buyer.time) : null;
  return (
    <div className={`buyer-row${isFirst ? ' buyer-row--first' : ''}`} style={{ animationDelay:`${index*.04}s` }}>
      <div className="buyer-index">{isFirst ? '👑' : index + 1}</div>
      <div className="buyer-addr">
        <a href={`https://solscan.io/account/${buyer.wallet}`} target="_blank" rel="noreferrer">
          {short(buyer.wallet)}
        </a>
      </div>
      <div className="buyer-time">{ts ? ts.toLocaleTimeString() : '—'}</div>
      {isFirst && <span className="buyer-badge">LAST BUYER</span>}
    </div>
  );
}

function WinnerRow({ winner, index }) {
  const date = winner.timestamp?.toDate
    ? new Date(winner.timestamp.toDate()).toLocaleDateString()
    : '—';
  return (
    <div className="winner-row" style={{ animationDelay:`${index*.06}s` }}>
      <div className="winner-pos">#{index + 1}</div>
      <div className="winner-addr">
        <a href={`https://solscan.io/account/${winner.wallet}`} target="_blank" rel="noreferrer">
          {short(winner.wallet)}
        </a>
      </div>
      <div className="winner-amount">{fmtUSD(winner.amountUsd)}</div>
      <div className="winner-date">{date}</div>
      {winner.txSignature && (
        <a className="winner-tx" href={`https://solscan.io/tx/${winner.txSignature}`} target="_blank" rel="noreferrer">
          TX ↗
        </a>
      )}
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [buyers,    setBuyers]    = useState([]);
  const [winners,   setWinners]   = useState([]);
  const [stats,     setStats]     = useState({});
  const [price,     setPrice]     = useState(null);
  const [potUsd,    setPotUsd]    = useState(null);
  const [countdown, setCountdown] = useState(TIMER_SECONDS);
  const [copied,    setCopied]    = useState(false);
  const [tab,       setTab]       = useState('live');
  const nextDistRef = useRef(null);

  // ── Firestore: buyers ────────────────────────────────────────────────────
  useEffect(() => {
    const q = query(collection(db,'buyers'), orderBy('time','desc'), limit(50));
    return onSnapshot(q, snap => setBuyers(snap.docs.map(d => ({id:d.id,...d.data()}))));
  }, []);

  // ── Firestore: winners ───────────────────────────────────────────────────
  useEffect(() => {
    const q = query(collection(db,'winners'), orderBy('timestamp','desc'), limit(30));
    return onSnapshot(q, snap => setWinners(snap.docs.map(d => ({id:d.id,...d.data()}))));
  }, []);

  // ── Firestore: stats/global ──────────────────────────────────────────────
  useEffect(() => {
    return onSnapshot(doc(db,'stats','global'), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      setStats(d);
      if (d.currentPotUsd != null) setPotUsd(d.currentPotUsd);
      if (d.lastBuyTime) {
        // lastBuyTime is a Firestore Timestamp
        nextDistRef.current = d.lastBuyTime.toMillis() + TIMER_SECONDS * 1000;
      }
    });
  }, []);

  // ── Local countdown ticker ───────────────────────────────────────────────
  // Runs every 500ms regardless of Firestore state.
  // If nextDistRef is null (no data yet) it just shows TIMER_SECONDS.
  useEffect(() => {
    const iv = setInterval(() => {
      if (nextDistRef.current) {
        const secs = Math.max(0, Math.ceil((nextDistRef.current - Date.now()) / 1000));
        setCountdown(Math.min(secs, TIMER_SECONDS));
      }
    }, 500);
    return () => clearInterval(iv);
  }, []);

  // ── SolanaTracker token price ────────────────────────────────────────────
  useEffect(() => {
    if (!TOKEN_CA || TOKEN_CA === 'PASTE_YOUR_CA_HERE' || !API_KEY) return;
    const go = async () => {
      try {
        const res  = await fetch(`https://data.solanatracker.io/tokens/${TOKEN_CA}`, {
          headers: { 'x-api-key': API_KEY }
        });
        const data = await res.json();
        const p    = data?.price?.usd ?? data?.price ?? data?.pools?.[0]?.price?.usd ?? null;
        if (p != null && !isNaN(p)) setPrice(parseFloat(p));
      } catch {}
    };
    go();
    const iv = setInterval(go, 30000);
    return () => clearInterval(iv);
  }, []);

  const handleCopy = () =>
    navigator.clipboard.writeText(TOKEN_CA)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });

  const pct   = Math.max(0, countdown / TIMER_SECONDS);
  const color = timerColor(pct);

  return (
    <div className="app">
      <FloatingTimer secondsLeft={countdown} />

      {/* HEADER */}
      <header className="header">
        <div className="header-inner">
          <div className="logo-wrap">
            <img src="/logo.png" alt="LBW" className="logo" onError={e => e.target.style.display='none'}/>
            <div className="logo-text">
              <span className="logo-title">LAST BUYER</span>
              <span className="logo-sub">WINS</span>
            </div>
          </div>
          <nav className="nav">
            <a className="nav-link" href={X_LINK} target="_blank" rel="noreferrer">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              Follow
            </a>
          </nav>
        </div>
      </header>

      {/* HERO */}
      <section className="hero">
        <div className="hero-tag">💰 DEV FEES GO TO THE LAST BUYER</div>
        <h1 className="hero-title">
          Be The Last Buyer.<br/>
          <span style={{ color }}>Win Everything.</span>
        </h1>
        <p className="hero-desc">
          Every buy resets a 60-second timer. When it hits zero, the last wallet
          collects all accumulated creator rewards — automatically, on-chain.
        </p>
        <div className="ca-box">
          <span className="ca-label">CA</span>
          <span className="ca-addr">
            {TOKEN_CA === 'PASTE_YOUR_CA_HERE' ? 'Coming soon…' : TOKEN_CA}
          </span>
          {TOKEN_CA !== 'PASTE_YOUR_CA_HERE' &&
            <button className="ca-copy" onClick={handleCopy}>{copied ? '✓ Copied' : 'Copy'}</button>}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="how-it-works">
        <h2 className="section-title">How It Works</h2>
        <div className="steps">
          {[
            { icon:'🪙', title:'Buy $LBW',     desc:'Buy on any Solana DEX. Your wallet becomes the new last buyer.' },
            { icon:'⏱️', title:'Timer Resets',  desc:'Every buy resets the 60-second countdown. Fees keep stacking.' },
            { icon:'🏆', title:'Last One Wins', desc:'60 seconds with no buys? Everything goes to that last wallet.' },
          ].map((s,i) => (
            <div className="step" key={i}>
              <div className="step-icon">{s.icon}</div>
              <div className="step-title">{s.title}</div>
              <div className="step-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* LIVE PANEL */}
      <section className="live-section">
        <div className="live-grid">

          <div className="timer-card card">
            <div className="card-label">COUNTDOWN TO PAYOUT</div>
            <CountdownRing secondsLeft={countdown} />
            <div className="pot-info">
              {[
                { k:'Current Pot',      v: potUsd != null && potUsd > 0 ? fmtUSD(potUsd) : '—', accent: true },
                { k:'Total Paid Out',   v: stats.totalPaidUsd != null ? fmtUSD(stats.totalPaidUsd) : '—' },
                { k:'All-Time Winners', v: stats.totalWinners ?? '—' },
                ...(price ? [{ k:'Token Price', v:`$${price.toFixed(8)}` }] : []),
              ].map((row,i) => (
                <div className="pot-row" key={i}>
                  <span className="pot-key">{row.k}</span>
                  <span className={`pot-val${row.accent?' pot-val--accent':''}`}
                        style={row.accent ? { color } : {}}>
                    {row.v}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="buyers-card card">
            <div className="tabs">
              <button className={`tab${tab==='live'?' tab--active':''}`} onClick={() => setTab('live')}>
                🔴 Live Buyers
              </button>
              <button className={`tab${tab==='winners'?' tab--active':''}`} onClick={() => setTab('winners')}>
                🏆 Hall of Fame
              </button>
            </div>

            {tab === 'live' && (
              <div className="feed">
                {buyers.length === 0
                  ? <div className="feed-empty">No buyers yet — be the first!</div>
                  : <>
                      <div className="feed-header"><span>#</span><span>Wallet</span><span>Time</span><span/></div>
                      {buyers.map((b,i) => <BuyerRow key={b.id} buyer={b} isFirst={i===0} index={i}/>)}
                    </>
                }
              </div>
            )}

            {tab === 'winners' && (
              <div className="feed">
                {winners.length === 0
                  ? <div className="feed-empty">No winners yet — could be you!</div>
                  : <>
                      <div className="feed-header winners-header">
                        <span>#</span><span>Wallet</span><span>Won</span><span>Date</span><span/>
                      </div>
                      {winners.map((w,i) => <WinnerRow key={w.id} winner={w} index={i}/>)}
                    </>
                }
              </div>
            )}
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="footer">
        <div className="footer-links">
          <a href={X_LINK} target="_blank" rel="noreferrer">𝕏 Twitter</a>
          {TOKEN_CA !== 'PASTE_YOUR_CA_HERE' && <>
            <a href={`https://dexscreener.com/solana/${TOKEN_CA}`} target="_blank" rel="noreferrer">DexScreener</a>
            <a href={`https://solscan.io/token/${TOKEN_CA}`} target="_blank" rel="noreferrer">Solscan</a>
          </>}
        </div>
      </footer>
    </div>
  );
}
