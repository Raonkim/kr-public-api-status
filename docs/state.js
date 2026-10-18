// 화면에 보일 상태를 정한다. 브라우저와 Node 테스트가 같이 쓴다.

// 이 측정 위치에서 최근 유효 회차(최대 20회)에 한 번도 성공하지 못한 대상인지.
// 다른 곳에서 잰 '해외 차단 목록'은 측정 위치(클라우드)마다 맞지 않았으므로, 그 위치의 이력으로만 판단한다.
// 평소 닿던 곳의 실패는 여기에 걸리지 않아 '응답 없음'으로 그대로 보인다.
export function neverReachedHere(targetId, runs, minRuns = 6) {
  const recent = (runs || []).filter((r) => r.v && r.r[targetId]).slice(-20);
  return recent.length >= minRuns && recent.every((r) => r.r[targetId][0] !== 'u');
}

export function isOverseasUnreachable(loc, target) {
  return loc.scope === 'overseas' && neverReachedHere(target.id, loc.history?.runs);
}

// 두 번 연속 실패해야 '응답 없음'
export function currentState(target, loc) {
  if (loc.stale) return { state: 'stale' };
  if (!loc.latest.valid) return { state: 'invalid' };
  const r = loc.latest.results.find((x) => x.id === target.id);
  if (!r) return { state: 'none' };
  if (r.status !== 'down') return { state: r.status, r };
  if (isOverseasUnreachable(loc, target)) return { state: 'unreachable', r };
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
