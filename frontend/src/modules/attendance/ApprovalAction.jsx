import { useEffect, useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { leaveApi } from '../../api/endpoints';

/**
 * Landing page for the email "Approve / Reject" buttons.
 * Flow: email link → this page → REQUIRES login → calls the secure
 * email-action endpoint (backend validates JWT + role + signed token + status).
 * The frontend never updates D365 directly.
 */
export default function ApprovalAction() {
  const [params] = useSearchParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'working', message: 'Processing your decision…' });
  const ran = useRef(false);

  const type = params.get('type');
  const id = params.get('id');
  const action = params.get('action');
  const token = params.get('t');

  useEffect(() => {
    if (loading) return;

    // Require login — stash this exact link and send the user to sign in.
    if (!user) {
      sessionStorage.setItem('postLoginRedirect', window.location.pathname + window.location.search);
      navigate('/login', { replace: true });
      return;
    }

    if (ran.current) return;
    ran.current = true;

    if (!type || !id || !action || !token) {
      setState({ status: 'error', message: 'This approval link is incomplete or invalid.' });
      return;
    }
    if (type !== 'leave') {
      setState({ status: 'error', message: 'Unsupported request type.' });
      return;
    }

    leaveApi.emailAction(id, action, token)
      .then(() => setState({
        status: 'success',
        message: `Request ${action === 'approved' ? 'approved' : 'rejected'} successfully.`,
      }))
      .catch((err) => setState({
        status: 'error',
        message: err.response?.data?.error || 'Could not process this request.',
      }));
  }, [loading, user, type, id, action, token, navigate]);

  const isApprove = action === 'approved';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
        {state.status === 'working' && (
          <>
            <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm text-gray-500 font-medium">{state.message}</p>
          </>
        )}

        {state.status === 'success' && (
          <>
            <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${isApprove ? 'bg-emerald-100' : 'bg-rose-100'}`}>
              <svg className={`w-8 h-8 ${isApprove ? 'text-emerald-600' : 'text-rose-600'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                {isApprove
                  ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  : <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />}
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">{isApprove ? 'Approved' : 'Rejected'}</h2>
            <p className="text-sm text-gray-500 mb-6">{state.message}</p>
            <button onClick={() => navigate('/leave', { replace: true })} className="btn-primary w-full py-2.5">
              Go to Leave Management
            </button>
          </>
        )}

        {state.status === 'error' && (
          <>
            <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">Unable to Process</h2>
            <p className="text-sm text-gray-500 mb-6">{state.message}</p>
            <button onClick={() => navigate('/leave', { replace: true })} className="btn-primary w-full py-2.5">
              Go to Leave Management
            </button>
          </>
        )}
      </div>
    </div>
  );
}
