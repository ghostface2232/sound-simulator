import type { Scene } from '../engine/scene';
import type { SimResult } from '../engine/analysis';
import type { Diagnostic } from '../engine/checks';
import type { ObjectiveBreakdown, ObjectiveSettings } from '../engine/optimize';

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
      <p className="desc">편집 중인 형상을 안(案)으로 저장해 두고 한 번에 평가해 어느 안이 가장 좋은지 비교합니다. 평가는 시뮬레이션 탭의 dx·시간·백엔드 설정을 씁니다.</p>
      <div className="row">
        <button className="primary" onClick={p.onSave} disabled={p.running}>현재 형상 저장</button>
        <button onClick={() => p.onEvaluate()} disabled={p.running || p.variants.length === 0}>모두 평가</button>
        <button onClick={p.onStop} disabled={!p.running}>중단</button>
      </div>
      {p.running && <p className="status">평가 중… {p.variants.find((v) => v.id === p.runningId)?.name ?? ''}</p>}

      {p.variants.length === 0 ? (
        <p className="muted small">아직 저장된 안이 없습니다. 시뮬레이션 탭에서 형상을 만든 뒤 "현재 형상 저장"을 누르세요.</p>
      ) : (
        <table className="cands variants">
          <thead>
            <tr><th>비교</th><th>이름</th><th>점수</th><th>레벨</th><th>균일</th><th>평탄</th><th>누설</th><th></th></tr>
          </thead>
          <tbody>
            {ranked.map((v) => {
              const color = p.colorFor(v.id);
              const stale = v.result && v.evaluatedWith !== p.paramsSignature;
              return (
                <tr key={v.id} className={v === best ? 'best' : ''} onClick={() => p.onPreview(v)} title="클릭: 캔버스에 이 안의 형상 표시">
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={p.selected.has(v.id)} onChange={() => p.onToggle(v.id)} disabled={!v.result} />
                    {color && <span className="swatch" style={{ background: color }} />}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input className="name" value={v.name} onChange={(e) => p.onRename(v, e.target.value)} />
                    {v === best && <span className="badge">최고</span>}
                    {stale && <span className="muted small" title="설정이 바뀐 뒤 평가되지 않음"> (재평가 필요)</span>}
                    {v.error && <span className="error small"> 오류</span>}
                  </td>
                  <td><b>{fmt(v.breakdown?.score, 2)}</b></td>
                  <td>{fmt(v.breakdown?.level)}</td>
                  <td>{fmt(v.breakdown?.uniformity)}</td>
                  <td>{fmt(v.breakdown?.flatness)}</td>
                  <td>{fmt(v.breakdown?.leakage)}</td>
                  <td onClick={(e) => e.stopPropagation()} className="actions">
                    <button className="mini" onClick={() => p.onEvaluate([v.id])} disabled={p.running} title="이 안만 평가">평가</button>
                    <button className="mini" onClick={() => p.onLoad(v)} disabled={p.running} title="편집기로 불러오기">불러오기</button>
                    <button className="mini" onClick={() => p.onUpdateFromEditor(v)} disabled={p.running} title="현재 편집 형상으로 이 안을 덮어쓰기">갱신</button>
                    <button className="mini" onClick={() => p.onDelete(v)} disabled={p.running} title="삭제">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {p.variants.some((v) => v.error) && (
        <ul className="diag">{p.variants.filter((v) => v.error).map((v) => <li key={v.id} className="diag-error"><span className="diag-code">오류</span>{v.name}: {v.error}</li>)}</ul>
      )}

      <details>
        <summary>점수 기준 (최적화 탭과 공유)</summary>
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
      <p className="muted small">체크한 안들은 오른쪽에서 polar(공통 기준)와 측면 응답으로 겹쳐 비교됩니다. 안은 브라우저에 저장되어 새로고침 후에도 남습니다(결과는 다시 평가 필요).</p>
    </>
  );
}
