#!/bin/sh
# DB 백업. postgres:15-alpine 이미지를 그대로 재사용해서 도는 사이드카.
#
#   기본     : 매일 BACKUP_HOUR 시 05분에 한 번 (컨테이너 TZ 기준)
#   즉시 1회 : sh /backup.sh once
#
# 형식은 pg_dump -Fc (커스텀). 압축돼 있고 pg_restore 로 테이블 단위 복구도 된다.
# 로그는 stdout 으로만 남긴다 — docker logs bandroom_dbbackup 에서 본다.
set -eu

DIR=${BACKUP_DIR:-/backups}
KEEP=${BACKUP_KEEP_DAYS:-14}
HOUR=${BACKUP_HOUR:-4}

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') backup: $*"; }

backup_once() {
    stamp=$(date '+%Y-%m-%d_%H%M')
    out="$DIR/${PGDATABASE}-${stamp}.dump"

    # 먼저 .part 로 쓰고 다 되면 옮긴다. 도중에 죽어도 반쪽 파일이
    # 멀쩡한 백업인 척 남지 않는다.
    if ! pg_dump -Fc -f "$out.part"; then
        log "FAILED pg_dump ($PGDATABASE)"
        rm -f "$out.part"
        return 1
    fi

    # 목록을 읽어보지 못하면 복구도 못 한다. 여기서 걸러야 의미가 있다.
    if ! pg_restore --list "$out.part" >/dev/null 2>&1; then
        log "FAILED 손상된 덤프 (pg_restore --list 실패)"
        rm -f "$out.part"
        return 1
    fi

    mv "$out.part" "$out"
    log "OK $(basename "$out") ($(wc -c < "$out") bytes)"

    # 백업이 성공했을 때만 옛것을 지운다.
    old=$(find "$DIR" -maxdepth 1 -type f -name "${PGDATABASE}-*.dump" -mtime "+$KEEP" 2>/dev/null || true)
    if [ -n "$old" ]; then
        echo "$old" | while IFS= read -r f; do
            rm -f "$f" && log "지움 $(basename "$f") (${KEEP}일 초과)"
        done
    fi
}

mkdir -p "$DIR"

if [ "${1:-}" = "once" ]; then
    backup_once
    exit $?
fi

log "매일 ${HOUR}시 05분에 백업 · ${KEEP}일 보관 · $DIR"
while true; do
    # 다음 실행까지 몇 초 남았나. awk 로 세는 이유는 "08" 같은 값이
    # sh 산술에서 8진수로 읽히기 때문이다.
    now=$(date '+%H:%M:%S' | awk -F: '{print ($1*3600)+($2*60)+$3}')
    target=$(( HOUR * 3600 + 300 ))
    wait=$(( target - now ))
    [ "$wait" -le 0 ] && wait=$(( wait + 86400 ))
    sleep "$wait"
    backup_once || true   # 한 번 실패해도 루프는 계속 돈다
done
