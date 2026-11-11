import { useState } from 'react';
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
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m4 7 8 6 8-6" />
  </svg>
);
const LockIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
  </svg>
);

// ── Premium animated brand visual (left panel) — CSS-only, lightweight ──
// Layered orbiting dots, curved orbit lines, a connected node network, ambient
// light blobs and floating particles in the CRMONCE palette (navy / blue / pink /
// green / white). Every animated element carries a base transform so it stays
// correctly positioned when prefers-reduced-motion disables the animations.
const ORBITS = [
  { r: 185, dur: 22, color: '#E84C88', size: 12, rev: false },
  { r: 140, dur: 16, color: '#5FB0E8', size: 10, rev: true },
  { r: 95, dur: 11, color: '#2ECC71', size: 8, rev: false },
];
const PARTICLES = Array.from({ length: 22 }, (_, i) => ({
  left: 4 + ((i * 41) % 92),
  top: 5 + ((i * 47) % 90),
  size: 3 + (i % 4),
  color: ['#5FB0E8', '#E84C88', '#2ECC71', '#FFFFFF'][i % 4],
  dur: 7 + (i % 6) * 1.2,
  delay: (i % 7) * 0.9,
}));
const NET_NODES = [
  { x: 60, y: 80, c: '#E84C88', r: 4 },
  { x: 170, y: 46, c: '#5FB0E8', r: 3.5 },
  { x: 290, y: 92, c: '#2ECC71', r: 4 },
  { x: 250, y: 200, c: '#FFFFFF', r: 3 },
  { x: 110, y: 220, c: '#5FB0E8', r: 3.5 },
  { x: 180, y: 140, c: '#E84C88', r: 3.5 },
  { x: 40, y: 160, c: '#2ECC71', r: 3 },
  { x: 320, y: 150, c: '#5FB0E8', r: 3 },
];
const NET_LINES = [[0, 1], [1, 2], [2, 7], [7, 3], [3, 4], [4, 6], [6, 0], [0, 5], [1, 5], [5, 3], [5, 4], [2, 3]];
const BLOBS = [
  { bg: 'rgba(232,76,136,0.42)', size: 300, left: '50%', top: '0%', dur: 13, delay: 0 },
  { bg: 'rgba(74,163,223,0.40)', size: 360, left: '4%', top: '28%', dur: 16, delay: 1.6 },
  { bg: 'rgba(46,204,113,0.30)', size: 260, left: '42%', top: '58%', dur: 14, delay: 0.8 },
];
const BRAND_VISUAL_CSS = `
.cr-stage{position:relative;width:26rem;height:26rem;max-width:100%;margin-top:.25rem}
.cr-blob{position:absolute;border-radius:50%;filter:blur(44px);opacity:.55;transform:translate(0,0);animation-name:crBlob;animation-timing-function:ease-in-out;animation-iteration-count:infinite}
.cr-net{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.cr-net-g{animation:crNet 12s ease-in-out infinite;transform-origin:center}
.cr-ring{position:absolute;top:50%;left:50%;border-style:solid;border-width:1px;border-radius:50%;transform-origin:center;transform:translate(-50%,-50%)}
.cr-ring1{width:400px;height:400px;border-color:rgba(232,76,136,.30);transform:translate(-50%,-50%) scaleY(.5);animation:crT1 46s linear infinite}
.cr-ring2{width:300px;height:300px;border-color:rgba(95,176,232,.34);transform:translate(-50%,-50%) scaleY(.5);animation:crT2 36s linear infinite}
.cr-ring3{width:210px;height:210px;border-color:rgba(46,204,113,.30);transform:translate(-50%,-50%) scaleY(.56);animation:crT3 28s linear infinite}
.cr-ring4{width:128px;height:128px;border-color:rgba(255,255,255,.26);transform:translate(-50%,-50%) scaleY(.62);animation:crT4 22s linear infinite}
.cr-core{position:absolute;top:50%;left:50%;width:120px;height:120px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.28) 0%,rgba(95,176,232,.16) 45%,transparent 70%);transform:translate(-50%,-50%);animation:crPulse 6.5s ease-in-out infinite}
.cr-orbit{position:absolute;top:50%;left:50%;width:0;height:0;animation-name:crSpin;animation-timing-function:linear;animation-iteration-count:infinite;animation-duration:16s}
.cr-node{position:absolute;left:0;top:0;border-radius:50%}
.cr-p{position:absolute;border-radius:50%;opacity:0;animation-name:crFloat;animation-timing-function:ease-in-out;animation-iteration-count:infinite}
@keyframes crSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes crT1{from{transform:translate(-50%,-50%) rotate(0) scaleY(.5)}to{transform:translate(-50%,-50%) rotate(360deg) scaleY(.5)}}
@keyframes crT2{from{transform:translate(-50%,-50%) rotate(0) scaleY(.5)}to{transform:translate(-50%,-50%) rotate(-360deg) scaleY(.5)}}
@keyframes crT3{from{transform:translate(-50%,-50%) rotate(0) scaleY(.56)}to{transform:translate(-50%,-50%) rotate(360deg) scaleY(.56)}}
@keyframes crT4{from{transform:translate(-50%,-50%) rotate(0) scaleY(.62)}to{transform:translate(-50%,-50%) rotate(-360deg) scaleY(.62)}}
@keyframes crPulse{0%,100%{opacity:.5;transform:translate(-50%,-50%) scale(.92)}50%{opacity:.95;transform:translate(-50%,-50%) scale(1.1)}}
@keyframes crFloat{0%{opacity:0;transform:translateY(20px) scale(.5)}15%{opacity:.9}55%{opacity:.75;transform:translateY(-18px) scale(1)}100%{opacity:0;transform:translateY(-52px) scale(.4)}}
@keyframes crNet{0%,100%{opacity:.5;transform:translateY(0)}50%{opacity:.8;transform:translateY(-8px)}}
@keyframes crBlob{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(0,-14px) scale(1.08)}}
@media (prefers-reduced-motion: reduce){.cr-stage *{animation:none!important}.cr-p{opacity:.7}.cr-core{opacity:.85}.cr-blob{opacity:.5}}
`;

