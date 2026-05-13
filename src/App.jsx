import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, orderBy, limit, onSnapshot, doc } from 'firebase/firestore';

/* ─── CONFIG ──────────────────────────────────────────────────────────────── */
const TOKEN_CA    = 'PASTE_YOUR_CA_HERE';
const X_LINK      = 'https://x.com/PASTE_YOUR_X_HERE';
const API_KEY     = import.meta.env.VITE_TRACKER_CODE;
const MIN_BUY_USD = 10;
const TIMER_TOTAL = 60;

const firebaseConfig = {
  apiKey:            "AIzaSyD6zrFitiXimD3CIz67_cPN1C1TQ_2upxo",
  authDomain:        "last-buyer-wins.firebaseapp.com",
  projectId:         "last-buyer-wins",
  storageBucket:     "last-buyer-wins.firebasestorage.app",
  messagingSenderId: "344177187543",
  appId:             "1:344177187543:web:99797ade8c5ac700016e92",
  measurementId:     "G-XCZPQC1P5R",
};
const fbApp = initializeApp(firebaseConfig);
const db    = getFirestore(fbApp);

/* ─── HELPERS ─────────────────────────────────────────────────────────────── */
const short  = a => a ? `${a.slice(0,4)}…${a.slice(-4)}` : '—';
const fmtUSD = n => n != null ? `$${Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';
const pad2   = n => String(Math.floor(n)).padStart(2,'0');

/* ─── ANIMATED BACKGROUND ────────────────────────────────────────────────── */
function Background({ intensity }) {
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const frameRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);

    const N = 60;
    particlesRef.current = Array.from({length: N}, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.8 + 0.3,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      alpha: Math.random() * 0.5 + 0.1,
      color: Math.random() > 0.5 ? '34,197,94' : Math.random() > 0.5 ? '22,163,74' : '200,255,210',
    }));

    let raf;
    const draw = () => {
      frameRef.current++;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const t = frameRef.current * 0.004;
      const gx1 = canvas.width  * (0.5 + Math.sin(t * 0.7) * 0.35);
      const gy1 = canvas.height * (0.3 + Math.cos(t * 0.5) * 0.25);
      const gx2 = canvas.width  * (0.3 + Math.cos(t * 0.6) * 0.3);
      const gy2 = canvas.height * (0.7 + Math.sin(t * 0.8) * 0.2);

      const g1 = ctx.createRadialGradient(gx1, gy1, 0, gx1, gy1, canvas.width * 0.55);
      g1.addColorStop(0, `rgba(20,80,30,${0.18 + intensity * 0.12})`);
      g1.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g1; ctx.fillRect(0,0,canvas.width,canvas.height);

      const g2 = ctx.createRadialGradient(gx2, gy2, 0, gx2, gy2, canvas.width * 0.5);
      g2.addColorStop(0, `rgba(10,40,10,${0.12 + intensity * 0.08})`);
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2; ctx.fillRect(0,0,canvas.width,canvas.height);

      const sx = canvas.width * (0.5 + Math.sin(t * 0.3) * 0.4);
      const sg = ctx.createLinearGradient(sx - 200, 0, sx + 200, canvas.height * 0.6);
      sg.addColorStop(0, 'rgba(0,0,0,0)');
      sg.addColorStop(0.5, `rgba(34,197,94,${0.02 + intensity * 0.03})`);
      sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sg; ctx.fillRect(0,0,canvas.width,canvas.height);

      particlesRef.current.forEach(p => {
        p.x += p.vx * (1 + intensity * 0.8);
        p.y += p.vy * (1 + intensity * 0.8);
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (1 + intensity * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color},${p.alpha * (0.6 + intensity * 0.4)})`;
        ctx.fill();
      });

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [intensity]);

  return <canvas ref={canvasRef} style={{ position:'fixed', inset:0, zIndex:0, pointerEvents:'none' }} />;
}

