// 상태판 렌더링. 데이터는 같은 저장소의 data/ 아래 JSON만 읽는다.
import { currentState, staleThresholdMs, isOverseasUnreachable } from './state.js';

const LABEL = {
  up: '응답함', flaky: '일시 실패', down: '응답 없음', changed: '형식 변경', retired: '폐기됨', denied: '접근 거부',
  unreachable: '이 위치에서 닿은 적 없음', stale: '측정 중단', invalid: '측정 무효', none: '측정 없음',
};
const LONG = { u: 'up', d: 'down', s: 'down', r: 'retired', c: 'changed', x: 'denied' };
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
    // 이 해외 위치에서 한 번도 닿지 않은 대상의 실패 칸은 회색으로 그린다.
    if (cls === 'down' && isOverseasUnreachable(loc, target)) cls = 'unreachable';
    const cell = el('i', null, cls);
    cell.title = `${kst(run.t)} ${run.v ? (LABEL[cls] ?? '-') : '측정 무효 회차'}${v ? ` ${v[1]}ms` : ''}`;
    wrap.append(cell);
  }
  return wrap;
}

// 같은 게이트웨이(apis.data.go.kr)를 거치는 서비스들은 키 없이 재면 같은 신호를 낸다. 한 행으로 묶고,
// 서비스별로 다른 것(폐기·형식 변경 등)만 따로 적는다.
const GATEWAY = '공공데이터포털 게이트웨이';

// 묶은 서비스들 중 가장 많은 상태(동률이면 '응답함'이 아닌 쪽)를 대표로 쓴다.
function gatewayStates(members, loc) {
  const states = members.map((t) => ({ t, ...currentState(t, loc) }));
  const count = new Map();
  for (const x of states) count.set(x.state, (count.get(x.state) || 0) + 1);
  const major = [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] === 'up') - (b[0] === 'up'))[0][0];
  return { states, major };
}

function gatewayCell(members, loc) {
  const { states, major } = gatewayStates(members, loc);
  const rep = states.find((x) => x.state === major).t;
  const td = cell(rep, loc);
  const up = states.filter((x) => x.state === 'up').length;
  const odd = states.filter((x) => x.state !== major);
  td.append(el('div', `서비스 ${members.length}개 중 ${up}개 응답함`, 'up7'));
  for (const x of odd) td.append(el('div', `${x.t.name}: ${LABEL[x.state]}`, 'reason'));
  return td;
}

// 표 위 한 줄 요약(측정 위치마다). 게이트웨이는 대표 1개로 세고, 대표와 다른 서비스 상태(폐기 등)는 따로 센다.
function summaryLine(rows, gateway, loc) {
  const count = new Map();
  const add = (s) => count.set(s, (count.get(s) || 0) + 1);
  for (const t of rows) add(currentState(t, loc).state);
  if (gateway.length) {
    const { states, major } = gatewayStates(gateway, loc);
    add(major);
    for (const x of states) if (x.state !== major) add(x.state);
  }
  const order = ['up', 'flaky', 'down', 'unreachable', 'denied', 'changed', 'retired', 'stale', 'invalid', 'none'];
  return order.filter((k) => count.get(k)).map((k) => `${LABEL[k]} ${count.get(k)}`).join(' · ');
}

function cell(target, loc) {
  const td = el('td');
  const { state, r } = currentState(target, loc);
  td.append(el('span', LABEL[state], `badge ${state}`));
  if (r && state !== 'stale') td.append(el('span', ` ${r.ms.toLocaleString('ko-KR')}ms`, 'ms'));
  const u = uptime(target.id, loc.history.runs);
  td.append(el('div', u ? `최근 ${u.n}회 중 ${Math.round((u.pct * u.n) / 100)}회 응답` : '이력 없음', 'up7'));
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

  // 게이트웨이 서비스는 대표 1행으로 센다
  const gateway = targets.targets.filter((t) => t.group === GATEWAY);
  const rows = targets.targets.filter((t) => t.group !== GATEWAY);
  $('summary').textContent = locs.map((l) => `${l.label} — ${summaryLine(rows, gateway, l)}`).join(' / ');

  const head = el('tr');
  head.append(el('th', 'API'), el('th', '단계'));
  for (const l of locs) head.append(el('th', l.label));
  $('board-head').replaceChildren(head);

  const body = $('board-body');
  body.replaceChildren();
  if (gateway.length) {
    const tr = el('tr', null, 'group');
    const th = el('th', GATEWAY);
    th.colSpan = 2 + locs.length;
    tr.append(th);
    body.append(tr);
    const row = el('tr');
    const name = el('td');
    name.append(el('div', 'apis.data.go.kr', 'name'),
      el('div', `대표 서비스 ${gateway.length}개로 확인: ${gateway.map((t) => t.name).join(', ')}. 키 없이는 서비스별 상태가 아니라 게이트웨이 상태와 폐기 여부만 보입니다.`, 'org'));
    row.append(name, el('td', 'L2', 'level'));
    for (const l of locs) row.append(gatewayCell(gateway, l));
    body.append(row);
  }
  let group = null;
  for (const t of targets.targets.filter((x) => x.group !== GATEWAY)) {
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
