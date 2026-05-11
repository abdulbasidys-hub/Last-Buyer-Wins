import { useEffect, useState, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, orderBy, limit, onSnapshot, doc } from 'firebase/firestore';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN_CA = 'PASTE_YOUR_CA_HERE';
const X_LINK   = 'https://x.com/PASTE_YOUR_X_HERE';
const API_KEY  = import.meta.env.VITE_TRACKER_CODE;
const MIN_BUY_USD = 10;

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

const short  = (a) => a ? `${a.slice(0,4)}…${a.slice(-4)}` : '—';
const fmtUSD = (n) => n != null
  ? `$${Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`
  : '—';

function timerColor(pct) {
  if (pct > 0.5) return '#a78bfa';
  if (pct > 0.2) return '#fb923c';
  return '#f87171';
}

// ─── FLOATING TIMER ───────────────────────────────────────────────────────────
function FloatingTimer({ secondsLeft }) {
  const pct   = Math.max(0, secondsLeft / TIMER_SECONDS);
  const color = timerColor(pct);
  const r = 22, circ = 2 * Math.PI * r;
  return (
    <div className={`float-timer${pct <= 0.2 ? ' urgent' : ''}`}>
      <svg width="60" height="60" viewBox="0 0 60 60" style={{position:'absolute',top:0,left:0}}>
        <circle cx="30" cy="30" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3.5"/>
        <circle cx="30" cy="30" r={r} fill="none" stroke={color} strokeWidth="3.5"
          strokeDasharray={`${pct*circ} ${circ}`} strokeDashoffset={circ/4} strokeLinecap="round"
          style={{transition:'stroke-dasharray .6s ease,stroke .4s ease'}}/>
      </svg>
      <span className="ft-num" style={{color}}>{secondsLeft}</span>
      <span className="ft-lbl">SEC</span>
    </div>
  );
}

// ─── COUNTDOWN RING ───────────────────────────────────────────────────────────
function Ring({ secondsLeft }) {
  const pct = Math.max(0, secondsLeft / TIMER_SECONDS);
  const color = timerColor(pct);
  const r = 56, circ = 2 * Math.PI * r;
  return (
    <div className="ring-wrap">
      <svg width="148" height="148" viewBox="0 0 148 148">
        <circle cx="74" cy="74" r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6"/>
        <circle cx="74" cy="74" r={r} fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={`${pct*circ} ${circ}`} strokeDashoffset={circ/4} strokeLinecap="round"
          style={{transition:'stroke-dasharray .6s ease,stroke .4s ease',filter:`drop-shadow(0 0 8px ${color}88)`}}/>
      </svg>
      <div className="ring-center">
        <span className="ring-num" style={{color}}>{secondsLeft}</span>
        <span className="ring-sub">seconds</span>
      </div>
    </div>
  );
}

