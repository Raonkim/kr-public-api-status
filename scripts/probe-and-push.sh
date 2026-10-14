#!/usr/bin/env bash
# 국내 측정 위치(예: Oracle Cloud 서울 리전 VM)에서 cron으로 돌린다.
#   7,37 * * * * /home/ubuntu/kr-public-api-status/scripts/probe-and-push.sh >> /home/ubuntu/probe.log 2>&1
# 준비: 이 저장소 전용 deploy key(쓰기 권한)를 VM에 두고 SSH로 clone한다. 개인 계정 토큰은 쓰지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."

LOCATION="${PROBE_LOCATION:-oracle-kr}"
LABEL="${PROBE_LABEL:-국내 클라우드 (Oracle 서울)}"

# 지난 회차가 충돌로 rebase 중간에 멈췄어도 다음 회차는 깨끗한 상태에서 시작한다.
git rebase --abort >/dev/null 2>&1 || true
git fetch --quiet origin
git reset --hard --quiet origin/main

node probe.mjs --location "$LOCATION" --scope domestic --label "$LABEL"
git add docs/data
if git diff --cached --quiet; then exit 0; fi
# 귀속되지 않는 주소를 쓴다(<login>@users.noreply.github.com 형식은 그 계정으로 연결된다).
git -c user.name="status-bot" -c user.email="status-bot@invalid" \
  commit --quiet -m "data: $LOCATION $(date -u +%Y-%m-%dT%H:%MZ)"
for i in 1 2 3; do
  if git pull --rebase --quiet && git push --quiet; then exit 0; fi
  git rebase --abort >/dev/null 2>&1 || true
  sleep 5
done
exit 1
