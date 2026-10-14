import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classify, classifyError, appendHistory, carrySchema, fingerprint, getPath, upsertLocation,
} from './lib.mjs';

const config = JSON.parse(readFileSync(new URL('./targets.json', import.meta.url), 'utf8'));
const T = Object.fromEntries(config.targets.map((t) => [t.id, t]));

// 실측 응답 본문(2026-10-10~11, 한국 회선)
const GW_NOKEY = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE_KEY_IS_NULL</errMsg><returnReasonCode>20</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
const GW_RETIRED = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>NO_OPENAPI_SERVICE_ERROR</errMsg><returnReasonCode>12</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
const NEIS_OK = JSON.stringify({ schoolInfo: [{ head: [{ list_total_count: 1 }, { RESULT: { CODE: 'INFO-000' } }] }, { row: [{ SCHUL_NM: 'x', SD_SCHUL_CODE: '1' }] }] });
const NEIS_ERR = JSON.stringify({ RESULT: { CODE: 'ERROR-290', MESSAGE: '인증키가 유효하지 않습니다.' } });

test('모든 대상에 필수 필드가 있고 id가 겹치지 않는다', () => {
  const ids = new Set();
  for (const t of config.targets) {
    assert.ok(t.id && t.name && t.org && t.url && t.expect && t.level, t.id);
    assert.ok(!ids.has(t.id), `중복 id ${t.id}`);
    ids.add(t.id);
    assert.ok(!/servicekey=[^&]+|crtfc_key=[^&]+|[?&]key=[^&]+/i.test(t.url), `키가 URL에 들어 있음: ${t.id}`);
  }
  assert.ok(!/\.(go|or)\.kr/.test(config.networkCheck.url), '회선 확인은 한국 공공기관과 무관한 곳이어야 함');
});

test('게이트웨이: 키 없음 응답은 up, 폐기 응답은 retired, 5xx는 down, 그 밖은 changed', () => {
  assert.equal(classify(T['holiday'], 401, GW_NOKEY).status, 'up');
  assert.equal(classify(T['holiday'], 400, GW_RETIRED).status, 'retired');
  assert.equal(classify(T['holiday'], 502, '<html>Bad Gateway</html>').status, 'down');
  assert.equal(classify(T['holiday'], 200, '<html>점검 중</html>').status, 'changed');
});

test('샘플 데이터 대상은 필드 지문을 남긴다', () => {
  const r = classify(T['neis-school'], 200, NEIS_OK);
  assert.equal(r.status, 'up');
  assert.match(r.fingerprint, /^[0-9a-f]{12}$/);
  assert.equal(classify(T['neis-school'], 200, NEIS_ERR).status, 'changed');
});

test('DART는 302 + /error.html 또는 status 100이면 응답함', () => {
  assert.equal(classify(T['dart'], 302, '', '/error.html').status, 'up');
  assert.equal(classify(T['dart'], 302, '', '/maintenance.html').status, 'changed');
  assert.equal(classify(T['dart'], 200, '{}').status, 'changed');
  assert.equal(classify(T['dart'], 200, '{"status":"100","message":"인증키가 누락되었습니다."}').status, 'up');
});

test('KOSIS의 비표준 JSON 응답도 판정한다', () => {
  assert.equal(classify(T['kosis'], 200, '{err:"10",errMsg:"인증KEY값이 누락되었습니다."}').status, 'up');
});

test('네트워크 오류는 down이고 URL을 남기지 않는다', () => {
  const timeout = classifyError(Object.assign(new Error('x'), { name: 'TimeoutError', code: 23 }));
  assert.deepEqual(timeout, { status: 'down', reason: '시간 초과' });
  const refused = classifyError(Object.assign(new TypeError('fetch failed https://a?serviceKey=SECRET'), { cause: { code: 'ECONNREFUSED' } }));
  assert.equal(refused.reason, '연결 실패 (ECONNREFUSED)');
  assert.ok(!JSON.stringify(refused).includes('SECRET'));
});

test('401·403·429 불일치는 접근 거부로 따로 본다', () => {
  assert.equal(classify(T['kosis'], 403, '<html>Access Denied</html>').status, 'denied');
  assert.equal(classify(T['kosis'], 429, 'Too Many').status, 'denied');
  assert.equal(classify(T['holiday'], 401, GW_NOKEY).status, 'up');
});