export default function LoginPage() {
  const { login, loginWithAzure } = useAuth();
  const [azureLoading, setAzureLoading] = useState(false);
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="min-h-screen flex bg-[#0A2236]">
      {/* ── Left Brand Panel ──────────────────────────────────── */}
      <div className="hidden lg:flex lg:w-[48%] xl:w-[45%] relative overflow-hidden flex-col items-center justify-center"
        style={{ background: 'linear-gradient(150deg, #0C2740 0%, #143A5E 46%, #0A2236 100%)' }}>

        {/* Layered depth: soft dot grid + ambient corner glows */}
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '34px 34px' }} />
        <div className="absolute -top-28 -right-24 w-96 h-96 rounded-full" style={{ background: 'radial-gradient(circle, rgba(232,76,136,0.20) 0%, transparent 70%)' }} />
        <div className="absolute top-1/3 -left-28 w-96 h-96 rounded-full" style={{ background: 'radial-gradient(circle, rgba(74,163,223,0.18) 0%, transparent 70%)' }} />
        <div className="absolute -bottom-28 left-1/4 w-80 h-80 rounded-full" style={{ background: 'radial-gradient(circle, rgba(46,139,87,0.16) 0%, transparent 70%)' }} />
        {/* top sheen */}
        <div className="absolute inset-x-0 top-0 h-40" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.06), transparent)' }} />

        {/* Content */}
        <div className="relative z-10 flex flex-col items-center justify-center px-12 w-full max-w-xl">
          <style>{BRAND_VISUAL_CSS}</style>

          {/* Logo card (unchanged) */}
          <div className="mb-10 bg-white rounded-2xl px-6 py-4 shadow-2xl">
            <img src={logoImg} alt="CRMONCE" className="w-56 h-auto object-contain" />
          </div>

          {/* Premium animated brand visual — CSS-only */}
          <div className="cr-stage" aria-hidden="true">
            {/* ambient light blobs */}
            {BLOBS.map((b, i) => (
              <span key={`b${i}`} className="cr-blob" style={{ left: b.left, top: b.top, width: b.size, height: b.size, background: `radial-gradient(circle, ${b.bg} 0%, transparent 70%)`, animationDuration: `${b.dur}s`, animationDelay: `${b.delay}s` }} />
            ))}

            {/* connected glowing node network */}
            <svg className="cr-net" viewBox="0 0 360 300" fill="none">
              <g className="cr-net-g">
                {NET_LINES.map(([a, b], i) => (
                  <line key={i} x1={NET_NODES[a].x} y1={NET_NODES[a].y} x2={NET_NODES[b].x} y2={NET_NODES[b].y} stroke="rgba(255,255,255,0.20)" strokeWidth="1" />
                ))}
                {NET_NODES.map((n, i) => (
                  <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.c} style={{ filter: `drop-shadow(0 0 5px ${n.c})` }} />
                ))}
              </g>
            </svg>

            {/* curved orbit lines */}
            <span className="cr-ring cr-ring1" />
            <span className="cr-ring cr-ring2" />
            <span className="cr-ring cr-ring3" />
            <span className="cr-ring cr-ring4" />

            {/* glowing core */}
            <span className="cr-core" />

            {/* orbiting glowing dots */}
            {ORBITS.map((o, i) => (
              <span key={i} className="cr-orbit" style={{ animationDuration: `${o.dur}s`, animationDirection: o.rev ? 'reverse' : 'normal' }}>
                <span className="cr-node" style={{ width: o.size, height: o.size, background: o.color, boxShadow: `0 0 14px 3px ${o.color}`, transform: `translate(-50%,-50%) translateX(${o.r}px)` }} />
              </span>
            ))}

            {/* floating particles */}
            {PARTICLES.map((p, i) => (
              <span key={i} className="cr-p" style={{ left: `${p.left}%`, top: `${p.top}%`, width: p.size, height: p.size, background: p.color, boxShadow: `0 0 7px ${p.color}`, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }} />
            ))}
          </div>

          {/* Enterprise caption */}
          <div className="relative z-10 mt-10 text-center">
            <p className="text-white/70 text-sm font-medium tracking-wide">Enterprise HR, unified.</p>
            <p className="text-white/35 text-xs mt-1">Payroll · Attendance · Performance · People</p>
          </div>
        </div>

        {/* Bottom accent bar */}
        <div className="absolute bottom-0 left-0 right-0 h-1" style={{ background: 'linear-gradient(90deg, #E84C88, #2E8B57, #1B4F72)' }} />
      </div>

      {/* ── Right Form Panel ─────────────────────────────────── */}
      <div className="flex-1 relative flex flex-col overflow-hidden"
        style={{ background: 'linear-gradient(135deg, #F6FAFF 0%, #EDF3FB 55%, #E6EFFA 100%)' }}>
        {/* faint decorative glows for depth (no plain white) */}
        <div className="pointer-events-none absolute -top-24 -right-24 w-72 h-72 rounded-full" style={{ background: 'radial-gradient(circle, rgba(232,76,136,0.10), transparent 70%)' }} />
        <div className="pointer-events-none absolute -bottom-28 -left-24 w-96 h-96 rounded-full" style={{ background: 'radial-gradient(circle, rgba(27,79,114,0.10), transparent 70%)' }} />

        {/* Mobile brand header */}
        <div className="lg:hidden flex items-center justify-center gap-3 px-6 pt-9 pb-1 relative z-10">
          <img src={logoImg} alt="CRMONCE" className="h-9 w-auto object-contain" />
          <div>
            <div className="text-lg font-bold tracking-wide leading-none">
              <span style={{ color: '#E84C88' }}>CRM</span>
              <span className="text-slate-300 mx-0.5">|</span>
              <span className="text-slate-900">ONCE</span>
            </div>
            <div className="text-[10px] text-slate-400 tracking-widest uppercase mt-0.5">(OPC) Private Limited</div>
          </div>
        </div>

        {/* Centered premium card */}
        <div className="flex-1 flex items-center justify-center px-5 py-10 sm:px-8 relative z-10">
          <div className="w-full max-w-md">
            <div className="bg-white/90 backdrop-blur-xl rounded-3xl border border-slate-200/70 p-7 sm:p-9"
              style={{ boxShadow: '0 24px 70px -20px rgba(16,42,67,0.28), 0 6px 18px -8px rgba(16,42,67,0.12)' }}>

              {/* Header */}
              <div className="mb-7">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#E84C88]/10 text-[#D81B60] text-[11px] font-semibold tracking-wide mb-4">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#E84C88]" /> CRMONCE HR PORTAL
                </span>
                <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Welcome back</h1>
                <p className="text-slate-500 text-sm mt-1.5">Sign in to continue to your HR workspace.</p>
              </div>

              {/* Email/Password Form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5">Email address</label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"><MailIcon /></span>
                    <input
                      type="email"
                      required
                      className="w-full h-11 pl-11 pr-4 bg-slate-50/80 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#E84C88]/25 focus:border-[#E84C88] hover:border-slate-300 transition-all"
                      placeholder="you@crmonce.com"
                      value={form.email}
                      onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                      autoComplete="email"
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
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"><LockIcon /></span>
                    <input
                      type="password"
                      required
                      className="w-full h-11 pl-11 pr-4 bg-slate-50/80 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#E84C88]/25 focus:border-[#E84C88] hover:border-slate-300 transition-all"
                      placeholder="Enter your password"
                      value={form.password}
                      onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                      autoComplete="current-password"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all duration-200 disabled:opacity-60 hover:brightness-105 hover:-translate-y-0.5 active:translate-y-0"
                  style={{ background: 'linear-gradient(135deg, #E84C88 0%, #D81B60 100%)', boxShadow: '0 10px 24px -8px rgba(216,27,96,0.55)' }}
                >
                  {loading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>

              {/* Divider */}
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-200" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-white px-3 text-slate-400 font-medium">or continue with</span>
                </div>
              </div>

              {/* Azure AD Button — bottom (handler unchanged) */}
              <button
                type="button"
                onClick={async () => {
                  setAzureLoading(true);
                  try { await loginWithAzure(); }
                  catch { toast.error('Failed to initiate Microsoft sign-in'); setAzureLoading(false); }
                }}
                disabled={azureLoading}
                className="w-full h-11 flex items-center justify-center gap-3 rounded-xl text-sm font-semibold text-white transition-all duration-200 disabled:opacity-60 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0"
                style={{ background: 'linear-gradient(135deg, #1B4F72 0%, #0E2F44 100%)', boxShadow: '0 10px 24px -10px rgba(14,47,68,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                {azureLoading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <MicrosoftIcon />
                )}
                Sign in with Microsoft
              </button>
            </div>

            {/* Footer */}
            <p className="text-center text-xs text-slate-400 mt-6">
              CRMONCE (OPC) LTD &middot; Build Your Career
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