/* ─── FLOATING TIMER ─────────────────────────────────────────────────────── */
function FloatingTimer({ seconds }) {
  const pct   = Math.max(0, seconds / TIMER_TOTAL);
  const r     = 22, circ = 2 * Math.PI * r;
  const color = seconds <= 5 ? '#ef4444' : seconds <= 15 ? '#fb923c' : seconds <= 30 ? '#22c55e' : '#22c55e';
  const isCrit = seconds <= 5;

  return (
    <motion.div
      className={`floating-timer${isCrit ? ' floating-timer--crit' : ''}`}
      initial={{ opacity: 0, scale: 0.8, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ delay: 1, type: 'spring', stiffness: 200 }}
    >
      <svg width="60" height="60" viewBox="0 0 60 60" style={{ position:'absolute', top:0, left:0 }}>
        <circle cx="30" cy="30" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
        <circle cx="30" cy="30" r={r} fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={`${pct * circ} ${circ}`}
          strokeDashoffset={circ / 4} strokeLinecap="round"
          style={{ transition: 'stroke-dasharray .6s ease, stroke .4s ease',
            filter: `drop-shadow(0 0 4px ${color})` }} />
      </svg>
      <div className="ft-inner">
        <motion.span
          className="ft-num"
          style={{ color }}
          animate={isCrit ? { scale: [1, 1.15, 1] } : {}}
          transition={isCrit ? { repeat: Infinity, duration: 0.4 } : {}}
        >
          {seconds}
        </motion.span>
        <span className="ft-lbl">SEC</span>
      </div>
    </motion.div>
  );
}

/* ─── COUNTDOWN RING ─────────────────────────────────────────────────────── */
function CountdownRing({ seconds }) {
  const pct      = seconds / TIMER_TOTAL;
  const r        = 110;
  const circ     = 2 * Math.PI * r;
  const dash     = pct * circ;
  const isUrgent = seconds <= 15;
  const isCrit   = seconds <= 5;

  const ringColor = isCrit ? '#ef4444' : isUrgent ? '#fb923c' : '#22c55e';
  const shadowColor = isCrit ? '#ef4444' : isUrgent ? '#fb923c' : '#22c55e';

  return (
    <motion.div
      className="ring-container"
      animate={isCrit ? { scale: [1, 1.015, 1] } : {}}
      transition={isCrit ? { repeat: Infinity, duration: 0.4 } : {}}
    >
      <div className="ring-glow-outer" style={{ boxShadow: `0 0 80px 20px ${shadowColor}22` }} />
      <div className="ring-glow-mid"   style={{ boxShadow: `0 0 40px 10px ${shadowColor}33` }} />

      <svg width="280" height="280" viewBox="0 0 280 280" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="140" cy="140" r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="8" />
        <circle cx="140" cy="140" r={r} fill="none"
          stroke={ringColor} strokeWidth="14" strokeOpacity="0.12"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
        <circle cx="140" cy="140" r={r} fill="none"
          stroke={ringColor} strokeWidth="8"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.6s ease, stroke 0.4s ease',
            filter: `drop-shadow(0 0 12px ${ringColor})` }} />
      </svg>

      <div className="ring-center">
        <div className="ring-label-top">TIME LEFT</div>
        <motion.div
          key={seconds}
          className="ring-digits"
          style={{ color: ringColor }}
          initial={{ scale: 1.15, opacity: 0.6 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.25 }}
        >
          {pad2(Math.floor(seconds / 60))}:{pad2(seconds % 60)}
        </motion.div>
        <div className="ring-label-bot">SECONDS</div>
      </div>
    </motion.div>
  );
}

/* ─── POT DISPLAY ────────────────────────────────────────────────────────── */
function PotDisplay({ value }) {
  const [display, setDisplay] = useState(value ?? 0);
  const targetRef = useRef(value ?? 0);

  useEffect(() => {
    if (value == null) return;
    targetRef.current = value;
    const step = () => {
      setDisplay(prev => {
        const diff = targetRef.current - prev;
        if (Math.abs(diff) < 0.01) return targetRef.current;
        return prev + diff * 0.08;
      });
    };
    const iv = setInterval(step, 16);
    return () => clearInterval(iv);
  }, [value]);

  return (
    <div className="pot-amount">
      <span className="pot-currency">$</span>
      <span className="pot-number">
        {display > 0 ? Number(display).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '0.00'}
      </span>
    </div>
  );
}

