import { useState, useEffect, useRef } from 'react';
import { BellIcon, BellSlashIcon } from '@heroicons/react/24/outline';
import { BellAlertIcon } from '@heroicons/react/24/solid';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import { formatDistanceToNow } from 'date-fns';

const ICONS = {
  'leave:updated': (
    <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
      <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    </div>
  ),
  'payroll:processed': (
    <div className="w-8 h-8 rounded-xl bg-emerald-50 flex items-center justify-center flex-shrink-0">
      <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </div>
  ),
  'recruitment:new_applicant': (
    <div className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center flex-shrink-0">
      <svg className="w-4 h-4 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
      </svg>
    </div>
  ),
  'attendance:anomaly': (
    <div className="w-8 h-8 rounded-xl bg-amber-50 flex items-center justify-center flex-shrink-0">
      <svg className="w-4 h-4 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
    </div>
  ),
};

const DEFAULT_ICON = (
  <div className="w-8 h-8 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
    <BellIcon className="w-4 h-4 text-gray-400" />
  </div>
);

export default function NotificationBell() {
  const { user } = useAuth();
  const [notifs, setNotifs] = useState([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const ref = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    if (!user) return;
    const socket = io(import.meta.env.VITE_API_URL?.replace('/api', '') || 'http://localhost:5000');
    socketRef.current = socket;
    socket.emit('register', user.id);

    const events = ['leave:updated', 'payroll:processed', 'recruitment:new_applicant', 'attendance:anomaly'];
    events.forEach(evt => {
      socket.on(evt, (payload) => {
        const notif = { id: Date.now(), event: evt, payload, time: new Date(), read: false };
        setNotifs(prev => [notif, ...prev].slice(0, 20));
        setUnread(n => n + 1);
      });
    });
    return () => socket.disconnect();
  }, [user]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const markAllRead = () => { setNotifs(n => n.map(x => ({ ...x, read: true }))); setUnread(0); };

  const getLabel = (evt, payload) => {
    if (evt === 'leave:updated') return `Leave request ${payload.status}`;
    if (evt === 'payroll:processed') return `Payroll processed for ${payload.month}`;
    if (evt === 'recruitment:new_applicant') return `New applicant for ${payload.jobTitle}`;
    if (evt === 'attendance:anomaly') return `Attendance issue on ${payload.date}: ${payload.issue}`;
    return evt;
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => { setOpen(o => !o); if (unread > 0) markAllRead(); }}
        className="relative p-2.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-xl transition-all duration-200 group">
        <BellIcon className="w-5 h-5 group-hover:scale-105 transition-transform" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[20px] h-5 px-1 bg-red-500 rounded-full text-white text-xs flex items-center justify-center font-bold ring-2 ring-white animate-pulse">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 w-96 bg-white rounded-2xl shadow-2xl border border-gray-200/60 z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
              {notifs.length > 0 && (
                <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-gray-100 text-xs font-semibold text-gray-500">
                  {notifs.length}
                </span>
              )}
            </div>
            {notifs.length > 0 && (
              <button onClick={markAllRead} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
                Mark all read
              </button>
            )}
          </div>

          {/* Notification List */}
          <div className="max-h-96 overflow-y-auto">
            {notifs.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <div className="w-12 h-12 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                  <BellSlashIcon className="w-6 h-6 text-gray-300" />
                </div>
                <p className="text-sm font-medium text-gray-400">No notifications</p>
                <p className="text-xs text-gray-300 mt-1">You're all caught up</p>
              </div>
            ) : (
              notifs.map(n => (
                <div key={n.id}
                  className={`flex items-start gap-3 px-5 py-3.5 border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors ${
                    n.read ? 'bg-white' : 'bg-indigo-50/30'
                  }`}>
                  {ICONS[n.event] || DEFAULT_ICON}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm leading-snug ${n.read ? 'text-gray-600' : 'text-gray-900 font-medium'}`}>
                      {getLabel(n.event, n.payload)}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">{formatDistanceToNow(n.time, { addSuffix: true })}</p>
                  </div>
                  {!n.read && <div className="w-2 h-2 bg-indigo-500 rounded-full flex-shrink-0 mt-2" />}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
