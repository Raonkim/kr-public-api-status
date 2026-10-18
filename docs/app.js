// 상태판 렌더링. 데이터는 같은 저장소의 data/ 아래 JSON만 읽는다.
import { currentState, staleThresholdMs } from './state.js';

const LABEL = {
  up: '응답함', flaky: '일시 실패', down: '응답 없음', changed: '형식 변경', retired: '폐기됨', denied: '접근 거부',
  unreachable: '해외에서 닿지 않음', stale: '측정 중단', invalid: '측정 무효', none: '측정 없음',
};
const LONG = { u: 'up', d: 'down', r: 'retired', c: 'changed', x: 'denied' };
const SPARK = 48; // 최근 48회

const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

function kst(iso) {
  return new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });
}

function uptime(id, runs) {
  const valid = runs.filter((x) => x.v && x.r[id]);
  if (valid.length === 0) return null;
  const up = valid.filter((x) => x.r[id][0] === 'u').length;
  return { pct: (up / valid.length) * 100, n: valid.length };
}

function spark(target, loc) {
  const id = target.id;
  const wrap = el('span', null, 'spark');
  wrap.setAttribute('aria-hidden', 'true');
  for (const run of loc.history.runs.slice(-SPARK)) {
    const v = run.r[id];
    let cls = !run.v ? 'invalid' : v ? LONG[v[0]] : 'none';
    // 이력에는 실패 원인이 없어, 해외 차단 대상의 실패 칸은 모두 회색으로 그린다.
    if (cls === 'down' && loc.scope === 'overseas' && target.overseasBlocked) cls = 'unreachable';
    const cell = el('i', null, cls);
    cell.title = `${kst(run.t)} ${run.v ? (LABEL[cls] ?? '-') : '측정 무효 회차'}${v ? ` ${v[1]}ms` : ''}`;
    wrap.append(cell);
  }
  return wrap;
}

function cell(target, loc) {
  const td = el('td');
  const { state, r } = currentState(target, loc);
  td.append(el('span', LABEL[state], `badge ${state}`));
  if (r && state !== 'stale') td.append(el('span', ` ${r.ms.toLocaleString('ko-KR')}ms`, 'ms'));
  const u = uptime(target.id, loc.history.runs);
  const word = loc.scope === 'overseas' ? '도달률' : '응답률';
  td.append(el('div', u ? `7일 ${word} ${u.pct.toFixed(1)}% (${u.n}회)` : '이력 없음', 'up7'));
  td.append(spark(target, loc));
  if (r?.reason && state !== 'up' && state !== 'stale') td.append(el('div', r.reason, 'reason'));
  if (r?.schemaChangedAt) td.append(el('div', `구조 변경 ${kst(r.schemaChangedAt)}`, 'reason'));
  return td;
}

async function main() {
  const [targets, locations] = await Promise.all([getJson('data/targets.json'), getJson('data/locations.json')]);
  const locs = [];
  for (const l of locations) {
    try {
      const [latest, history] = await Promise.all([getJson(`data/${l.id}/latest.json`), getJson(`data/${l.id}/history.json`)]);
      const stale = Date.now() - new Date(latest.measuredAt).getTime() > staleThresholdMs(history.runs);
      locs.push({ ...l, scope: latest.scope || l.scope, latest, history, stale });
    } catch { /* 아직 측정 기록이 없는 위치는 건너뛴다 */ }
  }
  if (locs.length === 0) { $('updated').textContent = '아직 측정 기록이 없습니다.'; return; }

  $('updated').textContent = locs.map((l) => {
    let s = `${l.label}: 마지막 측정 ${kst(l.latest.measuredAt)}`;
    if (l.stale) s += ' (측정이 멈춘 상태입니다. 아래 상태는 현재가 아닙니다)';
    else if (!l.latest.valid) s += ' (측정 쪽 회선 문제로 이번 회차는 무효)';
    return s;
  }).join(' · ');
  $('overseas-only').hidden = !locs.every((l) => l.scope === 'overseas');

  const head = el('tr');
  head.append(el('th', 'API'), el('th', '단계'));
  for (const l of locs) head.append(el('th', l.label));
  $('board-head').replaceChildren(head);

  const body = $('board-body');
  body.replaceChildren();
  let group = null;
  for (const t of targets.targets) {
    if (t.group !== group) {
      group = t.group;
      const tr = el('tr', null, 'group');
      const th = el('th', group);
      th.colSpan = 2 + locs.length;
      tr.append(th);
      body.append(tr);
    }
    const tr = el('tr');
    const name = el('td');
    name.append(el('div', t.name, 'name'), el('div', t.org, 'org'));
    tr.append(name, el('td', t.level, 'level'));
    for (const l of locs) tr.append(cell(t, l));
    body.append(tr);
  }
}

main().catch(() => { $('updated').textContent = '측정 결과를 불러오지 못했습니다.'; });
