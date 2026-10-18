// 화면에 보일 상태를 정한다. 브라우저와 Node 테스트가 같이 쓴다.

// 연결 단계 실패(시간 초과·연결 실패)인지. 서버 오류(5xx)는 해외 차단과 무관하다.
export function isConnectFailure(result) {
  return Boolean(result?.reason) && (result.reason.startsWith('시간 초과') || result.reason.startsWith('연결 실패'));
}

// 해외 측정 위치에서, 해외 접속이 막힌 것으로 확인된 대상의 연결 실패만 '해외에서 닿지 않음'으로 부른다.
// 나머지(해외에서도 닿는 곳의 실패, 5xx)는 실제 장애일 수 있으므로 원래 판정을 그대로 보인다.
export function isOverseasUnreachable(loc, target, result) {
  return loc.scope === 'overseas' && Boolean(target.overseasBlocked) && isConnectFailure(result);
}

// 두 번 연속 실패해야 '응답 없음'
export function currentState(target, loc) {
  if (loc.stale) return { state: 'stale' };
  if (!loc.latest.valid) return { state: 'invalid' };
  const r = loc.latest.results.find((x) => x.id === target.id);
  if (!r) return { state: 'none' };
  if (r.status !== 'down') return { state: r.status, r };
  if (isOverseasUnreachable(loc, target, r)) return { state: 'unreachable', r };
  const runs = loc.history.runs;
  const prev = runs.length >= 2 ? runs[runs.length - 2].r[target.id] : null;
  return { state: prev && prev[0] === 'd' ? 'down' : 'flaky', r };
}

// 측정 중단 기준. GitHub 예약 실행은 30분 간격으로 걸어도 실제로는 몇 시간씩 밀리므로(2026-10-14~18 실측 중앙값 약 3.5시간)
// 고정값 대신 최근 측정 간격 중앙값의 3배를 쓴다. 최소 90분.
export function staleThresholdMs(runs) {
  const t = (runs || []).slice(-21).map((r) => new Date(r.t).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  return Math.max(90 * 60 * 1000, 3 * median);
}
