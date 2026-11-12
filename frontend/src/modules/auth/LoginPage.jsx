import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import logoImg from '../../assets/crmonce-logo.png';

const MicrosoftIcon = () => (
  <svg width="20" height="20" viewBox="0 0 21 21" fill="none">
    <rect x="1" y="1" width="9" height="9" fill="#F25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
    <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
    <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
  </svg>
);
const MailIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" />
  </svg>
);
const LockIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
  </svg>
);
const ArrowIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
const CloseIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

// ── Interactive animated brand visual — CSS-only, lightweight, decorative only ──
// (pointer-events: none so it never blocks the click-to-open interaction).
// Accents use the CRMONCE palette: pink / blue / green / white. Every animated
// element carries a base transform so it stays centered under prefers-reduced-motion.
const ORBITS = [
  { r: 195, dur: 22, color: '#E84C88', size: 13, rev: false },
  { r: 145, dur: 16, color: '#5FB0E8', size: 11, rev: true },
  { r: 98, dur: 11, color: '#2ECC71', size: 9, rev: false },
];
const PARTICLES = Array.from({ length: 24 }, (_, i) => ({
  left: 3 + ((i * 43) % 94),
  top: 4 + ((i * 47) % 92),
  size: 3 + (i % 4),
  color: ['#5FB0E8', '#E84C88', '#2ECC71', '#FFFFFF'][i % 4],
  dur: 7 + (i % 6) * 1.2,
  delay: (i % 7) * 0.8,
}));
const NET_NODES = [
  { x: 60, y: 80, c: '#E84C88', r: 4 }, { x: 170, y: 46, c: '#5FB0E8', r: 3.5 },
  { x: 290, y: 92, c: '#2ECC71', r: 4 }, { x: 250, y: 200, c: '#FFFFFF', r: 3 },
  { x: 110, y: 220, c: '#5FB0E8', r: 3.5 }, { x: 180, y: 140, c: '#E84C88', r: 3.5 },
  { x: 40, y: 160, c: '#2ECC71', r: 3 }, { x: 320, y: 150, c: '#5FB0E8', r: 3 },
];
const NET_LINES = [[0, 1], [1, 2], [2, 7], [7, 3], [3, 4], [4, 6], [6, 0], [0, 5], [1, 5], [5, 3], [5, 4], [2, 3]];
const BLOBS = [
  { bg: 'rgba(232,76,136,0.42)', size: 340, left: '50%', top: '-2%', dur: 13, delay: 0 },
  { bg: 'rgba(74,163,223,0.42)', size: 400, left: '2%', top: '26%', dur: 16, delay: 1.6 },
  { bg: 'rgba(46,204,113,0.32)', size: 300, left: '42%', top: '58%', dur: 14, delay: 0.8 },
];
const BRAND_VISUAL_CSS = `
.cr-stage{position:relative;width:30rem;height:30rem;max-width:100%}
.cr-blob{position:absolute;border-radius:50%;filter:blur(48px);opacity:.58;transform:translate(0,0);animation-name:crBlob;animation-timing-function:ease-in-out;animation-iteration-count:infinite}
.cr-net{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.cr-net-g{animation:crNet 12s ease-in-out infinite;transform-origin:center}
.cr-ring{position:absolute;top:50%;left:50%;border-style:solid;border-width:1px;border-radius:50%;transform-origin:center;transform:translate(-50%,-50%)}
.cr-ring1{width:420px;height:420px;border-color:rgba(232,76,136,.34);transform:translate(-50%,-50%) scaleY(.5);animation:crT1 46s linear infinite}
.cr-ring2{width:320px;height:320px;border-color:rgba(74,163,223,.40);transform:translate(-50%,-50%) scaleY(.5);animation:crT2 36s linear infinite}
.cr-ring3{width:220px;height:220px;border-color:rgba(46,204,113,.34);transform:translate(-50%,-50%) scaleY(.56);animation:crT3 28s linear infinite}
.cr-ring4{width:138px;height:138px;border-color:rgba(255,255,255,.28);transform:translate(-50%,-50%) scaleY(.62);animation:crT4 22s linear infinite}
.cr-core{position:absolute;top:50%;left:50%;width:140px;height:140px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.3) 0%,rgba(74,163,223,.2) 45%,transparent 70%);transform:translate(-50%,-50%);animation:crPulse 6.5s ease-in-out infinite}
.cr-orbit{position:absolute;top:50%;left:50%;width:0;height:0;animation-name:crSpin;animation-timing-function:linear;animation-iteration-count:infinite;animation-duration:16s}
.cr-node{position:absolute;left:0;top:0;border-radius:50%}
.cr-p{position:absolute;border-radius:50%;opacity:0;animation-name:crFloat;animation-timing-function:ease-in-out;animation-iteration-count:infinite}
.cr-cue{animation:crCue 3.2s ease-in-out infinite}
@keyframes crSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes crT1{from{transform:translate(-50%,-50%) rotate(0) scaleY(.5)}to{transform:translate(-50%,-50%) rotate(360deg) scaleY(.5)}}
@keyframes crT2{from{transform:translate(-50%,-50%) rotate(0) scaleY(.5)}to{transform:translate(-50%,-50%) rotate(-360deg) scaleY(.5)}}
@keyframes crT3{from{transform:translate(-50%,-50%) rotate(0) scaleY(.56)}to{transform:translate(-50%,-50%) rotate(360deg) scaleY(.56)}}
@keyframes crT4{from{transform:translate(-50%,-50%) rotate(0) scaleY(.62)}to{transform:translate(-50%,-50%) rotate(-360deg) scaleY(.62)}}
@keyframes crPulse{0%,100%{opacity:.55;transform:translate(-50%,-50%) scale(.92)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.1)}}
@keyframes crFloat{0%{opacity:0;transform:translateY(22px) scale(.5)}15%{opacity:1}55%{opacity:.8;transform:translateY(-20px) scale(1)}100%{opacity:0;transform:translateY(-56px) scale(.4)}}
@keyframes crNet{0%,100%{opacity:.55;transform:translateY(0)}50%{opacity:.85;transform:translateY(-8px)}}
@keyframes crBlob{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(0,-16px) scale(1.09)}}
@keyframes crCue{0%,100%{transform:translateY(0);box-shadow:0 10px 30px -8px rgba(232,76,136,0.5)}50%{transform:translateY(-4px);box-shadow:0 18px 40px -8px rgba(232,76,136,0.7)}}
@media (prefers-reduced-motion: reduce){.cr-stage *{animation:none!important}.cr-p{opacity:.75}.cr-core{opacity:.9}.cr-blob{opacity:.58}.cr-cue{animation:none!important}}
`;

