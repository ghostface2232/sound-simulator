import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function WaveIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M3 12h2.2c1.5 0 1.5-5.5 3-5.5s1.5 11 3 11 1.5-15 3-15 1.5 19 3 19 1.5-9.5 3-9.5H21" /></svg>;
}

export function DesignIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4 18.5V8.2L8.2 4H18a2 2 0 0 1 2 2v12.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z" /><path d="M4 9h4a1 1 0 0 0 1-1V4M9 15l2-2 2 2 3-4 2 3" /></svg>;
}

export function OptimizeIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4 17.5 9 12l3 3 8-9" /><path d="M15 6h5v5" /><path d="M4 5v14h16" /></svg>;
}

export function CompareIcon(props: IconProps) {
  return <svg {...base} {...props}><rect x="3" y="5" width="8" height="14" rx="2" /><rect x="13" y="5" width="8" height="14" rx="2" /><path d="M7 9h1M17 15h1" /></svg>;
}

export function PlayIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m9 7 8 5-8 5V7Z" /></svg>;
}

export function StopIcon(props: IconProps) {
  return <svg {...base} {...props}><rect x="7" y="7" width="10" height="10" rx="2" /></svg>;
}

export function ActivityIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M3 12h4l2.2-6 4.2 12 2.3-6H21" /></svg>;
}

export function ChevronIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m8 10 4 4 4-4" /></svg>;
}

export function AlertIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M10.3 4.2 2.7 17.4A1.7 1.7 0 0 0 4.2 20h15.6a1.7 1.7 0 0 0 1.5-2.6L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 16.8v.2" /></svg>;
}

export function CheckIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m5 12 4 4L19 6" /></svg>;
}

export function InfoIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
}

export function SelectIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m5 3 13 8-6 1.5L9.5 19 5 3Z" /></svg>;
}

export function PenIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m14.5 4.5 5 5L9 20H4v-5L14.5 4.5Z" /><path d="m12 7 5 5" /></svg>;
}

export function RectangleIcon(props: IconProps) {
  return <svg {...base} {...props}><rect x="4" y="5" width="16" height="14" rx="2" /></svg>;
}

export function EllipseIcon(props: IconProps) {
  return <svg {...base} {...props}><ellipse cx="12" cy="12" rx="8" ry="6.5" /></svg>;
}

export function UndoIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m9 7-5 5 5 5" /><path d="M5 12h8a6 6 0 0 1 6 6" /></svg>;
}

export function RedoIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m15 7 5 5-5 5" /><path d="M19 12h-8a6 6 0 0 0-6 6" /></svg>;
}

export function FitIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></svg>;
}

export function GridIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4 4h16v16H4zM9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16" /></svg>;
}

export function SaveIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M5 4h12l2 2v14H5V4Z" /><path d="M8 4v6h8V4M8 20v-6h8v6" /></svg>;
}

export function TrashIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>;
}
