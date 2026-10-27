import type { ReactNode } from 'react';

export function Btn({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}) {
  const colors =
    variant === 'primary'
      ? 'bg-teal-300 text-slate-950 hover:bg-teal-200'
      : variant === 'danger'
        ? 'bg-rose-950/50 text-rose-300 hover:bg-rose-900/50'
        : 'bg-slate-800 text-slate-200 hover:bg-slate-800';
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-4 py-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${colors}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required = true,
  min,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'password' | 'url' | 'number';
  placeholder?: string;
  required?: boolean;
  min?: string;
  step?: string;
}) {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <label
      htmlFor={id}
      className="block space-y-1.5 text-sm font-medium text-slate-300"
    >
      <span>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        min={min}
        step={step}
        className="block w-full rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2.5 text-white outline-offset-2 focus:border-teal-300"
      />
    </label>
  );
}

export function Status({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'error' | 'success';
}) {
  const color =
    tone === 'error'
      ? 'border-rose-800 bg-rose-950/50 text-rose-200'
      : tone === 'success'
        ? 'border-emerald-800 bg-emerald-950/50 text-emerald-200'
        : 'border-teal-800 bg-teal-950/50 text-teal-200';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg border p-3 text-sm ${color}`}
    >
      {children}
    </div>
  );
}

export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900/80 p-4 shadow-sm sm:p-6">
      <h2 className="mb-4 text-xl font-bold text-white">{title}</h2>
      {children}
    </section>
  );
}

export function LoadingRows() {
  return (
    <div
      role="status"
      aria-label="Loading watchlist"
      className="animate-pulse space-y-3"
    >
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-16 rounded-lg bg-slate-700" />
      ))}
      <span className="sr-only">Loading games</span>
    </div>
  );
}
