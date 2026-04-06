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
      navigate('/', { replace: true });
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
        <div className="relative z-10 flex flex-col items-center text-center px-12 max-w-lg">
          {/* Logo */}
          <div className="mb-8 w-48 h-48 flex items-center justify-center">
            <img src={logoImg} alt="CRMONCE" className="w-full h-full object-contain drop-shadow-2xl" />
          </div>

          {/* Company Name */}
          <h1 className="text-4xl font-bold tracking-wide mb-1">
            <span style={{ color: '#E84C88' }}>CRM</span>
            <span className="text-white/40 mx-0.5">|</span>
            <span className="text-white">ONCE</span>
          </h1>
          <p className="text-white/40 text-sm font-medium tracking-[0.2em] uppercase mb-6">(OPC) Private Limited</p>

          {/* Divider */}
          <div className="w-16 h-0.5 rounded-full mb-6" style={{ background: 'linear-gradient(90deg, #E84C88, #2E8B57)' }} />

          {/* Tagline */}
          <p className="text-xl font-light text-white/80 tracking-wide mb-3">
            Build Your Career
          </p>
          <p className="text-white/35 text-sm leading-relaxed max-w-sm">
            Unified HR platform for payroll, attendance, recruitment & performance management
          </p>

          {/* Bottom stats */}
          <div className="mt-12 flex gap-8">
            <div className="text-center">
              <div className="text-2xl font-bold text-white/90">500+</div>
              <div className="text-xs text-white/30 uppercase tracking-wider">Employees</div>
            </div>
            <div className="w-px bg-white/10" />
            <div className="text-center">
              <div className="text-2xl font-bold text-white/90">98%</div>
              <div className="text-xs text-white/30 uppercase tracking-wider">Uptime</div>
            </div>
            <div className="w-px bg-white/10" />
            <div className="text-center">
              <div className="text-2xl font-bold text-white/90">24/7</div>
              <div className="text-xs text-white/30 uppercase tracking-wider">Support</div>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="absolute bottom-0 left-0 right-0 h-1" style={{ background: 'linear-gradient(90deg, #E84C88, #2E8B57, #1B4F72)' }} />
      </div>

      {/* ── Right Form Panel ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col">
        {/* Mobile header */}
        <div className="lg:hidden flex items-center justify-center gap-3 px-6 pt-8 pb-2">
          <img src={logoImg} alt="CRMONCE" className="w-12 h-12 object-contain" />
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

            {/* Azure AD Button — Primary */}
            <button
              type="button"
              onClick={async () => {
                setAzureLoading(true);
                try { await loginWithAzure(); }
                catch { toast.error('Failed to initiate Microsoft sign-in'); setAzureLoading(false); }
              }}
              disabled={azureLoading}
              className="w-full flex items-center justify-center gap-3 py-3 px-4 bg-[#1B4F72] rounded-xl text-sm font-semibold text-white hover:bg-[#154360] transition-all duration-200 disabled:opacity-50 shadow-lg shadow-[#1B4F72]/20 mb-6"
            >
              {azureLoading ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <MicrosoftIcon />
              )}
              Sign in with Microsoft
            </button>

            {/* Divider */}
            <div className="relative mb-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-white px-3 text-gray-400">or sign in with email</span>
              </div>
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
