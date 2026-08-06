import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeeApi, documentApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import {
  UserIcon, IdentificationIcon, MapPinIcon, BuildingLibraryIcon, PhoneIcon, DocumentTextIcon,
  CheckBadgeIcon, ClockIcon, PencilIcon, ArrowUpTrayIcon, CameraIcon,
  CheckCircleIcon, XCircleIcon, ExclamationTriangleIcon, LockClosedIcon,
} from '@heroicons/react/24/outline';
import { BLOOD_GROUPS, upper, panRule, aadhaarRule, ifscRule, accountRule, uanRule, phoneRule } from '../../utils/validators';
import { fmtVal, fmtDate, titleCase } from '../../utils/format';
import StatusBadge from '../../components/StatusBadge';
import DocumentsManager from '../../components/DocumentsManager';
import LeaveBalance from '../attendance/LeaveBalance';

const GENDERS = ['Male', 'Female'];
const MARITAL = ['Single', 'Married'];
const DOC_TYPES = ['Aadhaar Card', 'PAN Card', 'Passport', 'Driving Licence', 'Cancelled Cheque', 'Passbook', 'Photo'];

const FORM_TABS = [
  { key: 'general', label: 'General', icon: UserIcon, fields: [
    { name: 'hr_phone', label: 'Mobile Number', rules: phoneRule },
    { name: 'hr_altphone', label: 'Alternate Mobile', rules: phoneRule },
    { name: 'hr_personalemail', label: 'Personal Email', type: 'email' },
    { name: 'hr_dob', label: 'Date of Birth', type: 'date' },
    { name: 'hr_gender', label: 'Gender', type: 'select', options: GENDERS },
    { name: 'hr_maritalstatus', label: 'Marital Status', type: 'select', options: MARITAL },
    { name: 'hr_nationality', label: 'Nationality' },
    { name: 'hr_bloodgroup', label: 'Blood Group', type: 'select', options: BLOOD_GROUPS },
  ] },
  { key: 'identity', label: 'Identity', icon: IdentificationIcon, verify: true, fields: [
    { name: 'hr_aadhaar', label: 'Aadhaar Number', rules: aadhaarRule, required: true, maxLength: 12 },
    { name: 'hr_pan', label: 'PAN Number', rules: panRule, required: true, maxLength: 10, upper: true },
    { name: 'hr_passport', label: 'Passport Number' },
    { name: 'hr_uan', label: 'UAN Number', rules: uanRule, maxLength: 12 },
    { name: 'hr_pfnumber', label: 'PF Number' },
  ] },
  { key: 'address', label: 'Address', icon: MapPinIcon, verify: true, fields: [
    { name: 'hr_address', label: 'Current Address', textarea: true },
    { name: 'hr_permaddress', label: 'Permanent Address', textarea: true },
    { name: 'hr_city', label: 'City' },
    { name: 'hr_state', label: 'State' },
    { name: 'hr_country', label: 'Country' },
    { name: 'hr_pincode', label: 'PIN Code', maxLength: 6 },
  ] },
  { key: 'bank', label: 'Bank', icon: BuildingLibraryIcon, verify: true, fields: [
    { name: 'hr_bankname', label: 'Bank Name' },
    { name: 'hr_accountholder', label: 'Account Holder Name' },
    { name: 'hr_accountnumber', label: 'Account Number', rules: accountRule, maxLength: 18 },
    { name: 'hr_ifsc', label: 'IFSC Code', rules: ifscRule, maxLength: 11, upper: true },
    { name: 'hr_branch', label: 'Branch Name' },
  ] },
  { key: 'emergency', label: 'Emergency', icon: PhoneIcon, fields: [
    { name: 'hr_emergencycontact', label: 'Contact Name' },
    { name: 'hr_emergencyrelation', label: 'Relationship' },
    { name: 'hr_emergencyphone', label: 'Mobile Number', rules: phoneRule },
  ] },
];
const TABS = [...FORM_TABS, { key: 'documents', label: 'Documents', icon: DocumentTextIcon }];
// Missing-item section label → profile tab key (so "Missing" pills jump to the tab).
const TAB_KEY = { General: 'general', Identity: 'identity', Address: 'address', Bank: 'bank', Emergency: 'emergency', Documents: 'documents' };
const EDITABLE_FIELDS = FORM_TABS.flatMap(t => t.fields.map(f => f.name));
const FIELD_TAB = Object.fromEntries(FORM_TABS.flatMap(t => t.fields.map(f => [f.name, t.key])));

