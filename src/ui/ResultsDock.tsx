import { useCallback, useRef } from 'react';
import type { SimResult } from '../engine/analysis';
import type { Diagnostic } from '../engine/checks';
import { PolarChart, type PolarSeries } from './PolarChart';
import { ResponseChart, type ResponseSeries } from './ResponseChart';
import { DiagnosticList, formatFrequency } from './fields';
import { ChevronDownIcon, ChevronUpIcon } from './Icons';

export interface RunInfo {
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
  progress: number;
  result: SimResult | null;
  warnings: Diagnostic[];
  backend?: string;
  elapsedMs?: number;
  cells?: number;
  gridLabel?: string;
}

interface Props {
  polarSeries: PolarSeries[];
  responseSeries: ResponseSeries[];
  legend: { color: string; label: string }[];
  polarFreq: number;
  setPolarFreq: (hz: number) => void;
  fMin: number;
  fMax: number;
  normalize: 'each' | 'shared';
  responseTitle: string;
  contextLabel: string;
  run: RunInfo;
  collapsed: boolean;
  onToggle: () => void;
  height: number;
  onResize: (h: number) => void;
  themeKey: string;
}

export function ResultsDock(p: Props) {
  const hasData = p.polarSeries.length > 0 || p.responseSeries.length > 0;
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    if (p.collapsed) return;
    dragRef.current = { startY: e.clientY, startH: p.height };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [p.collapsed, p.height]);
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    p.onResize(Math.max(180, Math.min(520, d.startH - (e.clientY - d.startY))));
  }, [p]);
  const onResizeEnd = useCallback(() => { dragRef.current = null; }, []);

  const r = p.run.result;
  return (
    <section className={`dock ${p.collapsed ? 'collapsed' : ''}`} aria-label="음향 분석 결과" style={{ height: p.collapsed ? undefined : p.height }}>
      <div className="dock-resize" onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} aria-hidden="true" />
      <div className="dock-head">
        <h2>음향 응답</h2>
        <span className={`chip dot ${p.run.status === 'running' ? 'accent' : hasData ? 'ready' : ''}`}>{p.run.status === 'running' ? `${Math.round(p.run.progress * 100)}% 계산 중` : hasData ? p.contextLabel : '해석 대기'}</span>
        {hasData && p.legend.length > 0 && (
          <div className="dock-legend" aria-label="범례">
            {p.legend.map((l) => <span key={l.label}><i style={{ background: l.color }} />{l.label}</span>)}
          </div>
        )}
        <span className="grow" />
        {!p.collapsed && <span className="faint small">상대 dB · 0° 위 · 90° 측면 · 180° 아래</span>}
        <button className="btn icon sm ghost" aria-label={p.collapsed ? '결과 펼치기' : '결과 접기'} aria-expanded={!p.collapsed} onClick={p.onToggle}>{p.collapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}</button>
      </div>
      {!p.collapsed && (
        <div className="dock-body">
          <div className="dock-cell polar" style={{ width: p.height - 38 + 24 }}>
            <header><strong>지향성</strong><span className="meta">{formatFrequency(p.polarFreq)}</span></header>
            <div className="chart">
              <PolarChart series={p.polarSeries} freq={p.polarFreq} normalize={p.normalize} themeKey={p.themeKey} />
              {!hasData && <div className="chart-empty">결과 없음</div>}
            </div>
            <div className="freq-control">
              <input className="range" aria-label="지향성 주파수" type="range" min={Math.log10(p.fMin)} max={Math.log10(p.fMax)} step={0.01}
                value={Math.log10(Math.min(Math.max(p.polarFreq, p.fMin), p.fMax))}
                onChange={(e) => p.setPolarFreq(Math.round(10 ** +e.target.value / 50) * 50)} />
              <b>{formatFrequency(p.polarFreq)}</b>
            </div>
          </div>
          <div className="dock-cell">
            <header><strong>주파수 응답</strong><span className="muted">{p.responseTitle}</span><span className="meta">{formatFrequency(p.fMin)} - {formatFrequency(p.fMax)}</span></header>
            <div className="chart">
              <ResponseChart series={p.responseSeries} fMin={p.fMin} fMax={p.fMax} themeKey={p.themeKey} />
              {!hasData && <div className="chart-empty">결과 없음</div>}
            </div>
          </div>
          <div className="dock-cell info">
            <header><strong>실행 정보</strong></header>
            <div className="dock-info">
              {r ? (
                <div className="stat-grid">
                  <div className="stat"><span>스텝</span><b>{r.nSteps.toLocaleString()}</b></div>
                  <div className="stat"><span>소요</span><b>{p.run.elapsedMs !== undefined ? `${(p.run.elapsedMs / 1000).toFixed(1)} s` : '—'}</b></div>
                  <div className="stat"><span>신뢰 대역</span><b>{Math.round(r.fMinReliable)} Hz 이상</b></div>
                  <div className="stat"><span>백엔드</span><b>{p.run.backend ?? '—'}</b></div>
                  {p.run.gridLabel && <div className="stat" style={{ gridColumn: '1 / -1' }}><span>격자</span><b>{p.run.gridLabel}</b></div>}
                </div>
              ) : p.run.status === 'running' ? (
                <div className="stat-grid">
                  <div className="stat"><span>진행</span><b>{Math.round(p.run.progress * 100)} %</b></div>
                  {p.run.gridLabel && <div className="stat"><span>격자</span><b>{p.run.gridLabel}</b></div>}
                </div>
              ) : (
                <p className="help">아직 실행하지 않음</p>
              )}
              {p.run.status === 'error' && p.run.message && <div className="notice error">{p.run.message}</div>}
              {p.run.warnings.length > 0 && <DiagnosticList items={p.run.warnings} />}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