function BrandVisual() {
  return (
    <div className="cr-stage" aria-hidden="true">
      {BLOBS.map((b, i) => (
        <span key={`b${i}`} className="cr-blob" style={{ left: b.left, top: b.top, width: b.size, height: b.size, background: `radial-gradient(circle, ${b.bg} 0%, transparent 70%)`, animationDuration: `${b.dur}s`, animationDelay: `${b.delay}s` }} />
      ))}
      <svg className="cr-net" viewBox="0 0 360 300" fill="none">
        <g className="cr-net-g">
          {NET_LINES.map(([a, b], i) => (
            <line key={i} x1={NET_NODES[a].x} y1={NET_NODES[a].y} x2={NET_NODES[b].x} y2={NET_NODES[b].y} stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
          ))}
          {NET_NODES.map((n, i) => (
            <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.c} style={{ filter: `drop-shadow(0 0 6px ${n.c})` }} />
          ))}
        </g>
      </svg>
      <span className="cr-ring cr-ring1" />
      <span className="cr-ring cr-ring2" />
      <span className="cr-ring cr-ring3" />
      <span className="cr-ring cr-ring4" />
      <span className="cr-core" />
      {ORBITS.map((o, i) => (
        <span key={i} className="cr-orbit" style={{ animationDuration: `${o.dur}s`, animationDirection: o.rev ? 'reverse' : 'normal' }}>
          <span className="cr-node" style={{ width: o.size, height: o.size, background: o.color, boxShadow: `0 0 16px 3px ${o.color}`, transform: `translate(-50%,-50%) translateX(${o.r}px)` }} />
        </span>
      ))}
      {PARTICLES.map((p, i) => (
        <span key={i} className="cr-p" style={{ left: `${p.left}%`, top: `${p.top}%`, width: p.size, height: p.size, background: p.color, boxShadow: `0 0 8px ${p.color}`, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }} />
      ))}
    </div>
  );
}