test('좁힌 서명: 본문 어딘가에 숫자만 있어서는 응답함이 아니다', () => {
  assert.equal(classify(T['its'], 403, '<html>request id 4005</html>').status, 'denied');
  assert.equal(classify(T['its'], 401, '{"header":{"resultCode":4005}}').status, 'up');
});

test('측정 위치 목록은 id 순으로 고정된다', () => {
  const a = upsertLocation([{ id: 'oracle-kr' }], { id: 'github-actions' });
  const b = upsertLocation(a, { id: 'oracle-kr', label: 'x' });
  assert.deepEqual(a.map((l) => l.id), ['github-actions', 'oracle-kr']);
  assert.deepEqual(b.map((l) => l.id), ['github-actions', 'oracle-kr']);
});

test('이력은 7일치만 남긴다', () => {
  const old = { runs: [{ t: '2026-10-01T00:00:00Z', v: 1, r: {} }, { t: '2026-10-09T00:00:00Z', v: 1, r: {} }] };
  const latest = { location: 'x', measuredAt: '2026-10-11T00:00:00Z', valid: true, results: [{ id: 'a', status: 'up', ms: 10 }] };
  const h = appendHistory(old, latest);
  assert.deepEqual(h.runs.map((r) => r.t), ['2026-10-09T00:00:00Z', '2026-10-11T00:00:00Z']);
  assert.deepEqual(h.runs[1].r.a, ['u', 10]);
});

test('필드 지문이 바뀌면 변경 시각을 남기고, 다음 회차에도 유지한다', () => {
  const prev = { results: [{ id: 'a', fingerprint: 'aaa', schemaChangedAt: null }] };
  const now = carrySchema(prev, [{ id: 'a', fingerprint: 'bbb' }], 'T1');
  assert.equal(now[0].schemaChangedAt, 'T1');
  const later = carrySchema({ results: now }, [{ id: 'a', fingerprint: 'bbb' }], 'T2');
  assert.equal(later[0].schemaChangedAt, 'T1');
  // 실패 회차를 지나도 지난 지문을 이어 받아, 복구 후 바뀐 구조를 잡는다
  const failed = carrySchema({ results: later }, [{ id: 'a', status: 'down' }], 'T3');
  assert.equal(failed[0].fingerprint, 'bbb');
  const back = carrySchema({ results: failed }, [{ id: 'a', fingerprint: 'ccc' }], 'T4');
  assert.equal(back[0].schemaChangedAt, 'T4');
});

test('fingerprint는 값이 아니라 필드 구조만 본다', () => {
  assert.equal(fingerprint([{ a: 1, b: 'x' }]), fingerprint([{ b: 'y', a: 2 }]));
  assert.equal(fingerprint([{ a: null }]), fingerprint([{ a: 1.5 }]));
  assert.notEqual(fingerprint([{ a: 1 }]), fingerprint([{ a: 1, b: 2 }]));
  assert.equal(fingerprint([]), null);
  assert.equal(getPath({ a: [{ b: 3 }] }, 'a.0.b'), 3);
});

test('해외 측정: 해외 차단 대상의 연결 실패만 해외에서 닿지 않음, 나머지는 원래 판정', async () => {
  const { currentState } = await import('./docs/state.js');
  const loc = (results, scope = 'overseas') => ({
    scope, stale: false, latest: { valid: true, results },
    history: { runs: [{ r: { [results[0].id]: ['d', 1] } }, { r: { [results[0].id]: ['d', 1] } }] },
  });
  const timeout = (id) => [{ id, status: 'down', reason: '시간 초과' }];
  assert.equal(currentState(T['holiday'], loc(timeout('holiday'))).state, 'unreachable');
  assert.equal(currentState(T['neis-school'], loc(timeout('neis-school'))).state, 'down'); // 해외에서도 닿는 곳
  assert.equal(currentState(T['holiday'], loc([{ id: 'holiday', status: 'down', reason: '서버 오류 HTTP 502' }])).state, 'down'); // 5xx
  assert.equal(currentState(T['holiday'], loc(timeout('holiday'), 'domestic')).state, 'down'); // 국내 측정
  assert.ok(T['neis-school'].overseasBlocked === undefined && T['holiday'].overseasBlocked === true);
});
