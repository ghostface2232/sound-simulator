import type { Scene } from '../engine/scene';
import type { SimResult } from '../engine/analysis';
import type { Diagnostic } from '../engine/checks';
import type { ObjectiveBreakdown, ObjectiveSettings } from '../engine/optimize';
import { ScenePreview } from './ScenePreview';
import { Section, fmt } from './fields';
import { ArrowLeftIcon, PlayIcon, RefreshIcon, SaveIcon, StopIcon, TrashIcon, VariantsIcon } from './Icons';

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
  previewedId: string | null;
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
  busy: boolean;
}

export function VariantPanel(p: Props) {
  const ranked = [...p.variants].sort((a, b) => (b.breakdown?.score ?? -Infinity) - (a.breakdown?.score ?? -Infinity));
  const best = ranked.find((v) => v.breakdown && Number.isFinite(v.breakdown.score));
  const o = p.objective;
  const setW = (key: keyof ObjectiveSettings['weights']) => (e: React.ChangeEvent<HTMLInputElement>) => p.setObjective({ ...o, weights: { ...o.weights, [key]: +e.target.value } });
  const unevaluated = p.variants.filter((v) => !v.result || v.evaluatedWith !== p.paramsSignature).length;

  return (
    <>
      <div className="panel-head">
        <h2>설계안</h2>
        {p.variants.length > 0 && <span className="chip">{p.variants.length}</span>}
        <span className="spacer" />
        <button className="btn sm" onClick={p.onSave} disabled={p.busy} title="편집 중인 설계를 안으로 저장"><SaveIcon />현재 설계 저장</button>
        {p.running
          ? <button className="btn sm" onClick={p.onStop}><StopIcon />중단</button>
          : <button className="btn sm primary" onClick={() => p.onEvaluate()} disabled={p.busy || p.variants.length === 0} title="모든 안을 시뮬레이션 설정으로 평가"><PlayIcon />모두 평가</button>}
      </div>
      <div className="panel-body">
        {p.running && (
          <div className="section"><div className="section-body" style={{ paddingTop: 10 }}>
            <div className="notice info"><span className="grow">평가 중 · {p.variants.find((v) => v.id === p.runningId)?.name ?? '준비 중'}</span></div>
          </div></div>
        )}
        {p.variants.length === 0 ? (
          <div className="section"><div className="section-body" style={{ paddingTop: 12 }}>
            <div className="empty"><VariantsIcon /><strong>저장된 안 없음</strong></div>
          </div></div>
        ) : (
          <Section title="저장된 안" meta={unevaluated > 0 ? `${unevaluated}개 평가 필요` : '모두 평가됨'}>
            {ranked.map((v) => {
              const color = p.colorFor(v.id);
              const stale = v.result && v.evaluatedWith !== p.paramsSignature;
              const previewed = p.previewedId === v.id;
              return (
                <article key={v.id} className={`cand ${v === best ? 'best' : ''} ${previewed ? 'previewed' : ''}`} onClick={() => p.onPreview(v)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onPreview(v); } }}>
                  <span className="compare-box" onClick={(e) => e.stopPropagation()} title={v.result ? '결과 도크에서 비교' : '평가 후 비교할 수 있습니다'}>
                    <input className="check" type="checkbox" checked={p.selected.has(v.id)} onChange={() => p.onToggle(v.id)} disabled={!v.result} />
                  </span>
                  <div className="title">
                    {color && <span className="swatch-dot" style={{ background: color }} />}
                    <input className="name-input grow" aria-label="설계안 이름" value={v.name} onClick={(e) => e.stopPropagation()} onChange={(e) => p.onRename(v, e.target.value)} />
                  </div>
                  <div className="score">{fmt(v.breakdown?.score, 2)}<small>{v === best ? '현재 최고' : stale ? '재평가 필요' : v.error ? '평가 오류' : v.result ? '점수' : '미평가'}</small></div>
                  <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '64px 1fr', gap: 8, alignItems: 'center' }}>
                    <span className="thumb" style={{ display: 'grid', placeItems: 'center', height: 48, borderRadius: 5, background: 'var(--canvas-domain)' }}><ScenePreview scene={v.scene} width={60} height={44} /></span>
                    <dl className="metrics" style={{ gridColumn: 'auto' }}>
                      <div><dt>레벨</dt><dd>{fmt(v.breakdown?.level)}</dd></div>
                      <div><dt>균일</dt><dd>{fmt(v.breakdown?.uniformity)}</dd></div>
                      <div><dt>평탄</dt><dd>{fmt(v.breakdown?.flatness)}</dd></div>
                      <div><dt>누설</dt><dd>{fmt(v.breakdown?.leakage)}</dd></div>
                    </dl>
                  </div>
                  {v.error && <div className="notice error" style={{ gridColumn: '1 / -1' }}>{v.error}</div>}
                  <div className="foot" onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm" onClick={() => p.onEvaluate([v.id])} disabled={p.busy} title="이 안만 평가"><PlayIcon />평가</button>
                    <button className="btn sm" onClick={() => p.onLoad(v)} disabled={p.busy} title="이 안을 편집기로 불러오기"><ArrowLeftIcon />편집</button>
                    <button className="btn sm" onClick={() => p.onUpdateFromEditor(v)} disabled={p.busy} title="편집 중인 형상으로 이 안을 덮어쓰기"><RefreshIcon />갱신</button>
                    <button className="btn sm icon danger" aria-label={`${v.name} 삭제`} onClick={() => p.onDelete(v)} disabled={p.busy}><TrashIcon /></button>
                  </div>
                </article>
              );
            })}
          </Section>
        )}

        <Section title="점수 기준" meta={`${o.band[0]}-${o.band[1]} Hz`} open={false}>
          <div className="prop-grid">
            <label>대역 시작</label><div className="num-wrap"><input className="input" type="number" step="100" value={o.band[0]} onChange={(e) => p.setObjective({ ...o, band: [+e.target.value, o.band[1]] })} /><span className="unit">Hz</span></div>
            <label>대역 끝</label><div className="num-wrap"><input className="input" type="number" step="100" value={o.band[1]} onChange={(e) => p.setObjective({ ...o, band: [o.band[0], +e.target.value] })} /><span className="unit">Hz</span></div>
            <label>측면 각도</label><div className="num-wrap"><input className="input" type="number" step="5" value={o.sideAngle} onChange={(e) => p.setObjective({ ...o, sideAngle: +e.target.value })} /><span className="unit">°</span></div>
            <label>w 측면 레벨</label><input className="input" type="number" step="0.1" value={o.weights.level} onChange={setW('level')} />
            <label>w 수평 균일</label><input className="input" type="number" step="0.1" value={o.weights.uniformity} onChange={setW('uniformity')} />
            <label>w 응답 평탄</label><input className="input" type="number" step="0.1" value={o.weights.flatness} onChange={setW('flatness')} />
            <label>w 상하 누설</label><input className="input" type="number" step="0.1" value={o.weights.leakage} onChange={setW('leakage')} />
          </div>
          <p className="help">가중치를 바꾸면 저장된 결과로 점수를 즉시 재계산.</p>
        </Section>
      </div>
    </>
  );
}
