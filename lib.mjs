// 측정 결과 판정. 네트워크를 쓰지 않는 순수 함수만 둔다(테스트 대상).
import { createHash } from 'node:crypto';

export const STATUS = { UP: 'up', DOWN: 'down', RETIRED: 'retired', CHANGED: 'changed', DENIED: 'denied' };
export const HISTORY_DAYS = 7;

export function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

function tryJson(body) {
  try { return JSON.parse(body); } catch { return undefined; }
}

function matches(rule, body, json, httpStatus, location) {
  if (rule.any) return rule.any.some((r) => matches(r, body, json, httpStatus, location));
  if (rule.status !== undefined) {
    if (httpStatus !== rule.status) return false;
    if (rule.locationIncludes !== undefined) return String(location || '').includes(rule.locationIncludes);
    return true;
  }
  if (rule.bodyIncludes !== undefined) return body.includes(rule.bodyIncludes);
  if (rule.jsonPath !== undefined) {
    const v = getPath(json, rule.jsonPath);
    if (rule.equals !== undefined) return v === rule.equals;
    if (rule.exists) return v !== undefined && v !== null;
  }
  return false;
}

// 응답 첫 행의 필드 이름으로 만든 지문. 값과 타입은 보지 않는다(값이 가끔 null인 API에서 오탐이 나므로).
export function fingerprint(rows) {
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (!first || typeof first !== 'object') return null;
  return createHash('sha256').update(Object.keys(first).sort().join(',')).digest('hex').slice(0, 12);
}

// httpStatus: 숫자, body: 문자열, location: 리다이렉트 Location 헤더(없으면 null).
// 네트워크 오류는 classifyError로 따로 판정한다.
export function classify(target, httpStatus, body, location = null) {
  const json = tryJson(body);
  if (target.retired && matches(target.retired, body, json, httpStatus, location)) {
    return { status: STATUS.RETIRED, reason: '서비스가 없거나 폐기됐다는 응답' };
  }
  if (matches(target.expect, body, json, httpStatus, location)) {
    const result = { status: STATUS.UP, reason: target.level === 'L4' ? '샘플 데이터 정상' : '키 없음 응답 정상' };
    if (target.rows) result.fingerprint = fingerprint(getPath(json, target.rows));
    return result;
  }
  if (httpStatus >= 500) return { status: STATUS.DOWN, reason: `서버 오류 HTTP ${httpStatus}` };
  // 방화벽·호출 제한 등. 'API 개편'으로 오해하지 않게 따로 둔다.
  if ([401, 403, 429].includes(httpStatus)) return { status: STATUS.DENIED, reason: `접근 거부 HTTP ${httpStatus}` };
  return { status: STATUS.CHANGED, reason: `예상과 다른 응답 HTTP ${httpStatus}` };
}

export function classifyError(err) {
  // AbortSignal.timeout 오류는 name이 TimeoutError이고 code는 숫자 23이다.
  const code = err?.name === 'TimeoutError' ? 'TimeoutError' : (err?.cause?.code || err?.code || err?.name || 'ERROR');
  const timeout = ['TimeoutError', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ABORT_ERR'].includes(code);
  // 오류 메시지에는 요청 URL이 들어갈 수 있으므로 코드만 남긴다.
  return { status: STATUS.DOWN, reason: timeout ? '시간 초과' : `연결 실패 (${String(code).slice(0, 40)})` };
}

const SHORT = { up: 'u', down: 'd', retired: 'r', changed: 'c', denied: 'x' };

// 이력은 측정 위치별로 7일치만 남긴다. 한 회차 = { t, v(유효 여부), r: { id: [상태 한 글자, ms] } }
export function appendHistory(history, latest, now = new Date(latest.measuredAt)) {
  const run = { t: latest.measuredAt, v: latest.valid ? 1 : 0, r: {} };
  for (const r of latest.results) run.r[r.id] = [SHORT[r.status], r.ms];
  const cutoff = now.getTime() - HISTORY_DAYS * 24 * 3600 * 1000;
  const runs = [...(history?.runs || []), run].filter((x) => new Date(x.t).getTime() >= cutoff);
  return { location: latest.location, runs };
}

// 지난 결과와 필드 지문이 다르면 변경 시각을 기록한다.
// 이번 회차에 지문이 없으면(실패 등) 지난 지문을 그대로 이어 받아, 복구 후에 바뀐 구조도 잡는다.
export function carrySchema(prev, results, measuredAt) {
  const prevById = new Map((prev?.results || []).map((r) => [r.id, r]));
  return results.map((r) => {
    const p = prevById.get(r.id);
    const changedAt = p?.schemaChangedAt ?? null;
    if (!r.fingerprint) return p?.fingerprint ? { ...r, fingerprint: p.fingerprint, fingerprintCarried: true, schemaChangedAt: changedAt } : { ...r, schemaChangedAt: changedAt };
    if (p?.fingerprint && p.fingerprint !== r.fingerprint) return { ...r, schemaChangedAt: measuredAt };
    return { ...r, schemaChangedAt: changedAt };
  });
}

// 측정 위치 목록: id 순으로 정렬해 회차마다 순서가 뒤집히지 않게 한다.
export function upsertLocation(locations, entry) {
  return [...(locations || []).filter((l) => l.id !== entry.id), entry].sort((a, b) => a.id.localeCompare(b.id));
}
