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

// ── Premium animated brand visual (left panel) — CSS-only, lightweight ──
// Orbiting glowing dots, curved orbit lines, a connected node network and
// floating particles in the CRMONCE brand palette (blue / pink / green / white).
const ORBITS = [
  { r: 150, dur: 18, color: '#E84C88', size: 9, rev: false },
  { r: 110, dur: 13, color: '#4AA3DF', size: 7, rev: true },
  { r: 72, dur: 9, color: '#2ECC71', size: 6, rev: false },
];
const PARTICLES = Array.from({ length: 16 }, (_, i) => ({
  left: 6 + ((i * 37) % 88),
  top: 8 + ((i * 53) % 82),
  size: 3 + (i % 3),
  color: ['#4AA3DF', '#E84C88', '#2ECC71', '#FFFFFF'][i % 4],
  dur: 7 + (i % 5) * 1.3,
  delay: (i % 6) * 1.1,
}));
const NET_NODES = [
  { x: 58, y: 72, c: '#E84C88', r: 3.5 },
  { x: 150, y: 42, c: '#4AA3DF', r: 3 },
  { x: 252, y: 84, c: '#2ECC71', r: 3.5 },
  { x: 214, y: 168, c: '#FFFFFF', r: 2.5 },
  { x: 92, y: 186, c: '#4AA3DF', r: 3 },
  { x: 158, y: 120, c: '#E84C88', r: 3 },
];
const NET_LINES = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [1, 5], [3, 5], [4, 5]];
const BRAND_VISUAL_CSS = `
.cr-stage{position:relative;width:22rem;height:20rem;max-width:100%;margin-top:.25rem}
.cr-net{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.cr-net-g{animation:crNet 11s ease-in-out infinite;transform-origin:center}
.cr-ring{position:absolute;top:50%;left:50%;border-style:solid;border-width:1px;border-radius:50%;transform-origin:center;transform:translate(-50%,-50%)}
.cr-ring1{width:340px;height:340px;border-color:rgba(232,76,136,.22);transform:translate(-50%,-50%) scaleY(.46);animation:crTumble1 44s linear infinite}
.cr-ring2{width:248px;height:248px;border-color:rgba(74,163,223,.24);transform:translate(-50%,-50%) scaleY(.52);animation:crTumble2 34s linear infinite}
.cr-ring3{width:168px;height:168px;border-color:rgba(46,204,113,.24);transform:translate(-50%,-50%) scaleY(.6);animation:crTumble3 26s linear infinite}
.cr-core{position:absolute;top:50%;left:50%;width:92px;height:92px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.2) 0%,rgba(74,163,223,.12) 45%,transparent 70%);transform:translate(-50%,-50%);animation:crPulse 6.5s ease-in-out infinite}
.cr-orbit{position:absolute;top:50%;left:50%;width:0;height:0;animation-name:crSpin;animation-timing-function:linear;animation-iteration-count:infinite;animation-duration:14s}
.cr-node{position:absolute;left:0;top:0;border-radius:50%}
.cr-p{position:absolute;border-radius:50%;opacity:0;animation-name:crFloat;animation-timing-function:ease-in-out;animation-iteration-count:infinite}
@keyframes crSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes crTumble1{from{transform:translate(-50%,-50%) rotate(0) scaleY(.46)}to{transform:translate(-50%,-50%) rotate(360deg) scaleY(.46)}}
@keyframes crTumble2{from{transform:translate(-50%,-50%) rotate(0) scaleY(.52)}to{transform:translate(-50%,-50%) rotate(-360deg) scaleY(.52)}}
@keyframes crTumble3{from{transform:translate(-50%,-50%) rotate(0) scaleY(.6)}to{transform:translate(-50%,-50%) rotate(360deg) scaleY(.6)}}
@keyframes crPulse{0%,100%{opacity:.45;transform:translate(-50%,-50%) scale(.9)}50%{opacity:.85;transform:translate(-50%,-50%) scale(1.08)}}
@keyframes crFloat{0%{opacity:0;transform:translateY(16px) scale(.5)}15%{opacity:.85}55%{opacity:.7;transform:translateY(-16px) scale(1)}100%{opacity:0;transform:translateY(-44px) scale(.4)}}
@keyframes crNet{0%,100%{opacity:.4;transform:translateY(0)}50%{opacity:.65;transform:translateY(-6px)}}
@media (prefers-reduced-motion: reduce){.cr-stage *{animation:none!important}.cr-p{opacity:.6}.cr-core{opacity:.7}}
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
    <div className="min-h-screen flex bg-white">
      {/* ── Left Brand Panel ──────────────────────────────────── */}
      <div className="hidden lg:flex lg:w-[45%] relative overflow-hidden flex-col items-center justify-center"
        style={{ background: 'linear-gradient(160deg, #1B4F72 0%, #154360 40%, #0E2F44 100%)' }}>

        {/* Subtle background pattern */}
        <div className="absolute inset-0 opacity-[0.03]"
          style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '30px 30px' }} />

        {/* Glow effects */}
        <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full" style={{ background: 'radial-gradient(circle, rgba(232,76,136,0.15) 0%, transparent 70%)' }} />
        <div className="absolute -bottom-20 -left-20 w-64 h-64 rounded-full" style={{ background: 'radial-gradient(circle, rgba(46,139,87,0.12) 0%, transparent 70%)' }} />

        {/* Content */}
        <div className="relative z-10 flex flex-col items-center justify-center px-12 w-full max-w-lg">
          <style>{BRAND_VISUAL_CSS}</style>

          {/* Logo card (unchanged) */}
          <div className="mb-10 bg-white rounded-2xl px-6 py-4 shadow-2xl">
            <img src={logoImg} alt="CRMONCE" className="w-56 h-auto object-contain" />
          </div>

          {/* Premium animated brand visual — CSS-only */}
          <div className="cr-stage" aria-hidden="true">
            {/* connected glowing node network */}
            <svg className="cr-net" viewBox="0 0 320 320" fill="none">
              <g className="cr-net-g">
                {NET_LINES.map(([a, b], i) => (
                  <line key={i} x1={NET_NODES[a].x} y1={NET_NODES[a].y} x2={NET_NODES[b].x} y2={NET_NODES[b].y} stroke="rgba(255,255,255,0.16)" strokeWidth="1" />
                ))}
                {NET_NODES.map((n, i) => (
                  <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.c} style={{ filter: `drop-shadow(0 0 4px ${n.c})` }} />
                ))}
              </g>
            </svg>

            {/* curved orbit lines */}
            <span className="cr-ring cr-ring1" />
            <span className="cr-ring cr-ring2" />
            <span className="cr-ring cr-ring3" />

            {/* glowing core */}
            <span className="cr-core" />

            {/* orbiting glowing dots */}
            {ORBITS.map((o, i) => (
              <span key={i} className="cr-orbit" style={{ animationDuration: `${o.dur}s`, animationDirection: o.rev ? 'reverse' : 'normal' }}>
                <span className="cr-node" style={{ width: o.size, height: o.size, background: o.color, boxShadow: `0 0 10px 2px ${o.color}`, transform: `translate(-50%,-50%) translateX(${o.r}px)` }} />
              </span>
            ))}

            {/* floating particles */}
            {PARTICLES.map((p, i) => (
              <span key={i} className="cr-p" style={{ left: `${p.left}%`, top: `${p.top}%`, width: p.size, height: p.size, background: p.color, boxShadow: `0 0 6px ${p.color}`, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }} />
            ))}
          </div>
        </div>

        {/* Bottom bar */}
        <div className="absolute bottom-0 left-0 right-0 h-1" style={{ background: 'linear-gradient(90deg, #E84C88, #2E8B57, #1B4F72)' }} />
      </div>

      {/* ── Right Form Panel ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col">
        {/* Mobile header */}
        <div className="lg:hidden flex items-center justify-center gap-3 px-6 pt-8 pb-2">
          <img src={logoImg} alt="CRMONCE" className="h-9 w-auto object-contain" />
          <div>
            <div className="text-lg font-bold tracking-wide">
              <span style={{ color: '#E84C88' }}>CRM</span>
              <span className="text-gray-300 mx-0.5">|</span>
              <span className="text-gray-900">ONCE</span>
            </div>
            <div className="text-[10px] text-gray-400 tracking-widest uppercase">(OPC) Private Limited</div>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center px-6 py-12 sm:px-12">
          <div className="w-full max-w-sm">
            {/* Header */}
            <div className="mb-8">
              <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Welcome back</h1>
              <p className="text-gray-400 text-sm mt-1">Sign in to CRMONCE HR portal</p>
            </div>

            {/* Email/Password Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Email address</label>
                <input
                  type="email"
                  required
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#E84C88]/30 focus:border-[#E84C88] transition-all"
                  placeholder="you@crmonce.com"
                  value={form.email}
                  onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                  autoComplete="email"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-gray-600">Password</label>
                  <button
                    type="button"
                    className="text-xs text-[#E84C88] hover:text-[#D81B60] font-medium"
                    onClick={() => toast('Contact your administrator', { icon: 'ℹ️' })}
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  type="password"
                  required
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#E84C88]/30 focus:border-[#E84C88] transition-all"
                  placeholder="Enter your password"
                  value={form.password}
                  onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                  autoComplete="current-password"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all duration-200 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #E84C88, #D81B60)', boxShadow: '0 4px 14px rgba(232,76,136,0.3)' }}
              >
                {loading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>

            {/* Divider */}
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-white px-3 text-gray-400">or continue with</span>
              </div>
            </div>

            {/* Azure AD Button — moved to bottom (handler unchanged) */}
            <button
              type="button"
              onClick={async () => {
                setAzureLoading(true);
                try { await loginWithAzure(); }
                catch { toast.error('Failed to initiate Microsoft sign-in'); setAzureLoading(false); }
              }}
              disabled={azureLoading}
              className="w-full flex items-center justify-center gap-3 py-3 px-4 bg-[#1B4F72] rounded-xl text-sm font-semibold text-white hover:bg-[#154360] transition-all duration-200 disabled:opacity-50 shadow-lg shadow-[#1B4F72]/20"
            >
              {azureLoading ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <MicrosoftIcon />
              )}
              Sign in with Microsoft
            </button>

            {/* Footer */}
            <div className="mt-10 text-center">
              <p className="text-xs text-gray-300">
                CRMONCE (OPC) LTD &middot; Build Your Career
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