export default function LoginPage() {
  const { login, loginWithAzure } = useAuth();
  const [azureLoading, setAzureLoading] = useState(false);
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);

  // UI-only interaction state: whether the login drawer is open.
  const [open, setOpen] = useState(false);
  const emailRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => { try { emailRef.current?.focus(); } catch { /* ignore */ } }, 340);
    return () => clearTimeout(t);
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(form.email, form.password);
      const dest = sessionStorage.getItem('postLoginRedirect');
      sessionStorage.removeItem('postLoginRedirect');
      navigate(dest || '/', { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  const inputCls = 'w-full h-11 pl-11 pr-4 bg-slate-50/80 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#E84C88]/25 focus:border-[#E84C88] hover:border-slate-300 transition-all';

  return (
    <div className="relative min-h-screen w-full overflow-hidden"
      style={{ background: 'linear-gradient(150deg, #0C2740 0%, #143A5E 46%, #0A2236 100%)' }}>
      <style>{BRAND_VISUAL_CSS}</style>

      {/* Premium depth on the blue gradient (decorative, never block clicks) */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '34px 34px' }} />
      <div className="pointer-events-none absolute -top-28 -right-24 w-[32rem] h-[32rem] rounded-full" style={{ background: 'radial-gradient(circle, rgba(232,76,136,0.18) 0%, transparent 70%)' }} />
      <div className="pointer-events-none absolute top-1/3 -left-28 w-[32rem] h-[32rem] rounded-full" style={{ background: 'radial-gradient(circle, rgba(74,163,223,0.18) 0%, transparent 70%)' }} />
      <div className="pointer-events-none absolute -bottom-32 left-1/4 w-[30rem] h-[30rem] rounded-full" style={{ background: 'radial-gradient(circle, rgba(46,139,87,0.16) 0%, transparent 70%)' }} />

      {/* Animated brand visual — centered on the interactive area, behind the trigger */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center lg:justify-start lg:pl-[8%]">
        <BrandVisual />
      </div>

      {/* Full-area click-to-open trigger (keyboard accessible real <button>). Inner
          content is pointer-events-none so clicks anywhere hit the button. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open the sign-in panel"
        aria-expanded={open}
        className="absolute inset-0 z-10 cursor-pointer bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5FB0E8]/60 focus-visible:ring-inset"
      >
        <div className="pointer-events-none relative h-full w-full flex flex-col items-center justify-between py-16 sm:py-20 px-6 text-center">
          {/* Wordmark */}
          <div>
            <div className="text-3xl sm:text-4xl font-bold tracking-wide">
              <span style={{ color: '#E84C88' }}>CRM</span>
              <span className="text-white/35 mx-1">|</span>
              <span className="text-white">ONCE</span>
            </div>
            <p className="text-white/40 text-[11px] sm:text-xs tracking-[0.25em] uppercase mt-1">(OPC) Private Limited</p>
          </div>

          {/* Click-to-sign-in cue (visual affordance; the whole area is clickable) */}
          <div className="flex flex-col items-center gap-3">
            <span className="cr-cue inline-flex items-center gap-2 px-6 py-3 rounded-full text-white font-semibold text-sm"
              style={{ background: 'linear-gradient(135deg, #E84C88 0%, #D81B60 100%)' }}>
              Sign in <ArrowIcon />
            </span>
            <span className="text-white/55 text-xs tracking-wide">Click anywhere to sign in</span>
          </div>
        </div>
      </button>

      {/* ── Light login drawer (brand light-blue/white). Hidden off-canvas until opened. ── */}
      <aside
        role="dialog"
        aria-modal="false"
        aria-label="Sign in to CRMONCE HR"
        aria-hidden={!open}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        className={`fixed top-0 right-0 z-30 h-full w-full sm:w-[440px] transition-transform duration-500 ease-out motion-reduce:transition-none ${open ? 'translate-x-0' : 'translate-x-full pointer-events-none'}`}
        style={{ background: 'linear-gradient(165deg, #FFFFFF 0%, #EEF4FB 58%, #E6EFFA 100%)', borderLeft: '1px solid rgba(203,213,225,0.7)', boxShadow: '-24px 0 70px -24px rgba(16,42,67,0.35)' }}
      >
        {/* subtle brand glows inside the light panel (no empty flatness) */}
        <div className="pointer-events-none absolute -top-20 -right-16 w-56 h-56 rounded-full" style={{ background: 'radial-gradient(circle, rgba(232,76,136,0.10), transparent 70%)' }} />
        <div className="pointer-events-none absolute -bottom-24 -left-16 w-64 h-64 rounded-full" style={{ background: 'radial-gradient(circle, rgba(27,79,114,0.10), transparent 70%)' }} />

        <div className="relative h-full overflow-y-auto px-6 sm:px-9 py-9 flex flex-col justify-center">
          {/* Close */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close the sign-in panel"
            className="absolute top-5 right-5 w-9 h-9 inline-flex items-center justify-center rounded-full text-slate-400 bg-slate-100 border border-slate-200 hover:bg-slate-200 hover:text-slate-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E84C88]/40"
            tabIndex={open ? 0 : -1}
          >
            <CloseIcon />
          </button>

          <div className="w-full max-w-sm mx-auto">
            {/* Logo (moved here, top of the right login section — reads on the light bg) */}
            <div className="mb-7 flex justify-center">
              <img src={logoImg} alt="CRMONCE" className="h-12 w-auto object-contain" />
            </div>

            {/* Header */}
            <div className="mb-7 text-center">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#E84C88]/10 text-[#D81B60] text-[11px] font-semibold tracking-wide mb-3">
                <span className="w-1.5 h-1.5 rounded-full bg-[#E84C88]" /> CRMONCE HR PORTAL
              </span>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Welcome back</h1>
              <p className="text-slate-500 text-sm mt-1.5">Sign in to continue to your HR workspace.</p>
            </div>

            {/* Email/Password Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Email address</label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"><MailIcon /></span>
                  <input
                    ref={emailRef}
                    type="email"
                    required
                    className={inputCls}
                    placeholder="you@crmonce.com"
                    value={form.email}
                    onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                    autoComplete="email"
                    tabIndex={open ? 0 : -1}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-semibold text-slate-700">Password</label>
                  <button
                    type="button"
                    className="text-xs text-[#E84C88] hover:text-[#D81B60] font-semibold transition-colors"
                    onClick={() => toast('Contact your administrator', { icon: 'ℹ️' })}
                    tabIndex={open ? 0 : -1}
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"><LockIcon /></span>
                  <input
                    type="password"
                    required
                    className={inputCls}
                    placeholder="Enter your password"
                    value={form.password}
                    onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                    autoComplete="current-password"
                    tabIndex={open ? 0 : -1}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                tabIndex={open ? 0 : -1}
                className="w-full h-11 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all duration-200 disabled:opacity-60 hover:brightness-105 hover:-translate-y-0.5 active:translate-y-0"
                style={{ background: 'linear-gradient(135deg, #E84C88 0%, #D81B60 100%)', boxShadow: '0 10px 26px -8px rgba(216,27,96,0.5)' }}
              >
                {loading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            {/* Divider */}
            <div className="flex items-center gap-3 my-6">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-slate-400 text-xs font-medium">or continue with</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            {/* Azure AD Button — existing blue brand colour (handler unchanged) */}
            <button
              type="button"
              onClick={async () => {
                setAzureLoading(true);
                try { await loginWithAzure(); }
                catch { toast.error('Failed to initiate Microsoft sign-in'); setAzureLoading(false); }
              }}
              disabled={azureLoading}
              tabIndex={open ? 0 : -1}
              className="w-full h-11 flex items-center justify-center gap-3 rounded-xl text-sm font-semibold text-white transition-all duration-200 disabled:opacity-60 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0"
              style={{ background: 'linear-gradient(135deg, #1B4F72 0%, #0E2F44 100%)', boxShadow: '0 10px 26px -10px rgba(14,47,68,0.55)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              {azureLoading ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <MicrosoftIcon />
              )}
              Sign in with Microsoft
            </button>

            {/* Footer */}
            <p className="text-center text-xs text-slate-400 mt-7">CRMONCE (OPC) LTD &middot; Build Your Career</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