// ─── BUYER ROW ────────────────────────────────────────────────────────────────
function BuyerRow({ buyer, isFirst, index }) {
  const ts = buyer.time?.toDate ? buyer.time.toDate() : buyer.time ? new Date(buyer.time) : null;
  return (
    <div className={`b-row${isFirst?' b-row--top':''}`} style={{animationDelay:`${index*.04}s`}}>
      <span className="b-rank">{isFirst ? '👑' : `#${index+1}`}</span>
      <a className="b-addr" href={`https://solscan.io/account/${buyer.wallet}`} target="_blank" rel="noreferrer">
        {short(buyer.wallet)}
      </a>
      <span className="b-time">{ts ? ts.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—'}</span>
      {isFirst && <span className="b-pill">Leading</span>}
    </div>
  );
}

// ─── WINNER ROW ───────────────────────────────────────────────────────────────
function WinnerRow({ winner, index }) {
  const date = winner.timestamp?.toDate ? new Date(winner.timestamp.toDate()).toLocaleDateString() : '—';
  return (
    <div className="w-row" style={{animationDelay:`${index*.05}s`}}>
      <span className="w-rank">#{index+1}</span>
      <a className="w-addr" href={`https://solscan.io/account/${winner.wallet}`} target="_blank" rel="noreferrer">
        {short(winner.wallet)}
      </a>
      <span className="w-amt">{fmtUSD(winner.amountUsd)}</span>
      <span className="w-date">{date}</span>
      {winner.txSignature &&
        <a className="w-tx" href={`https://solscan.io/tx/${winner.txSignature}`} target="_blank" rel="noreferrer">↗</a>}
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
  const nextRef = useRef(null);

  useEffect(() => {
    const q = query(collection(db,'buyers'), orderBy('time','desc'), limit(50));
    return onSnapshot(q, s => setBuyers(s.docs.map(d => ({id:d.id,...d.data()}))));
  }, []);

  useEffect(() => {
    const q = query(collection(db,'winners'), orderBy('timestamp','desc'), limit(30));
    return onSnapshot(q, s => setWinners(s.docs.map(d => ({id:d.id,...d.data()}))));
  }, []);

  useEffect(() => {
    return onSnapshot(doc(db,'stats','global'), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      setStats(d);
      if (d.currentPotUsd != null) setPotUsd(d.currentPotUsd);
      if (d.lastBuyTime) nextRef.current = d.lastBuyTime.toMillis() + TIMER_SECONDS * 1000;
    });
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      if (nextRef.current)
        setCountdown(Math.min(TIMER_SECONDS, Math.max(0, Math.ceil((nextRef.current - Date.now()) / 1000))));
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

  const copy = () => navigator.clipboard.writeText(TOKEN_CA).then(() => { setCopied(true); setTimeout(()=>setCopied(false),2000); });
  const pct  = Math.max(0, countdown / TIMER_SECONDS);
  const col  = timerColor(pct);

  return (
    <div className="app">
      <FloatingTimer secondsLeft={countdown} />

      {/* NAV */}
      <nav className="nav">
        <div className="nav-brand">
          <img src="/logo.png" alt="" className="nav-logo" onError={e=>e.target.style.display='none'}/>
          <span className="nav-name">Last Buyer Wins</span>
          <span className="nav-ticker">$LBW</span>
        </div>
        <a className="nav-x" href={X_LINK} target="_blank" rel="noreferrer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
          Twitter
        </a>
      </nav>

      {/* HERO */}
      <section className="hero">
        <div className="hero-eyebrow">Solana Memecoin</div>

        <h1 className="hero-h1">
          The last one<br/>
          <em style={{color:col,fontStyle:'normal'}}>takes it all.</em>
        </h1>

        <p className="hero-p">
          Every qualifying buy resets a 60-second countdown.
          When the clock hits zero, <strong>100% of accumulated creator rewards</strong> are
          sent automatically to the last buyer's wallet.
          Miss the window — someone else walks away with your pot.
        </p>

        {/* Eligibility callout */}
        <div className="eligibility">
          <span className="elig-icon">⚡</span>
          <div>
            <strong>Minimum buy required: ${MIN_BUY_USD}</strong>
            <p>Purchases under ${MIN_BUY_USD} USD do not qualify. Only wallets that buy
            ${MIN_BUY_USD}+ worth of $LBW are entered into the countdown and eligible to win.</p>
          </div>
        </div>

        <div className="ca-row">
          <span className="ca-tag">CA</span>
          <span className="ca-val">{TOKEN_CA === 'PASTE_YOUR_CA_HERE' ? 'Coming soon…' : TOKEN_CA}</span>
          {TOKEN_CA !== 'PASTE_YOUR_CA_HERE' &&
            <button className="ca-btn" onClick={copy}>{copied ? '✓' : 'Copy'}</button>}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="how">
        <h2 className="section-h">How it works</h2>
        <div className="cards-3">
          {[
            { n:'01', icon:'💸', h:'Buy $10+ of $LBW',   b:'Only buys of $10 or more count. Smaller buys are ignored by the contract.' },
            { n:'02', icon:'⏱',  h:'Timer resets',        b:'Every qualifying buy resets the 60-second countdown. The pot keeps growing.' },
            { n:'03', icon:'🏆', h:'Last wallet wins',    b:'60 seconds of silence and the last qualifying buyer gets everything — automatically.' },
          ].map(c => (
            <div className="card3" key={c.n}>
              <span className="card3-n">{c.n}</span>
              <span className="card3-icon">{c.icon}</span>
              <h3 className="card3-h">{c.h}</h3>
              <p  className="card3-p">{c.b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* LIVE */}
      <section className="live">
        <h2 className="section-h">Live arena</h2>

        <div className="live-layout">

          {/* Left — timer + stats */}
          <div className="stats-col">
            <div className="stat-card">
              <p className="stat-label">Time remaining</p>
              <Ring secondsLeft={countdown} />
              <p className="stat-hint" style={{color:col}}>
                {countdown === 0 ? '💸 Payout triggered!' : countdown <= 12 ? '🚨 Almost there!' : 'Countdown active'}
              </p>
            </div>

            <div className="stat-card">
              <p className="stat-label">Current pot</p>
              <p className="stat-big" style={{color:col}}>{potUsd != null && potUsd > 0 ? fmtUSD(potUsd) : '—'}</p>
            </div>

            <div className="stat-card stat-card--grid">
              <div>
                <p className="stat-label">Total paid out</p>
                <p className="stat-med">{stats.totalPaidUsd != null ? fmtUSD(stats.totalPaidUsd) : '—'}</p>
              </div>
              <div>
                <p className="stat-label">Winners</p>
                <p className="stat-med">{stats.totalWinners ?? '—'}</p>
              </div>
              {price && <>
                <div>
                  <p className="stat-label">Token price</p>
                  <p className="stat-med">${price.toFixed(8)}</p>
                </div>
                <div>
                  <p className="stat-label">Min buy</p>
                  <p className="stat-med">${MIN_BUY_USD}</p>
                </div>
              </>}
            </div>
          </div>

          {/* Right — feed */}
          <div className="feed-col">
            <div className="feed-tabs">
              <button className={`ftab${tab==='live'?' ftab--on':''}`} onClick={()=>setTab('live')}>
                <span className={`dot${tab==='live'?' dot--live':''}`}/>
                Live buyers
              </button>
              <button className={`ftab${tab==='winners'?' ftab--on':''}`} onClick={()=>setTab('winners')}>
                🏆 Hall of Fame
              </button>
            </div>

            <div className="feed-body">
              {tab === 'live' && (
                buyers.length === 0
                  ? <div className="feed-empty">No qualifying buys yet.<br/>Be the first with $10+.</div>
                  : <>
                      <div className="feed-head">
                        <span>Rank</span><span>Wallet</span><span>Time</span><span/>
                      </div>
                      {buyers.map((b,i) => <BuyerRow key={b.id} buyer={b} isFirst={i===0} index={i}/>)}
                    </>
              )}
              {tab === 'winners' && (
                winners.length === 0
                  ? <div className="feed-empty">No winners yet.<br/>Could be you.</div>
                  : <>
                      <div className="feed-head winners-head">
                        <span>#</span><span>Wallet</span><span>Won</span><span>Date</span><span/>
                      </div>
                      {winners.map((w,i) => <WinnerRow key={w.id} winner={w} index={i}/>)}
                    </>
              )}
            </div>
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
        <p className="footer-legal">$LBW is a memecoin. Not financial advice. Minimum qualifying buy: $10 USD. Trade responsibly.</p>
      </footer>
    </div>
  );
}
