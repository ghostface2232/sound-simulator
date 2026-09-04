/**
 * Theme bridge for canvas drawing. The palette lives in CSS custom properties
 * (index.css); canvases read it at draw time so both colour schemes stay in sync.
 */

export type ThemeName = 'dark' | 'light';
const THEME_KEY = 'speaker-sim.theme';

export function loadTheme(): ThemeName {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch { /* storage unavailable */ }
  return 'dark';
}

export function applyTheme(t: ThemeName) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* storage unavailable */ }
}

export interface CanvasTheme {
  bg: string;
  domain: string;
  sponge: string;
  domainLine: string;
  axis: string;
  text: string;
  textFaint: string;
  select: string;
  selectSoft: string;
  error: string;
  floor: string;
  floorLine: string;
  handleFill: string;
  fieldBase: [number, number, number];
  fieldPos: [number, number, number];
  fieldNeg: [number, number, number];
  gridSolid: [number, number, number];
  gridSigma: [number, number, number];
  housingFill: string;
  housingStroke: string;
  reflectorFill: string;
  reflectorStroke: string;
  slotFill: string;
  slotStroke: string;
  fabricFill: string;
  fabricStroke: string;
  fabricHatch: string;
  driverBodyFill: string;
  driverBodyStroke: string;
  otherFill: string;
  otherStroke: string;
  driver: string;
  driverSoft: string;
  measure: string;
  chartGrid: string;
  chartText: string;
}

const rgbOf = (css: string, fallback: [number, number, number]): [number, number, number] => {
  const m = css.match(/(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : fallback;
};

let cache: { key: string; theme: CanvasTheme } | null = null;

/** Read the canvas palette from CSS variables. Cached per theme name. */
export function readCanvasTheme(): CanvasTheme {
  const key = document.documentElement.dataset.theme ?? 'dark';
  if (cache && cache.key === key) return cache.theme;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => (cs.getPropertyValue(name).trim() || fb);
  const theme: CanvasTheme = {
    bg: v('--canvas-bg', '#101214'),
    domain: v('--canvas-domain', '#15181b'),
    sponge: v('--canvas-sponge', 'rgba(255,255,255,0.03)'),
    domainLine: v('--canvas-domain-line', 'rgba(255,255,255,0.08)'),
    axis: v('--canvas-axis', 'rgba(255,255,255,0.22)'),
    text: v('--ink', '#e8e9ea'),
    textFaint: v('--ink-3', '#7a7f87'),
    select: v('--accent', '#4c8dff'),
    selectSoft: v('--accent-soft', 'rgba(76,141,255,0.16)'),
    error: v('--danger', '#ff5c6a'),
    floor: v('--canvas-floor', 'rgba(150,120,90,0.16)'),
    floorLine: v('--canvas-floor-line', '#a58a6a'),
    handleFill: v('--canvas-handle', '#ffffff'),
    fieldBase: rgbOf(v('--field-base', '21 24 27'), [21, 24, 27]),
    fieldPos: rgbOf(v('--field-pos', '255 122 69'), [255, 122, 69]),
    fieldNeg: rgbOf(v('--field-neg', '76 141 255'), [76, 141, 255]),
    gridSolid: rgbOf(v('--grid-solid', '230 235 240'), [230, 235, 240]),
    gridSigma: rgbOf(v('--grid-sigma', '230 170 60'), [230, 170, 60]),
    housingFill: v('--role-housing', '#4d545e'),
    housingStroke: v('--role-housing-line', '#8f98a5'),
    reflectorFill: v('--role-reflector', '#f0862c'),
    reflectorStroke: v('--role-reflector-line', '#ffb069'),
    slotFill: v('--role-slot', 'rgba(52,196,222,0.2)'),
    slotStroke: v('--role-slot-line', '#3fc7dd'),
    fabricFill: v('--role-fabric', '#c9a45f'),
    fabricStroke: v('--role-fabric-line', '#e2c583'),
    fabricHatch: v('--role-fabric-hatch', 'rgba(60,40,10,0.5)'),
    driverBodyFill: v('--role-driverbody', '#c46b84'),
    driverBodyStroke: v('--role-driverbody-line', '#f4a2b8'),
    otherFill: v('--role-other', '#7e8590'),
    otherStroke: v('--role-other-line', '#aab1bb'),
    driver: v('--role-driver', '#ff4f7e'),
    driverSoft: v('--role-driver-soft', 'rgba(255,79,126,0.28)'),
    measure: v('--role-measure', '#3ecf7a'),
    chartGrid: v('--chart-grid', 'rgba(255,255,255,0.09)'),
    chartText: v('--ink-3', '#7a7f87'),
  };
  cache = { key, theme };
  return theme;
}

export function invalidateCanvasTheme() { cache = null; }
