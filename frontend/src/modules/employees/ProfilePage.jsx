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
  CheckCircleIcon, XCircleIcon, ExclamationTriangleIcon, LockClosedIcon, TrashIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { BLOOD_GROUPS, upper, panRule, aadhaarRule, ifscRule, accountRule, uanRule, phoneRule } from '../../utils/validators';
import { fmtVal, fmtDate, titleCase } from '../../utils/format';
import StatusBadge from '../../components/StatusBadge';
import DocumentsManager from '../../components/DocumentsManager';
import Avatar from '../../components/Avatar';
import { getEmployeeProfilePhoto, employeeInitials } from '../../utils/employeePhoto';

// Accepted profile-photo formats + max size (validated again on the server).
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
const PHOTO_MAX = 5 * 1024 * 1024;   // 5 MB

// Change / preview / save / remove modal. `kind` is 'personal' (employee self-
// service) or 'default' (HR managing an employee). Preview is a local blob shown
// BEFORE saving; nothing is persisted until Save.
function ProfilePhotoModal({ onClose, currentSrc, initials, kind, canRemove, onSave, saving, onRemove, removing }) {
  // Mounted only while open (see the caller), so local state starts fresh each time.
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [srcError, setSrcError] = useState(false);   // a broken currentSrc falls back to initials
  const [confirming, setConfirming] = useState(false);   // "Remove your profile photo?" confirmation
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = (f) => {
    if (!f) return;
    if (!PHOTO_TYPES.includes(f.type)) { toast.error('Please choose an image (JPG, PNG, GIF, WEBP or BMP).'); return; }
    if (f.size > PHOTO_MAX) { toast.error('Image must be 5 MB or smaller.'); return; }
    if (preview) URL.revokeObjectURL(preview);
    setFile(f); setPreview(URL.createObjectURL(f));
  };
  const shown = preview || (srcError ? '' : currentSrc);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        {confirming ? (
          // ── Confirmation: "Remove your profile photo?" ──
          <>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-bold text-gray-900">Remove your profile photo?</h2>
              <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-all"><XMarkIcon className="w-5 h-5" /></button>
            </div>
            <div className="px-5 py-5">
              <p className="text-sm text-gray-500 leading-relaxed">Your profile photo will be removed and your default avatar will be shown.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-100">
              <button onClick={() => setConfirming(false)} disabled={removing} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 disabled:opacity-50 transition-colors">Cancel</button>
              <button onClick={onRemove} disabled={removing}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-xl hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                <TrashIcon className="w-4 h-4" /> {removing ? 'Removing…' : 'Remove Photo'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-bold text-gray-900">{kind === 'personal' ? 'Profile Photo' : 'Default Employee Photo'}</h2>
              <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-all"><XMarkIcon className="w-5 h-5" /></button>
            </div>
            <div className="px-5 py-5 flex flex-col items-center gap-4">
              <div className="w-32 h-32 rounded-full overflow-hidden ring-2 ring-blue-100 bg-blue-50 flex items-center justify-center">
                {shown
                  ? <img src={shown} alt="Preview" className="w-full h-full object-cover" onError={() => setSrcError(true)} />
                  : <span className="text-3xl font-bold text-[#2563EB]">{initials}</span>}
              </div>
              {preview && <p className="text-xs text-gray-400">Preview — not saved yet</p>}
              <label className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-[#2563EB] bg-blue-50 rounded-xl hover:bg-blue-100 cursor-pointer transition-colors">
                <ArrowUpTrayIcon className="w-4 h-4" /> {currentSrc || preview ? 'Choose a different image' : 'Choose an image'}
                <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/bmp" className="hidden" onChange={e => pick(e.target.files?.[0])} />
              </label>
              <p className="text-[11px] text-gray-400 text-center">JPG, PNG, GIF, WEBP or BMP · up to 5 MB.{kind === 'personal' ? ' Removing your personal photo falls back to the default photo.' : ''}</p>
            </div>
            <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-100">
              {canRemove && (
                <button onClick={() => setConfirming(true)} disabled={removing || saving}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 rounded-xl disabled:opacity-50 transition-colors">
                  <TrashIcon className="w-4 h-4" /> Remove Photo
                </button>
              )}
              <div className="flex-1" />
              <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
              <button onClick={() => file && onSave(file)} disabled={!file || saving || removing}
                className="px-5 py-2 bg-[#2563EB] text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {saving ? 'Saving…' : 'Save Photo'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const GENDERS = ['Male', 'Female'];
const MARITAL = ['Single', 'Married'];
const DOC_TYPES = ['Aadhaar Card', 'PAN Card', 'Passport', 'Driving Licence', 'Cancelled Cheque', 'Passbook', 'Photo'];

const FORM_TABS = [
  { key: 'general', label: 'General', icon: UserIcon, fields: [
    { name: 'hr_phone', label: 'Mobile Number', rules: phoneRule },
    { name: 'hr_altphone', label: 'Alternate Mobile', rules: phoneRule },
    { name: 'hr_personalemail', label: 'Personal Email', type: 'email' },
    { name: 'hr_dob', label: 'Original Date of Birth', type: 'date', required: true },
    // Certificate DOB is HR-managed (document reference) — employees can view it but NEVER
    // edit it, and it is NEVER used for birthday wishes. hrOnly gates edit in render + save.
    { name: 'hr_certificatedob', label: 'Certificate Date of Birth', type: 'date', hrOnly: true },
    { name: 'hr_gender', label: 'Gender', type: 'select', options: GENDERS },
    { name: 'hr_maritalstatus', label: 'Marital Status', type: 'select', options: MARITAL },
    // Marriage Date shows (and is required) only when Marital Status = Married.
    { name: 'hr_marriagedate', label: 'Marriage Date', type: 'date', visibleWhen: (v) => v.hr_maritalstatus === 'Married', requiredWhen: (v) => v.hr_maritalstatus === 'Married' },
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
// Fields only HR/Super Admin may edit (employees can view). Backend SELF_EDITABLE enforces this too.
const HRONLY_FIELDS = new Set(FORM_TABS.flatMap(t => t.fields.filter(f => f.hrOnly).map(f => f.name)));

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
  const [photoOpen, setPhotoOpen] = useState(false);

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm();
  // Marital status drives the conditional Marriage Date field.
  const marital = watch('hr_maritalstatus');

  const { data, isLoading } = useQuery({ queryKey: ['employee', id], queryFn: () => employeeApi.get(id), enabled: !!id });
  const emp = data?.data;
  // Warm the documents cache for the Documents tab (result read there, not here).
  useQuery({ queryKey: ['documents', id], queryFn: () => documentApi.list({ employeeId: id }), enabled: !!id });

  // Reset the form from the server data whenever it (re)loads — but not while the
  // user is mid-edit (so a background refetch can't wipe their changes).
  useEffect(() => { if (emp && !editing) reset(emp); }, [emp, editing, reset]);

  const completion = emp?._completion || { percent: 0, missing: [] };
  const status = emp?._verifystatus || emp?.hr_verifystatus || 'verified';
  const badge = VERIFY_BADGE[status] || VERIFY_BADGE.verified;
  const managerName = fmtVal(emp?._reportingmanager || emp?.['_hr_manager_value@OData.Community.Display.V1.FormattedValue']);
  const initials = employeeInitials(emp?.hr_hremployee1);   // central rule (first+last / first-two)
  const photoSrc = getEmployeeProfilePhoto(emp);
  // Show "Remove Photo" whenever a photo is CURRENTLY DISPLAYED. On self-service
  // (/profile) that means any displayed photo — personal OR the default — so the
  // employee can remove the default too (removal suppresses it → initials). Under HR
  // management (/employees/:id/profile) it targets the default column.
  const canRemoveThisKind = paramId ? !!emp?.hr_photourl : !!photoSrc;

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
    for (const f of EDITABLE_FIELDS) {
      if (HRONLY_FIELDS.has(f) && !hrView) continue;   // employees can never submit HR-only fields (backend also strips)
      if (values[f] !== undefined) payload[f] = values[f];
    }
    // Clear Marriage Date whenever the employee is not Married (keeps data consistent).
    if (values.hr_maritalstatus !== 'Married') payload.hr_marriagedate = '';
    saveMutation.mutate(payload);
  };
  const onInvalid = (errs) => {
    const first = Object.keys(errs)[0];
    if (first && FIELD_TAB[first]) setTab(FIELD_TAB[first]);
    toast.error('Please fix the highlighted fields');
  };
  const cancelEdit = () => { reset(emp); setEditing(false); };

  // Profile photo. On the self-service /profile route this manages the employee's
  // PERSONAL photo; on the HR /employees/:id/profile route it manages the DEFAULT
  // photo. The two are SEPARATE columns — one never overwrites the other. Uploads
  // reuse the existing /documents/upload infra, then set the resolved photo field.
  const photoKind = paramId ? 'default' : 'personal';

  const savePhoto = useMutation({
    mutationFn: async (file) => {
      const fd = new FormData();
      fd.append('file', file); fd.append('employeeId', id);
      fd.append('documentType', 'Photo'); fd.append('name', 'Profile Photo');
      const up = await documentApi.upload(fd);
      const fileUrl = up.data?.fileUrl;
      if (!fileUrl) throw new Error('Upload failed');
      return employeeApi.setPhoto(id, photoKind, fileUrl);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['employee', id] });   // refetch → new URL + version
      qc.invalidateQueries({ queryKey: ['employees'] });            // list avatars
      toast.success('Photo updated'); setPhotoOpen(false);
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message || 'Upload failed'),
  });

  const removePhoto = useMutation({
    mutationFn: () => employeeApi.removePhoto(id, photoKind),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['employee', id] });   // refetch → Avatar falls back to default/initials
      qc.invalidateQueries({ queryKey: ['employees'] });            // list avatars
      toast.success(photoKind === 'personal' ? 'Photo removed' : 'Default photo removed');
      setPhotoOpen(false);
    },
    // Friendly message to the user; real error kept in the console/logs for debugging.
    onError: (e) => { console.error('[profile] remove photo failed:', e); toast.error('Unable to remove profile photo. Please try again.'); },
  });

  if (isLoading) return <div className="max-w-5xl mx-auto"><div className="bg-white rounded-2xl border border-gray-100 p-16 text-center text-gray-400">Loading profile…</div></div>;
  if (!emp) return <div className="max-w-5xl mx-auto"><div className="bg-white rounded-2xl border border-gray-100 p-16 text-center text-gray-500">Profile not found.</div></div>;

  const formVals = { hr_maritalstatus: marital };
  const Field = (f) => {
    const err = errors[f.name];
    // HR-only fields stay read-only for non-HR even in edit mode (employees can view, not edit).
    const ro = !editing || (f.hrOnly && !hrView);
    const required = f.required || (f.requiredWhen && f.requiredWhen(formVals));
    const base = `w-full ${f.textarea ? 'px-4 py-2.5' : 'h-11 px-4'} border rounded-xl text-sm transition-all outline-none ${err ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200'} ${ro ? 'bg-gray-50/70 text-gray-600 cursor-default' : 'bg-white text-gray-900 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400'}`;
    const reg = register(f.name, { ...(required ? { required: `${f.label} is required` } : {}), ...(f.rules || {}) });
    return (
      <div key={f.name} className={`space-y-1.5 ${f.textarea ? 'sm:col-span-2' : ''}`}>
        <label className="block text-sm font-semibold text-gray-700">{f.label}{required && <span className="text-red-500 ml-0.5">*</span>}{f.hrOnly && !hrView && <span className="ml-1 text-[11px] font-normal text-gray-400">· Managed by HR</span>}</label>
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
                  <Avatar emp={emp} className="w-20 h-20 rounded-full ring-2 ring-blue-100 bg-blue-50" initialsClassName="text-xl font-bold text-[#2563EB]" />
                  {canEdit && (
                    <button type="button" onClick={() => setPhotoOpen(true)} aria-label="Change photo"
                      className="absolute inset-0 rounded-full flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
                      <CameraIcon className="w-5 h-5 text-white" />
                    </button>
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
                {t.fields.filter(f => !f.visibleWhen || f.visibleWhen(formVals)).map(Field)}
              </div>
            ))}
          </form>

          {/* Documents — generic management (upload any type, HR verifies) */}
          {tab === 'documents' && (
            <DocumentsManager employeeId={id} canManage={canEdit} hrView={hrView} />
          )}
        </div>
      </div>

      {photoOpen && (
        <ProfilePhotoModal
          onClose={() => setPhotoOpen(false)}
          currentSrc={photoSrc}
          initials={initials}
          kind={photoKind}
          canRemove={canRemoveThisKind}
          onSave={(file) => savePhoto.mutate(file)}
          saving={savePhoto.isPending}
          onRemove={() => removePhoto.mutate()}
          removing={removePhoto.isPending}
        />
      )}
    </div>
  );
}
