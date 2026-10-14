#!/usr/bin/env node
// 사용법: node probe.mjs --location github-actions --scope overseas --label "GitHub Actions (해외 클라우드)"
// --scope: overseas(한국 밖) | domestic(한국 안). 화면이 해외 측정의 '닿지 않음'을 장애와 구분해 보이는 데 쓴다.
// 결과: docs/data/<location>/latest.json, history.json
// 인증키를 쓰지 않는다. 응답 본문은 저장하지 않고 판정 결과·응답시간·필드 지문만 남긴다.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, classifyError, appendHistory, carrySchema, upsertLocation } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 15000;
const MAX_BODY = 200_000;
const CONCURRENCY = 4;
// 헤더 값은 ASCII만 허용된다.
const USER_AGENT = 'kr-public-api-status/1.0 (+https://github.com/Raonkim/kr-public-api-status; every 30min, no API key)';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function probe(target) {
  const started = performance.now();
  try {
    const res = await fetch(target.url, {
      method: target.method || 'GET',
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      body: target.method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.text()).slice(0, MAX_BODY);
    const ms = Math.round(performance.now() - started);
    return { id: target.id, http: res.status, ms, ...classify(target, res.status, body, res.headers.get('location')) };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    return { id: target.id, http: null, ms, ...classifyError(err) };
  }
}

async function runAll(targets) {
  const results = new Array(targets.length);
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const i = next++;
      results[i] = await probe(targets[i]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

// 측정하는 쪽 회선이 살아 있는지. 한국 공공기관과 무관한 곳으로 확인해야
// 전국 단위 장애가 '측정 무효'로 지워지지 않는다.
async function networkOk(check) {
  if (!check) return true;
  try {
    const res = await fetch(check.url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer();
    return res.status === check.status;
  } catch { return false; }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function main() {
  const location = arg('location');
  const label = arg('label', location);
  const scope = arg('scope', 'domestic');
  if (!['overseas', 'domestic'].includes(scope)) { console.error('--scope 는 overseas 또는 domestic'); process.exit(2); }
  if (!location || !/^[a-z0-9-]{2,40}$/.test(location)) {
    console.error('--location 은 영문 소문자·숫자·하이픈 2~40자로 주세요.');
    process.exit(2);
  }
  const config = JSON.parse(await readFile(join(here, 'targets.json'), 'utf8'));
  const outDir = join(here, 'docs', 'data', location);
  await mkdir(outDir, { recursive: true });

  const measuredAt = new Date().toISOString();
  const prev = await readJson(join(outDir, 'latest.json'));
  const valid = await networkOk(config.networkCheck);
  const raw = await runAll(config.targets);
  const results = carrySchema(prev, raw, measuredAt);
  const latest = { location, label, scope, measuredAt, valid, results };
  const history = appendHistory(await readJson(join(outDir, 'history.json')), latest);

  await writeFile(join(outDir, 'latest.json'), JSON.stringify(latest, null, 1) + '\n');
  await writeFile(join(outDir, 'history.json'), JSON.stringify(history) + '\n');

  // 페이지가 읽는 대상 목록과 측정 위치 목록
  const dataDir = join(here, 'docs', 'data');
  await writeFile(join(dataDir, 'targets.json'), JSON.stringify(config, null, 1) + '\n');
  const locations = upsertLocation(await readJson(join(dataDir, 'locations.json')), { id: location, label, scope });
  await writeFile(join(dataDir, 'locations.json'), JSON.stringify(locations, null, 1) + '\n');

  const up = results.filter((r) => r.status === 'up').length;
  console.log(`${measuredAt} ${location}: ${up}/${results.length} 응답함, 유효 회차=${latest.valid}`);
  for (const r of results) console.log(`  ${r.status.padEnd(7)} ${String(r.ms).padStart(6)}ms  ${r.id}  ${r.reason}`);
}

main().catch((e) => { console.error('측정 실패:', e?.name || 'Error'); process.exit(1); });
