import type { Scene } from '../engine/scene';
import type { SimResult } from '../engine/analysis';
import type { Diagnostic } from '../engine/checks';
import type { ObjectiveBreakdown, ObjectiveSettings } from '../engine/optimize';
import { CheckIcon, TrashIcon } from './Icons';

export interface Variant {
  id: string;
  name: string;
  scene: Scene;
  result?: SimResult;
  warnings?: Diagnostic[];
  error?: string;
  breakdown?: ObjectiveBreakdown;
  /** Signature of the parameters the result was computed with, to flag stale results. */
  evaluatedWith?: string;
  elapsedMs?: number;
}

interface Props {
  variants: Variant[];
  objective: ObjectiveSettings;
  paramsSignature: string;
  running: boolean;
  runningId: string | null;
  selected: Set<string>;
  onSave: () => void;
  onEvaluate: (ids?: string[]) => void;
  onStop: () => void;
  onLoad: (v: Variant) => void;
  onUpdateFromEditor: (v: Variant) => void;
  onRename: (v: Variant, name: string) => void;
  onDelete: (v: Variant) => void;
  onToggle: (id: string) => void;
  onPreview: (v: Variant) => void;
  colorFor: (id: string) => string | null;
  setObjective: (o: ObjectiveSettings) => void;
}

const fmt = (v: number | undefined, d = 1) => (v !== undefined && Number.isFinite(v) ? v.toFixed(d) : '—');

export function VariantPanel(p: Props) {
  const ranked = [...p.variants].sort((a, b) => (b.breakdown?.score ?? -Infinity) - (a.breakdown?.score ?? -Infinity));
  const best = ranked.find((v) => v.breakdown && Number.isFinite(v.breakdown.score));
  const o = p.objective;
  const setW = (key: keyof ObjectiveSettings['weights']) => (e: React.ChangeEvent<HTMLInputElement>) =>
    p.setObjective({ ...o, weights: { ...o.weights, [key]: +e.target.value } });

  return (
    <>
      <div className="workflow-intro">
        <div className="row">
          <button className="primary" onClick={p.onSave} disabled={p.running}>새 안 저장</button>
          <button onClick={() => p.onEvaluate()} disabled={p.running || p.variants.length === 0}>전체 평가</button>
        </div>
      </div>
      {p.running && <div className="row stop-row">
        <button onClick={p.onStop}>중단</button>
        <p className="status">평가 중 · {p.variants.find((v) => v.id === p.runningId)?.name ?? '준비 중'}</p>
      </div>}

      {p.variants.length === 0 ? (
        <div className="empty-state compact-empty">
          <CheckIcon />
          <strong>비교할 안이 없습니다</strong>
          <span>설계에서 안을 저장하세요.</span>
        </div>
      ) : (
        <div className="variant-list">
          {ranked.map((v) => {
            const color = p.colorFor(v.id);
            const stale = v.result && v.evaluatedWith !== p.paramsSignature;
            const selected = p.selected.has(v.id);
            return (
              <article key={v.id} className={`variant-card ${v === best ? 'best' : ''} ${selected ? 'selected' : ''}`}
                onClick={() => p.onPreview(v)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') p.onPreview(v); }} tabIndex={0}>
                <header>
                  <label className="compare-toggle" onClick={(e) => e.stopPropagation()} title={v.result ? '오른쪽 그래프에서 비교' : '평가 후 비교할 수 있습니다'}>
                    <input type="checkbox" checked={selected} onChange={() => p.onToggle(v.id)} disabled={!v.result} />
                    {color && <span className="swatch" style={{ background: color }} />}
                  </label>
                  <input className="variant-name" aria-label="설계안 이름" value={v.name} onClick={(e) => e.stopPropagation()} onChange={(e) => p.onRename(v, e.target.value)} />
                  <div className="variant-score"><span>점수</span><strong>{fmt(v.breakdown?.score, 2)}</strong></div>
                </header>
                <div className="variant-flags">
                  {v === best && <span className="badge">현재 최고</span>}
                  {stale && <span className="stale-badge">재평가 필요</span>}
                  {v.error && <span className="error small">평가 오류</span>}
                  {!v.result && !v.error && <span className="muted small">아직 평가하지 않음</span>}
                </div>
                <dl className="metric-grid">
                  <div><dt>측면 레벨</dt><dd>{fmt(v.breakdown?.level)}</dd></div>
                  <div><dt>균일도</dt><dd>{fmt(v.breakdown?.uniformity)}</dd></div>
                  <div><dt>평탄도</dt><dd>{fmt(v.breakdown?.flatness)}</dd></div>
                  <div><dt>누설</dt><dd>{fmt(v.breakdown?.leakage)}</dd></div>
                </dl>
                <footer onClick={(e) => e.stopPropagation()}>
                  <button className="mini" onClick={() => p.onEvaluate([v.id])} disabled={p.running}>평가</button>
                  <button className="mini" onClick={() => p.onLoad(v)} disabled={p.running}>편집</button>
                  <button className="mini replace-model-action" onClick={() => p.onUpdateFromEditor(v)} disabled={p.running} title="이 설계안을 현재 모델로 교체">현재 모델로 교체</button>
                  <button className="icon-button mini danger-action" aria-label={`${v.name} 삭제`} onClick={() => p.onDelete(v)} disabled={p.running}><TrashIcon /></button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {p.variants.some((v) => v.error) && (
        <ul className="diag">{p.variants.filter((v) => v.error).map((v) => <li key={v.id} className="diag-error"><span className="diag-code">오류</span>{v.name}: {v.error}</li>)}</ul>
      )}

      <details className="technical-note score-settings">
        <summary><span>점수 기준</span></summary>
        <div className="grid3">
          <label>대역 시작 (Hz)<input type="number" step="100" value={o.band[0]} onChange={(e) => p.setObjective({ ...o, band: [+e.target.value, o.band[1]] })} /></label>
          <label>대역 끝 (Hz)<input type="number" step="100" value={o.band[1]} onChange={(e) => p.setObjective({ ...o, band: [o.band[0], +e.target.value] })} /></label>
          <label>측면 각도 (°)<input type="number" step="5" value={o.sideAngle} onChange={(e) => p.setObjective({ ...o, sideAngle: +e.target.value })} /></label>
          <label>w 측면 레벨<input type="number" step="0.1" value={o.weights.level} onChange={setW('level')} /></label>
          <label>w 수평 균일도<input type="number" step="0.1" value={o.weights.uniformity} onChange={setW('uniformity')} /></label>
          <label>w 응답 평탄도<input type="number" step="0.1" value={o.weights.flatness} onChange={setW('flatness')} /></label>
          <label>w 상하 누설<input type="number" step="0.1" value={o.weights.leakage} onChange={setW('leakage')} /></label>
        </div>
        <p className="muted small">점수 = w₁·측면 레벨 − w₂·수평 ±{o.spread}° 편차 − w₃·측면 응답 편차 − w₄·(상하 최대 − 측면), {o.band[0]}~{o.band[1]} Hz 평균. 가중치를 바꾸면 저장된 결과로 점수가 즉시 다시 계산됩니다.</p>
      </details>
    </>
  );
}
