import { useEffect, type ReactNode, type RefObject } from 'react';
import type { Diagnostic } from '../engine/checks';
import { AlertIcon, InfoIcon } from './Icons';

/** Label + numeric input pair for a `.prop-grid` (renders two grid cells). */
export function NumField({ label, value, onChange, step = 0.5, unit, min, max, disabled, id }: {
  label: ReactNode; value: number; onChange: (v: number) => void; step?: number; unit?: string; min?: number; max?: number; disabled?: boolean; id?: string;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="num-wrap">
        <input id={id} className="input" type="number" step={step} min={min} max={max} disabled={disabled}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => { const v = +e.target.value; if (Number.isFinite(v)) onChange(v); }} />
        {unit && <span className="unit">{unit}</span>}
      </div>
    </>
  );
}

export function SelectField<T extends string>({ label, value, onChange, options, disabled }: {
  label: ReactNode; value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[]; disabled?: boolean;
}) {
  return (
    <>
      <label>{label}</label>
      <select className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
    </>
  );
}

export function TextField({ label, value, onChange, placeholder, disabled }: {
  label: ReactNode; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
}) {
  return (
    <>
      <label>{label}</label>
      <input className="input" value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

/** Collapsible inspector section. */
export function Section({ title, meta, open = true, children, className }: { title: ReactNode; meta?: ReactNode; open?: boolean; children: ReactNode; className?: string }) {
  return (
    <details className={`section ${className ?? ''}`} open={open}>
      <summary>{title}{meta !== undefined && <span className="meta">{meta}</span>}</summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

export function DiagnosticList({ items }: { items: Diagnostic[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="diag">
      {items.map((d, i) => (
        <li key={`${d.code}-${i}`} className={`diag-${d.severity}`}>
          {d.severity === 'info' ? <InfoIcon /> : <AlertIcon />}
          <span><span className="code">{d.severity === 'error' ? '오류' : d.severity === 'warning' ? '확인' : '정보'}</span><span className="msg">{d.message}</span></span>
        </li>
      ))}
    </ul>
  );
}

/** Close a popover on outside pointer-down or Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [ref, open, onClose]);
}

export const fmt = (v: number | undefined, d = 1) => (v !== undefined && Number.isFinite(v) ? v.toFixed(d) : '—');
export const formatFrequency = (hz: number) => hz >= 1000
  ? `${Number((hz / 1000).toFixed(hz >= 10000 ? 0 : 1))} kHz`
  : `${Math.round(hz)} Hz`;
