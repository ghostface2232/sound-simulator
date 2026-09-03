# Speaker Sim

소형 스피커(예: Ø40 mm 드라이버 + Ø70 mm 하우징)의 리플렉터·방사구 형상을 설계하기 위한
브라우저 기반 음향 시뮬레이터. 2D 축대칭(r-z) FDTD 파동 시뮬레이션으로 회절·반사·간섭을 포함해
압력장, 지향성(polar), 주파수 응답을 계산한다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm run validate   # 무한 배플 피스톤 이론값과 비교 (PASS 확인)
```

## 구조

- `src/engine/scene.ts` — 씬(형상) 스키마. mm 단위 r-z 단면. rect/polygon, rigid/fabric/air, piston/radial 드라이버.
- `src/engine/rasterize.ts` — 씬 → 격자(고체 마스크, 흐름저항, 소스 면, 측정점).
- `src/engine/fdtd.ts` — 축대칭 FDTD 솔버(CPU). WGSL 포팅을 염두에 둔 단순 루프.
- `src/engine/analysis.ts` — 임펄스 응답 → 주파수 응답, 지향성.
- `src/engine/presets.ts` — 프리셋 씬(측면 방사형, 정면, 상향 360, 검증용 배플 피스톤).
- `src/worker/sim.worker.ts` — Web Worker 실행.
- `src/ui/` — 압력장 뷰, polar, 주파수 응답 차트.
- `scripts/validate.ts` — 솔버 검증.

## 모델링 메모

- 절대 SPL은 드라이버 데이터(T-S 파라미터, 진동판 속도)가 있어야 하며 현재는 정규화된 피스톤 소스 기준 상대 dB.
- 방사형 홀은 환형 슬릿으로 근사(축대칭). 이산 홀의 정확한 효과는 3D sector 해석이 필요.
- 패브릭은 흐름저항(σ, Pa·s/m²)을 가진 저항층으로 모델링.
- 좁은 틈의 열점성 손실은 미포함(틈 폭이 1 mm 이하로 내려가면 고려 필요).
- 흡수 경계는 sponge 층. 측정 원호는 흡수층에서 최소 60 mm 이상 떨어뜨릴 것.
