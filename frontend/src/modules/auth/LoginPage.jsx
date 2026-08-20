import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import logoImg from '../../assets/hero.png';

const MicrosoftIcon = () => (
  <svg width="20" height="20" viewBox="0 0 21 21" fill="none">
    <rect x="1" y="1" width="9" height="9" fill="#F25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
    <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
    <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
  </svg>
);

// Small inline icons (no external deps) — pure presentation.
const MailIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
  </svg>
);
const LockIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);
const EyeIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOffIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.6 6.6A18.6 18.6 0 0 0 2 12s3.5 7 10 7a9 9 0 0 0 5.4-1.6" /><path d="m3 3 18 18" />
  </svg>
);
const UserIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
  </svg>
);
const PeopleIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5.5a3.2 3.2 0 0 1 0 5.6M15.5 20a6 6 0 0 1 6-4.2" />
  </svg>
);
const ArrowIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export default function LoginPage() {
  const { login, loginWithAzure } = useAuth();
  const [azureLoading, setAzureLoading] = useState(false);
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);   // UI-only reveal toggle

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
    <div className="ll-root min-h-screen flex items-stretch relative overflow-hidden">
      {/* Scoped styles + the thread/reveal animation. Everything degrades to a
          simple, instant fade when the user prefers reduced motion. The animation
          is purely decorative — inputs, buttons and submission are usable at once. */}
      <style>{`
        .ll-root { background: linear-gradient(120deg, #ffffff 0%, #f6f4ff 46%, #fbf4fb 100%); }
        /* soft pink/purple glow around the centre reveal */
        .ll-glow { position:absolute; inset:0; pointer-events:none; z-index:0;
          background:
            radial-gradient(38rem 38rem at 68% 50%, rgba(168,85,247,0.10), transparent 60%),
            radial-gradient(30rem 30rem at 60% 46%, rgba(236,72,153,0.10), transparent 60%); }
        /* the metallic thread ring */
        .ll-ring { background: radial-gradient(circle at 35% 30%, #ffffff, #e7e3ef 45%, #b9b2c8 75%, #8b8398);
          box-shadow: 0 1px 3px rgba(60,50,90,0.35), inset 0 0 4px rgba(255,255,255,0.9); }
        .ll-ring-hole { background: radial-gradient(circle at 50% 45%, #cfc9db, #7c728d); }

        @keyframes ll-thread { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
        @keyframes ll-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ll-rise { from { opacity: 0; transform: translateY(15px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes ll-ring-in { 0% { opacity: 0; transform: translate(-50%,-50%) scale(0.4); } 60% { opacity: 1; transform: translate(-50%,-50%) scale(1.12); } 100% { opacity: 1; transform: translate(-50%,-50%) scale(1); } }
        @keyframes ll-reveal { from { opacity: 0; transform: translate(-50%,-50%) scale(0.6); } to { opacity: 1; transform: translate(-50%,-50%) scale(1); } }

        .ll-line   { stroke-dasharray: 1; stroke-dashoffset: 1; animation: ll-thread .7s cubic-bezier(.4,0,.2,1) .15s forwards; }
        .ll-seam   { stroke-dasharray: 1; stroke-dashoffset: 1; animation: ll-thread .55s cubic-bezier(.4,0,.2,1) .55s forwards; }
        .ll-ringw  { opacity: 0; animation: ll-ring-in .55s cubic-bezier(.34,1.4,.5,1) .55s forwards; }
        .ll-reveal-g { opacity: 0; animation: ll-reveal .8s cubic-bezier(.22,1,.36,1) .5s forwards; }
        .ll-fade   { opacity: 0; animation: ll-fade .6s ease-out both; }
        .ll-rise   { opacity: 0; animation: ll-rise .6s cubic-bezier(.22,1,.36,1) both; }

        @media (prefers-reduced-motion: reduce) {
          .ll-line, .ll-seam { stroke-dashoffset: 0; animation: none; }
          .ll-ringw, .ll-reveal-g, .ll-fade, .ll-rise { opacity: 1; transform: none; animation: ll-fade .3s ease-out both; }
          .ll-ringw { transform: translate(-50%,-50%); }
        }
      `}</style>

      {/* Soft centre glow */}
      <div className="ll-glow" />

      {/* ── The horizontal thread + metallic ring (decorative reveal) ───────── */}
      <svg className="absolute inset-0 w-full h-full z-[1] pointer-events-none" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="ll-thread-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#E84C88" stopOpacity="0" />
            <stop offset="18%" stopColor="#E84C88" />
            <stop offset="100%" stopColor="#A855F7" />
          </linearGradient>
        </defs>
        {/* thread pulls in from the left toward the ring near the centre */}
        <line className="ll-line" x1="0" y1="50%" x2="58%" y2="50%" pathLength="1"
          stroke="url(#ll-thread-grad)" strokeWidth="1.6" strokeLinecap="round" />
        {/* a short dashed "stitch" continues past the ring — the fabric seam */}
        <line className="ll-seam" x1="58%" y1="50%" x2="70%" y2="50%" pathLength="1"
          stroke="#E84C88" strokeWidth="1.2" strokeOpacity="0.5" strokeDasharray="1" strokeLinecap="round"
          style={{ strokeDasharray: '4 5' }} />
      </svg>

      {/* metallic ring where the thread meets the reveal */}
      <div className="ll-ringw absolute z-[2] hidden md:flex items-center justify-center rounded-full"
        style={{ left: '58%', top: '50%', width: 22, height: 22 }}>
        <div className="ll-ring w-full h-full rounded-full flex items-center justify-center">
          <div className="ll-ring-hole rounded-full" style={{ width: 8, height: 8 }} />
        </div>
      </div>

      {/* ── LEFT: branding + thread visual ─────────────────────────────────── */}
      <div className="hidden lg:flex lg:w-1/2 relative z-[2] flex-col items-center justify-center px-16">
        <div className="ll-fade flex flex-col items-center text-center max-w-md" style={{ animationDelay: '.3s' }}>
          {/* Keep the existing logo mark */}
          <img src={logoImg} alt="CRMONCE" className="w-16 h-16 object-contain mb-5 drop-shadow" />

          {/* CRM | ONCE wordmark */}
          <h1 className="text-5xl font-extrabold tracking-tight">
            <span style={{ color: '#E84C88' }}>CRM</span>
            <span className="text-gray-300 mx-1 font-light">|</span>
            <span className="text-[#1B2A4A]">ONCE</span>
          </h1>

          {/* HR SYSTEM with side rules */}
          <div className="flex items-center gap-3 mt-3 text-gray-400">
            <span className="h-px w-8 bg-gray-300" />
            <span className="text-sm font-semibold tracking-[0.35em]">HR SYSTEM</span>
            <span className="h-px w-8 bg-gray-300" />
          </div>

          {/* Tagline */}
          <PeopleIcon className="w-6 h-6 text-gray-400 mt-8 mb-2" />
          <p className="text-gray-500 text-sm">Empowering People. Simplifying HR.</p>
        </div>
      </div>

      {/* ── RIGHT: login card ──────────────────────────────────────────────── */}
      <div className="flex-1 lg:w-1/2 relative z-[3] flex flex-col items-center justify-center px-5 py-10 sm:px-8">
        {/* Mobile brand header (keeps branding on small screens) */}
        <div className="ll-fade lg:hidden flex items-center gap-2.5 mb-6" style={{ animationDelay: '.15s' }}>
          <img src={logoImg} alt="CRMONCE" className="w-10 h-10 object-contain" />
          <div className="leading-none">
            <div className="text-lg font-extrabold tracking-tight">
              <span style={{ color: '#E84C88' }}>CRM</span><span className="text-gray-300 mx-0.5 font-light">|</span><span className="text-[#1B2A4A]">ONCE</span>
            </div>
            <div className="text-[10px] text-gray-400 tracking-[0.3em] uppercase mt-1">HR System</div>
          </div>
        </div>

        {/* The reveal glow directly behind the card */}
        <div className="ll-reveal-g absolute z-0 rounded-[2.5rem] pointer-events-none"
          style={{ left: '50%', top: '50%', width: '30rem', height: '34rem', maxWidth: '92vw',
            background: 'radial-gradient(circle at 50% 40%, rgba(236,72,153,0.10), rgba(168,85,247,0.08) 45%, transparent 72%)' }} />

        <div className="ll-rise relative z-10 w-full max-w-md bg-white/90 backdrop-blur-sm border border-gray-100 rounded-3xl shadow-[0_20px_60px_-25px_rgba(80,40,120,0.30)] px-7 py-9 sm:px-9"
          style={{ animationDelay: '.6s' }}>
          {/* Avatar mark */}
          <div className="ll-fade flex justify-center mb-4" style={{ animationDelay: '.85s' }}>
            <div className="w-14 h-14 rounded-full grid place-items-center ring-1 ring-pink-100"
              style={{ background: 'linear-gradient(135deg, #fdf2f8, #f5f3ff)' }}>
              <UserIcon className="w-7 h-7 text-[#E84C88]" />
            </div>
          </div>

          {/* Heading */}
          <div className="ll-fade text-center mb-7" style={{ animationDelay: '.95s' }}>
            <h2 className="text-2xl font-bold text-[#1B2A4A] tracking-tight">Welcome Back</h2>
            <p className="text-gray-400 text-sm mt-1">Sign in to your account</p>
          </div>

          {/* Email / Password form (handlers unchanged) */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="ll-fade" style={{ animationDelay: '1.02s' }}>
              <label className="sr-only" htmlFor="ll-email">Email address</label>
              <div className="relative">
                <MailIcon className="w-5 h-5 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="ll-email"
                  type="email"
                  required
                  className="w-full pl-11 pr-4 py-3 bg-gray-50/70 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#E84C88]/25 focus:border-[#E84C88] transition-all"
                  placeholder="Email address"
                  value={form.email}
                  onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                  autoComplete="email"
                />
              </div>
            </div>

            <div className="ll-fade" style={{ animationDelay: '1.1s' }}>
              <label className="sr-only" htmlFor="ll-password">Password</label>
              <div className="relative">
                <LockIcon className="w-5 h-5 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="ll-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  className="w-full pl-11 pr-11 py-3 bg-gray-50/70 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#E84C88]/25 focus:border-[#E84C88] transition-all"
                  placeholder="Password"
                  value={form.password}
                  onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  {showPassword ? <EyeOffIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <div className="ll-fade flex justify-end" style={{ animationDelay: '1.18s' }}>
              <button
                type="button"
                className="text-xs font-medium text-[#E84C88] hover:text-[#D81B60]"
                onClick={() => toast('Contact your administrator', { icon: 'ℹ️' })}
              >
                Forgot password?
              </button>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="ll-fade group w-full py-3 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all duration-200 hover:brightness-[1.05] hover:shadow-lg disabled:opacity-60"
              style={{ animationDelay: '1.24s', background: 'linear-gradient(135deg, #EC4899 0%, #A855F7 100%)', boxShadow: '0 8px 22px -8px rgba(168,85,247,0.55)' }}
            >
              {loading && <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
              {loading ? 'Signing in…' : 'Sign in'}
              {!loading && <ArrowIcon className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />}
            </button>
          </form>

          {/* Divider */}
          <div className="ll-fade relative my-5" style={{ animationDelay: '1.3s' }}>
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-200" /></div>
            <div className="relative flex justify-center text-xs"><span className="bg-white px-3 text-gray-400">or continue with</span></div>
          </div>

          {/* Microsoft — handler unchanged */}
          <button
            type="button"
            onClick={async () => {
              setAzureLoading(true);
              try { await loginWithAzure(); }
              catch { toast.error('Failed to initiate Microsoft sign-in'); setAzureLoading(false); }
            }}
            disabled={azureLoading}
            className="ll-fade w-full flex items-center justify-center gap-3 py-3 px-4 bg-white border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-all duration-200 disabled:opacity-50"
            style={{ animationDelay: '1.36s' }}
          >
            {azureLoading ? (
              <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
            ) : (
              <MicrosoftIcon />
            )}
            Sign in with Microsoft
          </button>
        </div>

        {/* Footer */}
        <p className="ll-fade relative z-10 mt-8 text-center text-[11px] tracking-wide text-gray-400 uppercase" style={{ animationDelay: '1.45s' }}>
          CRMONCE (OPC) Private Limited
        </p>
      </div>
    </div>
  );
}