/* ─── BUYER CARD ─────────────────────────────────────────────────────────── */
function BuyerCard({ buyer, isFirst }) {
  const ts = buyer.time?.toDate ? buyer.time.toDate() : buyer.time ? new Date(buyer.time) : null;
  const timeAgo = ts ? `${pad2(ts.getHours())}:${pad2(ts.getMinutes())}:${pad2(ts.getSeconds())}` : '--:--:--';

  return (
    <motion.div
      className={`buyer-card${isFirst ? ' buyer-card--leader' : ''}`}
      initial={{ opacity: 0, x: -20, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      layout
    >
      {isFirst && <div className="leader-bar" />}
      <div className="buyer-avatar">
        {buyer.wallet?.slice(0,2).toUpperCase() || '??'}
      </div>
      <div className="buyer-info">
        <a href={`https://solscan.io/account/${buyer.wallet}`} target="_blank" rel="noreferrer" className="buyer-addr">
          {short(buyer.wallet)}
        </a>
        <div className="buyer-time">{timeAgo}</div>
      </div>
      {isFirst && (
        <motion.div
          className="leader-badge"
          animate={{ opacity: [1, 0.6, 1] }}
          transition={{ repeat: Infinity, duration: 1.2 }}
        >
          LAST BUYER
        </motion.div>
      )}
    </motion.div>
  );
}

/* ─── WINNER ROW ─────────────────────────────────────────────────────────── */
function WinnerRow({ winner, index }) {
  const date = winner.timestamp?.toDate
    ? new Date(winner.timestamp.toDate()).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'})
    : '—';
  return (
    <motion.div
      className="winner-row"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
    >
      <span className="wr-rank">#{index+1}</span>
      <a className="wr-addr" href={`https://solscan.io/account/${winner.wallet}`} target="_blank" rel="noreferrer">
        {short(winner.wallet)}
      </a>
      <span className="wr-amt">{fmtUSD(winner.amountUsd)}</span>
      <span className="wr-date">{date}</span>
      {winner.txSignature &&
        <a className="wr-tx" href={`https://solscan.io/tx/${winner.txSignature}`} target="_blank" rel="noreferrer">↗</a>}
    </motion.div>
  );
}

/* ─── STAT BOX ───────────────────────────────────────────────────────────── */
function StatBox({ label, value, accent }) {
  return (
    <div className={`stat-box${accent ? ' stat-box--accent' : ''}`}>
      <div className="stat-box-label">{label}</div>
      <div className="stat-box-value">{value}</div>
    </div>
  );
}

/* ─── MAIN APP ───────────────────────────────────────────────────────────── */
export default function App() {
  const [buyers,    setBuyers]    = useState([]);
  const [winners,   setWinners]   = useState([]);
  const [stats,     setStats]     = useState({});
  const [price,     setPrice]     = useState(null);
  const [potUsd,    setPotUsd]    = useState(null);
  const [potSol,    setPotSol]    = useState(null);
  const [countdown, setCountdown] = useState(TIMER_TOTAL);
  const [copied,    setCopied]    = useState(false);
  const [tab,       setTab]       = useState('buyers');
  const nextRef = useRef(null);

  const isUrgent   = countdown <= 15;
  const isCritical = countdown <= 5;
  const intensity  = isCritical ? 1 : isUrgent ? 0.6 : 0.15;

  useEffect(() => {
    const q = query(collection(db,'buyers'), orderBy('time','desc'), limit(20));
    return onSnapshot(q, s => setBuyers(s.docs.map(d => ({id:d.id,...d.data()}))));
  }, []);

  useEffect(() => {
    const q = query(collection(db,'winners'), orderBy('timestamp','desc'), limit(20));
    return onSnapshot(q, s => setWinners(s.docs.map(d => ({id:d.id,...d.data()}))));
  }, []);

  useEffect(() => {
    return onSnapshot(doc(db,'stats','global'), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      setStats(d);
      if (d.currentPotUsd != null) setPotUsd(d.currentPotUsd);
      if (d.currentPotSol != null) setPotSol(d.currentPotSol);
      if (d.lastBuyTime) nextRef.current = d.lastBuyTime.toMillis() + TIMER_TOTAL * 1000;
    });
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      if (nextRef.current)
        setCountdown(Math.min(TIMER_TOTAL, Math.max(0, Math.ceil((nextRef.current - Date.now()) / 1000))));
    }, 500);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!TOKEN_CA || TOKEN_CA === 'PASTE_YOUR_CA_HERE' || !API_KEY) return;
    const go = async () => {
      try {
        const res = await fetch(`https://data.solanatracker.io/tokens/${TOKEN_CA}`, { headers:{'x-api-key':API_KEY} });
        const d   = await res.json();
        const p   = d?.price?.usd ?? d?.price ?? d?.pools?.[0]?.price?.usd ?? null;
        if (p != null && !isNaN(p)) setPrice(parseFloat(p));
      } catch {}
    };
    go(); const iv = setInterval(go, 30000); return () => clearInterval(iv);
  }, []);

  const copy = () =>
    navigator.clipboard.writeText(TOKEN_CA).then(() => { setCopied(true); setTimeout(()=>setCopied(false),2000); });

  return (
    <div className={`app${isCritical ? ' app--critical' : isUrgent ? ' app--urgent' : ''}`}>
      <Background intensity={intensity} />
      <FloatingTimer seconds={countdown} />

      {/* ── HEADER ── */}
      <motion.header
        className="header"
        initial={{ y: -60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
      >
        <div className="header-inner">
          <div className="header-brand">
            <img
              src="/logo.png"
              alt="Last Buyer Wins"
              className="brand-logo"
              onError={e => e.target.style.display = 'none'}
            />
            <span className="brand-name">LAST BUYER <span>WINS</span></span>
          </div>
          <nav className="header-nav">
            <a href={X_LINK} target="_blank" rel="noreferrer" className="nav-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              Follow
            </a>
            {TOKEN_CA !== 'PASTE_YOUR_CA_HERE' && (
              <a href={`https://dexscreener.com/solana/${TOKEN_CA}`} target="_blank" rel="noreferrer" className="nav-btn nav-btn--chart">
                Chart ↗
              </a>
            )}
          </nav>
        </div>
      </motion.header>

      <main className="main">

        {/* ── HERO ── */}
        <section className="hero">
          <motion.div
            className="hero-eyebrow"
            initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.3 }}
          >
            <span className="live-dot" />
            LIVE ON SOLANA
          </motion.div>

          <motion.div
            className="hero-title-wrap"
            initial={{ opacity:0, y:30 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.45 }}
          >
            <img
              src="/logo.png"
              alt="Last Buyer Wins Logo"
              className="hero-logo"
              onError={e => e.target.style.display = 'none'}
            />
            <h1 className="hero-title">
              The Last Buyer<br />
              <span className="hero-title-accent">Takes Everything.</span>
            </h1>
          </motion.div>

          <motion.p
            className="hero-sub"
            initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.6 }}
          >
            Buy $10+ of $LBW. Reset the 60-second timer. If nobody buys after you —
            every accumulated creator reward is <strong>sent directly to your wallet.</strong>
          </motion.p>

          <motion.div
            className="eligibility-badge"
            initial={{ opacity:0, scale:0.9 }} animate={{ opacity:1, scale:1 }} transition={{ delay:0.75 }}
          >
            <span className="elig-icon">⚡</span>
            Minimum qualifying buy: <strong>${MIN_BUY_USD} USD</strong> — smaller buys are ignored
          </motion.div>

          <motion.div
            className="ca-wrap"
            initial={{ opacity:0, y:15 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.9 }}
          >
            <div className="ca-box">
              <span className="ca-label">CA</span>
              <span className="ca-addr">{TOKEN_CA === 'PASTE_YOUR_CA_HERE' ? 'Coming soon…' : TOKEN_CA}</span>
              {TOKEN_CA !== 'PASTE_YOUR_CA_HERE' &&
                <motion.button className="ca-copy" onClick={copy} whileTap={{ scale:0.95 }}>
                  {copied ? '✓ Copied' : 'Copy'}
                </motion.button>}
            </div>
          </motion.div>
        </section>

        {/* ── ARENA ── */}
        <section className="arena">

          <motion.div
            className="arena-timer"
            initial={{ opacity:0, scale:0.85 }} animate={{ opacity:1, scale:1 }} transition={{ delay:0.5, duration:0.8 }}
          >
            <div className="timer-header">
              <span className="timer-header-text">PAYOUT COUNTDOWN</span>
              {isUrgent && (
                <motion.span
                  className="timer-urgent-badge"
                  animate={{ opacity:[1,0.4,1] }}
                  transition={{ repeat:Infinity, duration:0.6 }}
                >
                  {isCritical ? '🚨 FINAL SECONDS' : '⚠ HURRY UP'}
                </motion.span>
              )}
            </div>

            <CountdownRing seconds={countdown} />

            <div className="pot-card">
              <div className="pot-label">CREATOR WALLET BALANCE</div>
              <PotDisplay value={potUsd} />
              <div className="pot-sol">
                {potSol != null ? `${potSol.toFixed(4)} SOL` : '— SOL'}
              </div>
              <div className="pot-sub">current pot — up for grabs</div>
            </div>

            <div className="mini-stats">
              <StatBox label="Total paid" value={stats.totalPaidUsd != null ? fmtUSD(stats.totalPaidUsd) : '—'} />
              <StatBox label="Winners"    value={stats.totalWinners ?? '—'} />
              <StatBox label="Price"      value={price ? `$${price.toFixed(8)}` : '…'} />
              <StatBox label="Min buy"    value={`$${MIN_BUY_USD}`} accent />
            </div>
          </motion.div>

          <motion.div
            className="arena-feed"
            initial={{ opacity:0, x:30 }} animate={{ opacity:1, x:0 }} transition={{ delay:0.6 }}
          >
            <div className="feed-tabs">
              <button className={`ftab${tab==='buyers'?' ftab--on':''}`} onClick={()=>setTab('buyers')}>
                <span className={`tab-dot${tab==='buyers'?' tab-dot--live':''}`}/>
                Live Buyers
              </button>
              <button className={`ftab${tab==='winners'?' ftab--on':''}`} onClick={()=>setTab('winners')}>
                🏆 Hall of Fame
              </button>
            </div>

            <div className="feed-body">
              <AnimatePresence mode="popLayout">
                {tab === 'buyers' && (
                  <motion.div key="buyers" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}>
                    {buyers.length === 0 ? (
                      <div className="feed-empty">
                        <div className="feed-empty-icon">👀</div>
                        <div>No qualifying buys yet.</div>
                        <div className="feed-empty-sub">Be the first — buy $10+ and lead the countdown.</div>
                      </div>
                    ) : (
                      <AnimatePresence>
                        {buyers.map((b,i) => (
                          <BuyerCard key={b.id} buyer={b} isFirst={i===0} />
                        ))}
                      </AnimatePresence>
                    )}
                  </motion.div>
                )}

                {tab === 'winners' && (
                  <motion.div key="winners" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}>
                    {winners.length === 0 ? (
                      <div className="feed-empty">
                        <div className="feed-empty-icon">🏆</div>
                        <div>No winners yet.</div>
                        <div className="feed-empty-sub">The first winner could be you.</div>
                      </div>
                    ) : (
                      <div>
                        <div className="winner-head">
                          <span>#</span><span>Wallet</span><span>Won</span><span>Date</span><span />
                        </div>
                        {winners.map((w,i) => <WinnerRow key={w.id} winner={w} index={i} />)}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

        </section>

        {/* ── HOW IT WORKS ── */}
        <section className="how">
          <motion.h2
            className="how-title"
            initial={{ opacity:0, y:20 }} whileInView={{ opacity:1, y:0 }}
            viewport={{ once:true }} transition={{ duration:0.6 }}
          >
            How it <span>works</span>
          </motion.h2>
          <div className="how-grid">
            {[
              { n:'01', icon:'💸', h:'Buy $10+ of $LBW',   b:'Purchases under $10 are ignored. Only qualifying buys reset the timer and enter you into the game.' },
              { n:'02', icon:'⏱',  h:'Timer resets',        b:'Every qualifying buy resets the 60-second countdown. The more people buy, the bigger the pot grows.' },
              { n:'03', icon:'🏆', h:'Last buyer wins',     b:'60 seconds of silence. The last qualifying buyer receives 100% of all accumulated creator fees — automatically.' },
            ].map((c,i) => (
              <motion.div
                key={c.n} className="how-card"
                initial={{ opacity:0, y:30 }} whileInView={{ opacity:1, y:0 }}
                viewport={{ once:true }} transition={{ delay:i*0.15, duration:0.6 }}
                whileHover={{ y:-4, transition:{ duration:0.2 } }}
              >
                <div className="how-num">{c.n}</div>
                <div className="how-icon">{c.icon}</div>
                <h3 className="how-h">{c.h}</h3>
                <p  className="how-p">{c.b}</p>
              </motion.div>
            ))}
          </div>
        </section>

      </main>

      {/* ── FOOTER ── */}
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <img
              src="/logo.png"
              alt="Last Buyer Wins"
              className="footer-logo"
              onError={e => e.target.style.display = 'none'}
            />
            <span className="footer-name">LAST BUYER WINS</span>
          </div>
          <div className="footer-links">
            <a href={X_LINK} target="_blank" rel="noreferrer">Twitter</a>
            {TOKEN_CA !== 'PASTE_YOUR_CA_HERE' && <>
              <a href={`https://dexscreener.com/solana/${TOKEN_CA}`} target="_blank" rel="noreferrer">DexScreener</a>
              <a href={`https://solscan.io/token/${TOKEN_CA}`} target="_blank" rel="noreferrer">Solscan</a>
            </>}
          </div>
        </div>
      </footer>
    </div>
  );
}