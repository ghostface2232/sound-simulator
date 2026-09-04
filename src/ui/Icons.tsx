import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const I = (d: React.ReactNode) => (props: IconProps) => <svg {...base} {...props}>{d}</svg>;

// Brand / workflow
/** Brand mark: the r-z axis with mirrored wavefronts, i.e. an axisymmetric radiation section. */
export function LogoMark(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" {...props}>
      <path d="M12 3.5v17" opacity=".45" strokeDasharray="1.5 2.5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M15.4 7.1a6 6 0 0 1 0 9.8M8.6 7.1a6 6 0 0 0 0 9.8" />
      <path d="M17.5 4.2a9.5 9.5 0 0 1 0 15.6M6.5 4.2a9.5 9.5 0 0 0 0 15.6" opacity=".55" />
    </svg>
  );
}
export const LayersIcon = I(<><path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" /><path d="m3.5 12 8.5 4.5 8.5-4.5" /><path d="m3.5 16.5 8.5 4.5 8.5-4.5" /></>);
export const LibraryIcon = I(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><path d="M17 13.5v7M13.5 17h7" /></>);
export const ExploreIcon = I(<><path d="M4 17.5 9 12l3 3 8-9" /><path d="M15 6h5v5" /></>);
export const VariantsIcon = I(<><rect x="3.5" y="5" width="7.5" height="14" rx="1.8" /><rect x="13" y="5" width="7.5" height="14" rx="1.8" /><path d="M7 9v6M16.75 9v6" /></>);
export const SettingsIcon = I(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2.2" /><circle cx="10" cy="17" r="2.2" /></>);
export const KeyboardIcon = I(<><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></>);
export const SunIcon = I(<><circle cx="12" cy="12" r="3.6" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>);
export const MoonIcon = I(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />);

// Actions
export const PlayIcon = I(<path d="m8 6.5 9.5 5.5L8 17.5V6.5Z" fill="currentColor" stroke="none" />);
export const StopIcon = I(<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />);
export const CheckIcon = I(<path d="m5 12.5 4.5 4.5L19 7" />);
export const AlertIcon = I(<><path d="M10.3 4.2 2.7 17.4A1.7 1.7 0 0 0 4.2 20h15.6a1.7 1.7 0 0 0 1.5-2.6L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 16.8v.2" /></>);
export const InfoIcon = I(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>);
export const CloseIcon = I(<path d="m6 6 12 12M18 6 6 18" />);
export const PlusIcon = I(<path d="M12 5v14M5 12h14" />);
export const MinusIcon = I(<path d="M5 12h14" />);
export const ChevronDownIcon = I(<path d="m6 9 6 6 6-6" />);
export const ChevronRightIcon = I(<path d="m9 6 6 6-6 6" />);
export const ChevronUpIcon = I(<path d="m6 15 6-6 6 6" />);
export const ArrowUpIcon = I(<path d="M12 19V5M6 11l6-6 6 6" />);
export const ArrowDownIcon = I(<path d="M12 5v14M6 13l6 6 6-6" />);
export const ArrowLeftIcon = I(<path d="M19 12H5M11 6l-6 6 6 6" />);
export const TrashIcon = I(<path d="M4 7h16M9.5 7V4.5h5V7M7 7l.9 12.5h8.2L17 7M10 11v5M14 11v5" />);
export const CopyIcon = I(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>);
export const SaveIcon = I(<><path d="M5 4h11.5L19 6.5V20H5V4Z" /><path d="M8 4v5.5h7V4M8 20v-6h8v6" /></>);
export const UploadIcon = I(<path d="M12 16V4M7 9l5-5 5 5M4 20h16" />);
export const DownloadIcon = I(<path d="M12 4v12M7 11l5 5 5-5M4 20h16" />);
export const RefreshIcon = I(<><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v5h-5" /></>);
export const EyeIcon = I(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>);
export const FileIcon = I(<><path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5L14 3Z" /><path d="M14 3v4.5h4.5" /></>);
export const CodeIcon = I(<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />);
export const MoreIcon = I(<><circle cx="6" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18" cy="12" r="1.2" fill="currentColor" /></>);
export const SidebarIcon = I(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9.5 4.5v15" /></>);
export const DockIcon = I(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 14h17" /></>);
export const ActivityIcon = I(<path d="M3 12h4l2.2-6 4.2 12 2.3-6H21" />);
export const SparkIcon = I(<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.2l-1.8-5.6-5.7-1.8L10.2 9 12 3.5Z" />);
export const ClockIcon = I(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);

// Canvas tools
export const SelectIcon = I(<path d="m5.5 3.5 13 8-6 1.5L9.5 19.5 5.5 3.5Z" />);
export const PenIcon = I(<><path d="m4 20 4.6-4.6" /><path d="M15.2 4.3 19.7 8.8 10.2 18.3 5.7 13.8 15.2 4.3Z" /><circle cx="12.4" cy="11.6" r="1.3" /></>);
export const RectangleIcon = I(<rect x="4" y="5" width="16" height="14" rx="2" />);
export const EllipseIcon = I(<ellipse cx="12" cy="12" rx="8" ry="6.5" />);
export const UndoIcon = I(<><path d="m8.5 7-4.5 5 4.5 5" /><path d="M4 12h9a6 6 0 0 1 6 6" /></>);
export const RedoIcon = I(<><path d="m15.5 7 4.5 5-4.5 5" /><path d="M20 12h-9a6 6 0 0 0-6 6" /></>);
export const FitIcon = I(<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />);
export const FrameIcon = I(<><path d="M4 8V4h4M16 4h4v4M4 16v4h4M16 20h4v-4" /><rect x="8.5" y="8.5" width="7" height="7" rx="1" /></>);
export const GridIcon = I(<path d="M4 4h16v16H4zM9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16" />);
export const ZoomInIcon = I(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.3-4.3M11 8.5v5M8.5 11h5" /></>);
export const ZoomOutIcon = I(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.3-4.3M8.5 11h5" /></>);

// Scene element glyphs
export const DriverIcon = I(<><path d="M5 9v6h3.5l5 4V5l-5 4H5Z" /><path d="M17 9.5a3.5 3.5 0 0 1 0 5" /></>);
export const RadialDriverIcon = I(<><rect x="9" y="4" width="6" height="16" rx="1.5" /><path d="M5 9v6M19 9v6M2.5 10.5v3M21.5 10.5v3" /></>);
export const MeasureIcon = I(<><path d="M4 18a8 8 0 0 1 16 0" /><path d="M12 10v8M12 18h.01" /><circle cx="12" cy="18" r="1" fill="currentColor" /></>);
export const FloorIcon = I(<><path d="M3 15h18" /><path d="m5 15-2 4M9 15l-2 4M13 15l-2 4M17 15l-2 4M21 15l-2 4" /></>);
export const HousingIcon = I(<path d="M5 4h14v16H5zM8 4v16M16 4v16" />);
export const ReflectorIcon = I(<path d="m4 18 8-12 8 12H4Z" />);
export const SlotIcon = I(<><path d="M5 5h14M5 19h14" /><path d="M8 10h8M8 14h8" strokeDasharray="2 2" /></>);
export const FabricIcon = I(<><rect x="5" y="5" width="14" height="14" rx="1.5" /><path d="m5 12 7-7M5 19 19 5M12 19l7-7" /></>);
export const ShapeIcon = I(<path d="M6 4h9l5 5v11H6V4Z" />);
export const DomainIcon = I(<><rect x="3.5" y="3.5" width="17" height="17" rx="2" strokeDasharray="3 2.5" /><rect x="7.5" y="7.5" width="9" height="9" rx="1" /></>);