const VERIFY_BADGE = {
  verified: { icon: CheckBadgeIcon, text: 'Verified', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  pending: { icon: ClockIcon, text: 'Pending HR Verification', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  changes: { icon: ExclamationTriangleIcon, text: 'Changes Requested', cls: 'bg-orange-50 text-orange-700 ring-orange-600/20' },
  rejected: { icon: XCircleIcon, text: 'Rejected', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
};

function ProgressRing({ value }) {
  const r = 26, c = 2 * Math.PI * r, off = c - (value / 100) * c;
  return (
    <svg width="64" height="64" className="-rotate-90">
      <circle cx="32" cy="32" r={r} fill="none" stroke="#e5e7eb" strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke="url(#pg)" strokeWidth="6" strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round" className="transition-all duration-700" />
      <defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#2563EB" /><stop offset="100%" stopColor="#3B82F6" /></linearGradient></defs>
    </svg>
  );
}

export default function ProfilePage() {
  const { id: paramId } = useParams();
  const { user, isHR } = useAuth();
  const qc = useQueryClient();
  const id = paramId || user?.id;
  const isSelf = user?.id === id;
  const hrView = isHR();
  const canEdit = isSelf || hrView;

  const [tab, setTab] = useState('general');
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState('');

  const { register, handleSubmit, reset, formState: { errors } } = useForm();

  const { data, isLoading } = useQuery({ queryKey: ['employee', id], queryFn: () => employeeApi.get(id), enabled: !!id });
  const emp = data?.data;
  const { data: docsData } = useQuery({ queryKey: ['documents', id], queryFn: () => documentApi.list({ employeeId: id }), enabled: !!id });
  const docs = docsData?.data?.data || [];

  // Reset the form from the server data whenever it (re)loads — but not while the
  // user is mid-edit (so a background refetch can't wipe their changes).
  useEffect(() => { if (emp && !editing) reset(emp); }, [emp, editing, reset]);

  const completion = emp?._completion || { percent: 0, missing: [] };
  const status = emp?._verifystatus || emp?.hr_verifystatus || 'verified';
  const badge = VERIFY_BADGE[status] || VERIFY_BADGE.verified;
  const managerName = fmtVal(emp?._reportingmanager || emp?.['_hr_manager_value@OData.Community.Display.V1.FormattedValue']);
  const initials = emp?.hr_hremployee1?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

  const saveMutation = useMutation({
    mutationFn: (values) => employeeApi.update(id, values),
    onSuccess: async (res) => {
      toast.success(res.data?._pendingVerification ? 'Saved — sent to HR for verification' : 'Profile updated successfully');
      setEditing(false);
      // Re-fetch so the UI reflects the persisted values immediately.
      await qc.invalidateQueries({ queryKey: ['employee', id] });
      const fresh = await qc.fetchQuery({ queryKey: ['employee', id], queryFn: () => employeeApi.get(id) });
      if (fresh?.data) reset(fresh.data);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to save'),
  });

  const verifyMutation = useMutation({
    mutationFn: ({ action, note }) => employeeApi.verify(id, { action, note }),
    onSuccess: (_r, vars) => {
      toast.success(vars.action === 'approve' ? 'Profile approved' : vars.action === 'reject' ? 'Profile rejected' : 'Changes requested');
      qc.invalidateQueries({ queryKey: ['employee', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Verification failed'),
  });

  const onValid = (values) => {
    const payload = {};
    for (const f of EDITABLE_FIELDS) if (values[f] !== undefined) payload[f] = values[f];
    saveMutation.mutate(payload);
  };
  const onInvalid = (errs) => {
    const first = Object.keys(errs)[0];
    if (first && FIELD_TAB[first]) setTab(FIELD_TAB[first]);
    toast.error('Please fix the highlighted fields');
  };
  const cancelEdit = () => { reset(emp); setEditing(false); };

  // Profile photo upload (sets hr_photourl). General documents are handled by the
  // Documents tab (DocumentsManager).
  const uploadDoc = async (docType, file) => {
    if (!file) return;
    setUploading(docType);
    try {
      const fd = new FormData();
      fd.append('file', file); fd.append('employeeId', id);
      fd.append('documentType', 'Photo'); fd.append('name', 'Photo');
      const res = await documentApi.upload(fd);
      const url = res.data?.fileUrl;
      if (url) { await employeeApi.update(id, { hr_photourl: url }); qc.invalidateQueries({ queryKey: ['employee', id] }); }
      qc.invalidateQueries({ queryKey: ['documents', id] });
      toast.success('Photo updated');
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    finally { setUploading(''); }
  };

  if (isLoading) return <div className="max-w-5xl mx-auto"><div className="bg-white rounded-2xl border border-gray-100 p-16 text-center text-gray-400">Loading profile…</div></div>;
  if (!emp) return <div className="max-w-5xl mx-auto"><div className="bg-white rounded-2xl border border-gray-100 p-16 text-center text-gray-500">Profile not found.</div></div>;

  const Field = (f) => {
    const err = errors[f.name];
    const ro = !editing;
    const base = `w-full ${f.textarea ? 'px-4 py-2.5' : 'h-11 px-4'} border rounded-xl text-sm transition-all outline-none ${err ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200'} ${ro ? 'bg-gray-50/70 text-gray-600 cursor-default' : 'bg-white text-gray-900 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400'}`;
    const reg = register(f.name, { ...(f.required ? { required: `${f.label} is required` } : {}), ...(f.rules || {}) });
    return (
      <div key={f.name} className={`space-y-1.5 ${f.textarea ? 'sm:col-span-2' : ''}`}>
        <label className="block text-sm font-semibold text-gray-700">{f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}</label>
        {f.textarea ? (
          <textarea rows={2} className={`${base} resize-none`} readOnly={ro} {...reg} />
        ) : f.type === 'select' ? (
          <select className={base} disabled={ro} {...reg}><option value="">Select</option>{f.options.map(o => <option key={o} value={o}>{o}</option>)}</select>
        ) : (
          <input type={f.type || 'text'} maxLength={f.maxLength} readOnly={ro} onInput={f.upper ? upper : undefined} className={base} {...reg} />
        )}
        {err && <p className="text-xs text-red-500 font-medium">{err.message}</p>}
      </div>
    );
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* ── Profile header — clean white card, subtle blue accent ── */}
      <div className="bg-white rounded-2xl border border-[#E5E7EB] overflow-hidden shadow-sm">
        <div className="h-1.5 bg-[#2563EB]" />
        <div className="p-5 sm:p-6">
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Identity */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start gap-4">
                <div className="relative flex-shrink-0 group">
                  <div className="w-20 h-20 rounded-full overflow-hidden ring-2 ring-blue-100 bg-blue-50 flex items-center justify-center">
                    {emp.hr_photourl ? <img src={emp.hr_photourl} alt={emp.hr_hremployee1} className="w-full h-full object-cover" /> : <span className="text-xl font-bold text-[#2563EB]">{initials}</span>}
                  </div>
                  {canEdit && (
                    <label className="absolute inset-0 rounded-full flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
                      <CameraIcon className="w-5 h-5 text-white" />
                      <input type="file" accept=".jpg,.jpeg,.png" className="hidden" onChange={e => uploadDoc('Photo', e.target.files?.[0])} />
                    </label>
                  )}
                </div>
                <div className="min-w-0 pt-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-xl font-bold text-gray-900 truncate">{emp.hr_hremployee1}</h1>
                    <StatusBadge status={emp.hr_status} />
                    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ring-1 ${badge.cls}`}><badge.icon className="w-3.5 h-3.5" /> {badge.text}</span>
                  </div>
                  <p className="text-gray-500 text-sm mt-1 font-medium">{fmtVal(emp.hr_designation)} · {fmtVal(emp.hr_department)}</p>
                  <p className="text-xs text-gray-400 mt-1">Employee ID <span className="font-bold text-[#2563EB]">{fmtVal(emp._employeeid || emp.hr_employeeid)}</span></p>
                </div>
              </div>

              {/* HR-managed identity — shown ONCE, read-only */}
              <div className="mt-5 pt-4 border-t border-[#E5E7EB]">
                <div className="flex items-center gap-1.5 mb-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                  <LockClosedIcon className="w-3.5 h-3.5" /> Managed by HR
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3.5">
                  {[
                    hrView && ['Employee Code', emp._empcode || emp.hr_etimecode],
                    ['Department', emp.hr_department],
                    ['Designation', emp.hr_designation],
                    ['Reporting Manager', managerName],
                    ['Role', titleCase(emp.hr_role)],
                    ['Joining Date', fmtDate(emp.hr_joiningdate)],
                    ['Shift', emp.hr_shiftname],
                    ['Employment Type', emp.hr_employmenttype],
                    ['Work Location', emp.hr_worklocation],
                    ['Work Email', emp.hr_email],
                  ].filter(Boolean).map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">{label}</p>
                      <p className="text-sm text-gray-900 font-semibold truncate">{fmtVal(value)}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Profile completion — white circular card on the right */}
            <div className="lg:w-60 flex-shrink-0">
              <div className="rounded-xl border border-[#E5E7EB] bg-[#F8FAFC] p-5 flex flex-col items-center text-center h-full">
                <div className="relative"><ProgressRing value={completion.percent} /><span className="absolute inset-0 flex items-center justify-center text-base font-bold text-gray-800">{completion.percent}%</span></div>
                <p className="text-sm font-semibold text-gray-800 mt-2">Profile Complete</p>
                {completion.missing?.length ? (
                  <div className="mt-3 w-full text-left">
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2 text-center">Missing</p>
                    <div className="space-y-2.5">
                      {(completion.missingGrouped || [{ tab: '', items: completion.missing }]).map(g => (
                        <div key={g.tab || 'all'}>
                          {g.tab && (
                            <button type="button" onClick={() => setTab(TAB_KEY[g.tab] || 'general')} className="text-[10px] font-bold text-gray-500 uppercase tracking-wide hover:text-blue-600">
                              {g.tab} ›
                            </button>
                          )}
                          <div className="flex flex-wrap gap-1.5 mt-0.5">
                            {g.items.map(m => <span key={m} className="text-[11px] font-medium text-[#F59E0B] bg-amber-50 px-2 py-0.5 rounded-full">{m}</span>)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <p className="text-xs text-[#10B981] font-medium mt-2">All set 🎉</p>}
              </div>
            </div>
          </div>

          {hrView && status === 'pending' && (
            <div className="mt-5 flex flex-wrap items-center gap-2 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
              <ExclamationTriangleIcon className="w-5 h-5 text-amber-600" />
              <span className="text-sm font-medium text-amber-800 flex-1">This profile has changes awaiting verification.</span>
              <button onClick={() => verifyMutation.mutate({ action: 'approve' })} disabled={verifyMutation.isPending} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"><CheckCircleIcon className="w-4 h-4" /> Approve</button>
              <button onClick={() => verifyMutation.mutate({ action: 'request_changes', note: window.prompt('What needs changing?') || '' })} disabled={verifyMutation.isPending} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-orange-700 bg-orange-100 rounded-lg hover:bg-orange-200 disabled:opacity-50">Request Changes</button>
              <button onClick={() => verifyMutation.mutate({ action: 'reject', note: window.prompt('Reason for rejection?') || '' })} disabled={verifyMutation.isPending} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-100 rounded-lg hover:bg-red-200 disabled:opacity-50"><XCircleIcon className="w-4 h-4" /> Reject</button>
            </div>
          )}
          {(status === 'changes' || status === 'rejected') && emp.hr_verifynote && (
            <div className="mt-5 bg-orange-50 border border-orange-100 rounded-xl px-4 py-3 text-sm text-orange-800"><b>HR note:</b> {emp.hr_verifynote}</div>
          )}
        </div>
      </div>

      {/* ── Tabs card ── */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 gap-2">
          <div className="flex overflow-x-auto">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)} className={`inline-flex items-center gap-2 px-5 py-3.5 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors ${tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                <t.icon className="w-4 h-4" /> {t.label}
                {t.verify && status === 'verified' && <CheckBadgeIcon className="w-4 h-4 text-emerald-500" />}
              </button>
            ))}
          </div>
          {/* Single Edit / Save / Cancel controlling ALL tabs */}
          {canEdit && tab !== 'documents' && (
            <div className="flex items-center gap-2 pr-4 flex-shrink-0">
              {editing ? (
                <>
                  <button onClick={cancelEdit} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
                  <button onClick={handleSubmit(onValid, onInvalid)} disabled={saveMutation.isPending} className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50">{saveMutation.isPending ? 'Saving…' : 'Save'}</button>
                </>
              ) : (
                <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-blue-600 bg-blue-50 rounded-xl hover:bg-blue-100"><PencilIcon className="w-4 h-4" /> Edit</button>
              )}
            </div>
          )}
        </div>

        <div className="p-5 sm:p-6">
          {editing && (
            <div className="mb-4 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              You are editing your profile. Changes to PAN, Aadhaar, Bank or Address will require HR verification. Click <b>Save</b> to apply all sections.
            </div>
          )}

          {/* Form (all tabs mounted; only the active one is shown) — one Save submits all */}
          <form onSubmit={handleSubmit(onValid, onInvalid)} className={tab === 'documents' ? 'hidden' : ''}>
            {FORM_TABS.map(t => (
              <div key={t.key} className={tab === t.key ? 'grid grid-cols-1 sm:grid-cols-2 gap-5' : 'hidden'}>
                {t.fields.map(Field)}
              </div>
            ))}
          </form>

          {/* Documents — generic management (upload any type, HR verifies) */}
          {tab === 'documents' && (
            <DocumentsManager employeeId={id} canManage={canEdit} hrView={hrView} />
          )}
        </div>
      </div>

      {/* Leave Balance summary (auto-calculated from approved leave) */}
      <LeaveBalance employeeId={id} employeeName={emp?.hr_hremployee1} />
    </div>
  );
}
