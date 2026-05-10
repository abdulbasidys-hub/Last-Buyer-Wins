import { useEffect, useState, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, orderBy, limit, onSnapshot, doc } from 'firebase/firestore';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN_CA = 'G2hAvfD2WLx4sNgMypSTiZGtuLLdsCapLFizQmqLGzgp';
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

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

const TIMER_SECONDS = 60; // 1 minute

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const short = (addr) => addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : '—';
const fmtUSD = (n) => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function Particle({ style }) {
  return <div className="particle" style={style} />;
}

function CountdownRing({ secondsLeft, total = TIMER_SECONDS }) {
  const r = 54;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, secondsLeft / total);
  const dash = pct * circ;
  const color = pct > 0.5 ? '#00ff87' : pct > 0.2 ? '#ffcc00' : '#ff4444';

  return (
    <div className="ring-wrap">
      <svg width="140" height="140" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#1a1a2e" strokeWidth="8" />
        <circle
          cx="60" cy="60" r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={`${dash} ${circ}`}
          strokeDashoffset={circ / 4}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.5s ease, stroke 0.3s ease', filter: `drop-shadow(0 0 6px ${color})` }}
        />
      </svg>
      <div className="ring-inner">
        <span className="ring-num" style={{ color }}>{secondsLeft}</span>
        <span className="ring-label">SEC</span>
      </div>
    </div>
  );
}

function BuyerRow({ buyer, isFirst, index }) {
  return (
    <div className={`buyer-row ${isFirst ? 'buyer-row--first' : ''}`} style={{ animationDelay: `${index * 0.04}s` }}>
      {isFirst && <div className="buyer-crown">👑</div>}
      <div className="buyer-index">{index + 1}</div>
      <div className="buyer-addr">
        <a href={`https://solscan.io/account/${buyer.wallet}`} target="_blank" rel="noreferrer">
          {short(buyer.wallet)}
        </a>
      </div>
      <div className="buyer-time">{buyer.time ? new Date(buyer.time).toLocaleTimeString() : '—'}</div>
      {isFirst && <div className="buyer-badge">LAST BUYER</div>}
    </div>
  );
}

