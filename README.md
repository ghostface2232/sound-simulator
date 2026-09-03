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

## 검증과 진단

- `npm test` — 씬 검증·수치 설정 경고 조건 단위 테스트.
- `npm run validate` — 무한 배플 피스톤 이론 비교(dx 1 mm 기준 0.75 dB 이내) + 격자 수렴 검사(dx 2 → 1.5 → 1 mm). 기준 미달 시 exit code 1.
- `npm run check` — 타입 검사 + 테스트 + 검증 일괄 실행.
- UI는 실행 전에 씬 구조(음수·0 치수, 영역 밖 드라이버·측정점), 파장당 셀 수, 측정 원호와 흡수층 거리,
  fMin 대비 필요한 해석 시간, Courant 수를 검사한다. 오류가 있으면 실행 버튼이 잠긴다.
- 해석 시간으로 신뢰할 수 없는 저주파(첫 도달 이후 3주기 미만)는 결과에서 잘라낸다.
- 실행 후 종료 시점 신호가 피크 대비 -30 dB 위에 남아 있으면 감쇠 부족 경고를 낸다.

## 현재 물리 모델의 한계

- 2D 축대칭이므로 모든 측면 홀은 원주 전체에 열린 환형 슬롯으로 해석된다. 이산 홀, 슬롯 개수,
  비대칭 구조, 원주 방향 간섭은 계산하지 못한다 (3D sector 해석이 필요).
- 절대 SPL이 아니라 정규화된 피스톤 소스 기준 상대 dB. Thiele–Small, 진동판 분할진동,
  구조–음향 연성은 없다. 드라이버는 지정 속도의 hard piston source.
- 흡수 경계는 PML이 아닌 sponge 층. 파장이 흡수층 두께보다 훨씬 긴 저주파(수백 Hz 이하)에서는
  잔류 반사가 있다.
- 패브릭은 흐름저항(σ, Pa·s/m²) 셀로 근사한다. 다공성 매질의 주파수 의존 임피던스는 아니다.
- 좁은 틈의 열점성 손실은 미포함 (틈 폭이 1 mm 이하로 내려가면 무시할 수 없다).
- 형상은 격자에 계단식으로 올라간다. 곡면 리플렉터는 dx 를 줄여야 정확해진다 (수렴 검사 참고).
- STEP/STL/CAD 입력, 파라미터 기반 리플렉터 최적화, 전용 형상 편집 UI는 아직 없다.