function WinnerRow({ winner, index }) {
  return (
    <div className="winner-row" style={{ animationDelay: `${index * 0.06}s` }}>
      <div className="winner-pos">#{index + 1}</div>
      <div className="winner-addr">
        <a href={`https://solscan.io/account/${winner.wallet}`} target="_blank" rel="noreferrer">
          {short(winner.wallet)}
        </a>
      </div>
      <div className="winner-amount">{fmtUSD(winner.amountUsd)}</div>
      <div className="winner-date">{winner.timestamp?.toDate ? new Date(winner.timestamp.toDate()).toLocaleDateString() : '—'}</div>
      {winner.txSignature && (
        <a className="winner-tx" href={`https://solscan.io/tx/${winner.txSignature}`} target="_blank" rel="noreferrer">
          TX ↗
        </a>
      )}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [buyers, setBuyers]     = useState([]);
  const [winners, setWinners]   = useState([]);
  const [stats, setStats]       = useState({});
  const [price, setPrice]       = useState(null);
  const [potUsd, setPotUsd]     = useState(null);
  const [countdown, setCountdown] = useState(TIMER_SECONDS);
  const [copied, setCopied]     = useState(false);
  const [tab, setTab]           = useState('live'); // 'live' | 'winners'
  const nextDistRef             = useRef(null);
  const tickRef                 = useRef(null);

  // ── Firestore: buyers feed (last buyers collection) ──────────────────────
  useEffect(() => {
    const q = query(collection(db, 'buyers'), orderBy('time', 'desc'), limit(50));
    return onSnapshot(q, snap => {
      setBuyers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, []);

  // ── Firestore: winners feed ───────────────────────────────────────────────
  useEffect(() => {
    const q = query(collection(db, 'winners'), orderBy('timestamp', 'desc'), limit(30));
    return onSnapshot(q, snap => {
      setWinners(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, []);

  // ── Firestore: global stats ───────────────────────────────────────────────
  useEffect(() => {
    return onSnapshot(doc(db, 'stats', 'global'), (snap) => {
      if (!snap.exists()) return;
      const d = snap.data();
      setStats(d);
      if (d.currentPotUsd != null) setPotUsd(d.currentPotUsd);
      if (d.lastBuyTime) {
        const nextMs = d.lastBuyTime.toMillis() + TIMER_SECONDS * 1000;
        nextDistRef.current = nextMs;
      }
    });
  }, []);

  // ── Local countdown ticker ────────────────────────────────────────────────
  useEffect(() => {
    tickRef.current = setInterval(() => {
      if (nextDistRef.current) {
        const secs = Math.max(0, Math.ceil((nextDistRef.current - Date.now()) / 1000));
        setCountdown(secs);
      }
    }, 500);
    return () => clearInterval(tickRef.current);
  }, []);

  // ── SolanaTracker price ───────────────────────────────────────────────────
  useEffect(() => {
    if (!TOKEN_CA || TOKEN_CA === 'PASTE_YOUR_CA_HERE' || !API_KEY) return;
    const fetchToken = async () => {
      try {
        const res  = await fetch(`https://data.solanatracker.io/tokens/${TOKEN_CA}`, {
          headers: { 'x-api-key': API_KEY }
        });
        const data = await res.json();
        const p    = data?.price?.usd ?? data?.price ?? data?.pools?.[0]?.price?.usd ?? null;
        if (p !== null && !isNaN(p)) setPrice(parseFloat(p));
      } catch {}
    };
    fetchToken();
    const iv = setInterval(fetchToken, 30000);
    return () => clearInterval(iv);
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(TOKEN_CA).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const potIsLive = potUsd != null && potUsd > 0;

  return (
    <div className="app">
      {/* Background particles */}
      {Array.from({ length: 18 }).map((_, i) => (
        <Particle key={i} style={{
          left: `${Math.random() * 100}%`,
          top:  `${Math.random() * 100}%`,
          animationDuration: `${6 + Math.random() * 10}s`,
          animationDelay: `${Math.random() * 6}s`,
          width:  `${2 + Math.random() * 3}px`,
          height: `${2 + Math.random() * 3}px`,
        }} />
      ))}

      {/* ── HEADER ── */}
      <header className="header">
        <div className="header-inner">
          <div className="logo-wrap">
            <img src="/logo.png" alt="Last Buyer Wins" className="logo" onError={e => { e.target.style.display='none'; }} />
            <div className="logo-text">
              <span className="logo-title">LAST BUYER WINS</span>
            </div>
          </div>
          <nav className="nav">
            <a className="nav-link" href={X_LINK} target="_blank" rel="noreferrer">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              Follow
            </a>
          </nav>
        </div>
      </header>

      {/* ── HERO ── */}
      <section className="hero">
        <div className="hero-tag">💰 DEV FEES GO TO THE LAST BUYER</div>
        <h1 className="hero-title">
          Be The<br />
          <span className="hero-accent">Last Buyer.</span><br />
          Win Everything.
        </h1>
        <p className="hero-desc">
          Every time someone buys <strong>$LBW</strong>, a 60-second timer resets.
          When that timer hits zero — the last wallet to buy wins all accumulated creator rewards.
          Keep buying. Keep winning.
        </p>

        {/* CA Box */}
        <div className="ca-box">
          <span className="ca-label">CA</span>
          <span className="ca-addr">{TOKEN_CA === 'PASTE_YOUR_CA_HERE' ? 'Token not yet launched' : TOKEN_CA}</span>
          {TOKEN_CA !== 'PASTE_YOUR_CA_HERE' && (
            <button className="ca-copy" onClick={handleCopy}>{copied ? '✓ Copied' : 'Copy'}</button>
          )}
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="how-it-works">
        <h2 className="section-title">How It Works</h2>
        <div className="steps">
          {[
            { icon: '🪙', title: 'Buy $LBW', desc: 'Purchase tokens through any Solana DEX. Every buy registers your wallet.' },
            { icon: '⏱️', title: 'Timer Resets', desc: 'Each buy resets the 60-second countdown. The pot keeps growing.' },
            { icon: '🏆', title: 'Last One Wins', desc: 'When no one buys for 60 seconds, all dev fees are sent to the last buyer.' },
          ].map((s, i) => (
            <div className="step" key={i}>
              <div className="step-icon">{s.icon}</div>
              <div className="step-title">{s.title}</div>
              <div className="step-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── LIVE PANEL ── */}
      <section className="live-section">
        <div className="live-grid">

          {/* Timer + Pot */}
          <div className="timer-card card">
            <div className="card-label">COUNTDOWN TO PAYOUT</div>
            <CountdownRing secondsLeft={countdown} />
            <div className="pot-info">
              <div className="pot-row">
                <span className="pot-key">Current Pot</span>
                <span className="pot-val pot-val--big">{potIsLive ? fmtUSD(potUsd) : '—'}</span>
              </div>
              <div className="pot-row">
                <span className="pot-key">Total Paid Out</span>
                <span className="pot-val">{stats.totalPaidUsd != null ? fmtUSD(stats.totalPaidUsd) : '—'}</span>
              </div>
              <div className="pot-row">
                <span className="pot-key">All-Time Winners</span>
                <span className="pot-val">{stats.totalWinners ?? '—'}</span>
              </div>
              {price && (
                <div className="pot-row">
                  <span className="pot-key">Token Price</span>
                  <span className="pot-val">${price.toFixed(8)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Buyers Feed */}
          <div className="buyers-card card">
            <div className="tabs">
              <button className={`tab ${tab === 'live' ? 'tab--active' : ''}`} onClick={() => setTab('live')}>
                🔴 Live Buyers
              </button>
              <button className={`tab ${tab === 'winners' ? 'tab--active' : ''}`} onClick={() => setTab('winners')}>
                🏆 Hall of Fame
              </button>
            </div>

            {tab === 'live' && (
              <div className="feed">
                {buyers.length === 0 ? (
                  <div className="feed-empty">No buyers yet. Be the first!</div>
                ) : (
                  <>
                    <div className="feed-header">
                      <span>#</span><span>Wallet</span><span>Time</span><span></span>
                    </div>
                    {buyers.map((b, i) => (
                      <BuyerRow key={b.id} buyer={b} isFirst={i === 0} index={i} />
                    ))}
                  </>
                )}
              </div>
            )}

            {tab === 'winners' && (
              <div className="feed">
                {winners.length === 0 ? (
                  <div className="feed-empty">No winners yet. Could be you!</div>
                ) : (
                  <>
                    <div className="feed-header winners-header">
                      <span>#</span><span>Wallet</span><span>Won</span><span>Date</span><span></span>
                    </div>
                    {winners.map((w, i) => (
                      <WinnerRow key={w.id} winner={w} index={i} />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="footer">
        <div className="footer-links">
          <a href={X_LINK} target="_blank" rel="noreferrer">𝕏 Twitter</a>
          {TOKEN_CA !== 'PASTE_YOUR_CA_HERE' && (
            <a href={`https://dexscreener.com/solana/${TOKEN_CA}`} target="_blank" rel="noreferrer">DexScreener</a>
          )}
          {TOKEN_CA !== 'PASTE_YOUR_CA_HERE' && (
            <a href={`https://solscan.io/token/${TOKEN_CA}`} target="_blank" rel="noreferrer">Solscan</a>
          )}
        </div>
        <p className="footer-disc">$LBW is a memecoin. Not financial advice. Trade responsibly.</p>
      </footer>
    </div>
  );
}
