# Band Room — 합주실 예약 + 밴드 운영 시스템

FastAPI + vanilla JS + PostgreSQL 기반 소규모 앱. 합주실/개인연습실 예약(사용자 신청 → 관리자 입금 확인 후 확정)에 더해, 관리자 전용으로 팀 관리 · 도어즈 멤버 관리 · 월회비 정산 · 온라인 티켓 제작을 다룬다.

## 스택
- **Backend**: FastAPI 0.109, SQLAlchemy 2.0, Pydantic 2, bcrypt, sse-starlette
- **DB**: PostgreSQL 15 (psycopg2)
- **Frontend**: Vanilla JS + CSS (빌드 없음), `/static`으로 서빙
- **Container**: docker-compose (app + db + pgadmin)
- **배포**: 주 타깃은 시놀로지 DS218+ Container Manager. `docker compose v2` 환경.

## 실행
```bash
docker compose up -d --build
```
**비밀값은 전부 `.env`에서 온다.** 처음 받았으면 `cp .env.example .env` 후 값을 채운다.
값이 비면 compose 가 `:?` 로 즉시 실패한다.

접속:
- 예약 페이지: `http://localhost:8010/`
- 관리자: `http://localhost:8010/admin` (예약 페이지에 링크 없음 — URL 직접 입력)
- 공개 티켓: `http://localhost:8010/t/{slug}`
- pgadmin: `http://127.0.0.1:5050` (계정은 `.env`)
- DB: `127.0.0.1:5433` (loopback 전용, 내부는 5432)

운영: 시놀로지 DSM 내장 역방향 프록시 → `LAN IP:8010`. 공유기는 80/443만 포워딩.
앱 포트만 0.0.0.0 바인딩(프록시가 붙어야 함), DB·pgadmin 은 loopback.

코드 변경 후 앱만 재빌드: `docker compose up -d --build app`
스모크 테스트: `docker exec bandroom_app python test_smoke.py`

## 디렉토리
```
backend/
  main.py           # 앱 생성 · 미들웨어 · 페이지 라우트 · migrate_schema · init_data
  deps.py           # 비밀번호 헬퍼 · 인증 의존성 · app_settings 접근
  routers/          # 도메인별 APIRouter
    auth.py  reservations.py  admin_users.py  inquiries.py  blocked.py
    teams.py  members.py  dues.py  tickets.py  settings.py
  models.py         # SQLAlchemy 모델
  schemas.py        # Pydantic 스키마
  database.py       # 엔진 · SessionLocal · get_db
  broadcaster.py    # SSE용 asyncio.Queue 팬아웃
  app_logging.py    # bandroom 로거 (stream + rotating file)
  test_smoke.py     # 실행 중인 앱 대상 E2E 스모크 (프레임워크 없음)
  logs/             # docker-compose 볼륨 마운트 (app.log, 런타임 생성)
frontend/
  index.html  app.js        # 사용자 예약 페이지
  admin.html                # 관리자 셸 (모든 페이지 마크업)
  admin/                    # 페이지별 JS — core.js 먼저 로드
    core.js reservations.js ops.js teams.js members.js dues.js tickets.js users.js settings.js
  favicon.svg               # 문 모양 파비콘 (세 페이지 공용)
  ticket.html  ticket.js    # 공개 티켓 페이지 (/t/{slug})
  ticket-render.js          # 티켓 렌더 — 에디터·공개 페이지 공용
  style.css                 # 공용 스타일 (모바일 우선, 데스크탑은 phone-frame)
uploads/            # 티켓 배경 이미지 (볼륨 마운트, git 제외)
docker-compose.yml
```

## 아키텍처 요점

### 인증 (관리자만 존재, 일반 사용자는 로그인 없음)
- 토큰 기반. `X-Auth-Token` 헤더로 전달, 서버는 `admin_sessions`에서 조회
- **세션 12시간 만료 + 슬라이딩 갱신** (`deps.SESSION_TTL`). 남은 시간이 절반 아래일 때만 UPDATE
- **로그인 실패 5회/5분 → 429** (`routers/auth.py`의 인메모리 dict, 단일 프로세스 전제)
- 두 단계 의존성 (`deps.py`):
  - `get_current_admin_raw`: 인증만 확인 (비밀번호 변경 엔드포인트용)
  - `get_current_admin`: 추가로 `must_change_password` 체크, true면 403
- 역할: `system` (전체) / `reservation` (예약만). `require_system_admin` 의존성으로 분리
- system 전용 페이지: 차단 설정 · 계정 관리 · 환경 설정 (`core.js::SYSTEM_ONLY_PAGES`)
- 초기 계정: `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`. **비밀번호 기본값은 코드에 없다** —
  값이 없으면 무작위 생성 후 로그에 한 번 남기고 `must_change_password=True` 로 만든다.
  admin_users 가 비어 있을 때만 동작한다 (비밀번호 초기화 용도 아님)

### 예약 상태 플로우
- 사용자가 `POST /api/reservations` → `status='pending'`으로 저장
- 관리자가 입금 확인 후 `POST /api/reservations/{id}/confirm` → `status='confirmed'`
- 슬롯 충돌 검사는 상태 무관 (pending도 슬롯을 점유)
- **자정 넘김 예약**: 23시에 3시간을 고르면 서버가 `_split_by_day()`로 날짜별 두 건(23~24시 / 0~2시)으로 나눠 저장하고 `group_key`로 묶는다. 확정·취소는 `_group_rows()`로 짝을 함께 처리. 날짜별 타임라인·겹침 검사는 그대로 동작. 프론트는 종료 시각을 다음날 `OVERNIGHT_END`(6시)까지 고를 수 있고, 다음날 예약·차단도 같이 조회해 미리 막는다
- **팀은 등록된 활성 팀에서만 선택** — `team_id` 필수. 서버가 `team_name`을 스냅샷으로 채운다
- 요금은 `rooms.hourly_price`, 입금 계좌는 `app_settings`에서 온다 (프론트 하드코딩 없음)

### 팀 · 멤버 · 정산
- `teams.billing_type` 세 가지 — 예약 확정 흐름과 정산이 여기서 갈린다:
  | 값 | 뜻 | 예약 | 정산 |
  |---|---|---|---|
  | `hourly` | 쓸 때마다 시간당 | `pending` → 관리자 확정 | 매출에 합산 |
  | `monthly` | 팀이 월 이용료 일괄 (`monthly_fee`) | 즉시 `confirmed` | 건별 0원 |
  | `dues` | 멤버가 각자 월회비 (`dues_fee`) | 즉시 `confirmed` | 멤버별 수납 |
- 과금 방식을 바꾸면 안 쓰는 금액 컬럼은 비운다(`_apply_billing`) — 되돌렸을 때 옛 금액이 되살아나지 않게
- 비활성 팀은 예약 드롭다운에서 사라짐. 예약 이력·소속 멤버 있으면 삭제 불가
- `members.team_id` = 회비를 누가 내는지, `members.is_doors` = 도어즈 멤버십 여부. **둘은 별개다.**
  팀 이용료 팀으로 옮겨간 사람도 도어즈 명부에는 남는다
- 소속 팀이 `monthly` 면 그 멤버는 개인 회비 대상에서 빠진다 (`DuesRow.covered_by_team`)
- 회비 금액: `member.monthly_fee` > `team.dues_fee` > `app_settings.default_monthly_fee` (`deps.resolve_member_fee`)
- 팀 이용료: `team.monthly_fee` > `app_settings.default_team_fee` (`deps.default_team_fee`). 프론트·백엔드가 같은 순서를 쓴다
- `parts`는 콤마 문자열(`"기타,보컬"`), 조인 테이블 없음
- 전화번호는 **숫자만 저장**하고 화면에서만 하이픈을 붙인다 (`deps.normalize_phone` / `core.js::formatPhone`).
  번호처럼 안 생긴 값은 손대지 않는다
- `member_dues` = (member_id, year_month) 유니크. status는 `paid|unpaid|exempt|pending`
  - `GET /api/admin/dues`는 활성 멤버 전원을 반환하고, 기록 없는 달은 기본값으로 채워 보낸다. **조회로 row를 만들지 않는다** — 생성은 PUT upsert에서만
- `team_dues` = (team_id, year_month) 유니크. **`billing_type='monthly'` 팀만** 대상 (다른 과금 방식은 400). `member_dues`와 같은 모양이고 같은 규칙(조회로 row 안 만듦)
  - **회비와 이용료는 절대 합산하지 않는다** — 성격이 다른 수입이다. KPI 카드 · 수납률 막대 · 연간 차트(스택 2계열) 모두 따로 센다
  - 계열 색은 화면 어디서나 같다: 월회비 `--room1`(보라) / 월 이용료 `--room2`(청록)
  - 입금 이력: `GET /api/admin/dues/history/{member|team}/{id}` — 멤버·팀 수정 모달에서 `core.js::renderDuesHistory()` 하나로 렌더


### 온라인 티켓
- 배경 이미지 + 텍스트 요소를 드래그로 배치, 좌표는 `tickets.elements` JSON에 저장
- **좌표는 퍼센트, 글자 크기는 `cqw`**(캔버스 폭의 %) — 어떤 화면 크기에서도 같은 비율로 보인다.
  `.tk-canvas`에 `container-type: inline-size`가 걸려 있어야 동작한다
- 에디터와 공개 페이지가 `ticket-render.js::tkRender()` 하나를 공유 — 렌더 로직을 두 벌로 나누지 말 것
- `slug` 는 관리자가 직접 바꿀 수 있다 (`/t/autumn-live`). 바꾸면 이전 링크는 죽는다.
  **자동 생성값과 수정 시 검사 규칙이 반드시 같아야 한다** (`schemas.SLUG_PATTERN`) —
  전에는 생성이 `token_urlsafe`(대문자·밑줄 포함)인데 검사는 소문자만 받아서
  자동 생성된 티켓은 저장 자체가 422 로 막혔다. 지금 생성은 `token_hex(6)`
- `map_url` 은 공개 페이지 `href` 로 나가므로 **http/https 만** 통과시킨다 (javascript: 차단). 프론트에서도 한 번 더 검사
- **공개 페이지 테마는 포스터를 따라간다** (애플 뮤직 방식). `accentFromImage()` →
  `tkApplyAccent()` 가 `--tkp-accent` / `--tkp-bg` / `--tkp-bg2` / `--tkp-ink` / `--tkp-on-accent` 를 심는다:
  - **배경색은 가장자리 픽셀**에서 뽑는다 (가운데 로고가 아니라 판 전체 톤). 버튼색은 판 전체에서 가장 선명한 색
  - **"색이 있는 포스터인가"는 채도로 판단한다** (`accSat >= .16`). 가중치 총합으로 재면 거의 흰 포스터의
    미세한 얼룩도 '색 있음'이 돼서 채도 7% 짜리 초록을 35% 로 부풀려 칠한다 — 실제로 그랬다.
    무채색 판정이면 hue 를 버리고 회색으로 간다
  - **포스터에 있는 것보다 진하게 만들지 않는다.** 채도 하한(`max(.35, v)`)을 두면 없는 색을 지어낸다.
    어두운 톤은 살리고(≤.75) 밝은 톤만 옅게(×.5)
  - 명도는 거의 검정/흰색이 아니라 **진한 색** (어두우면 .22, 밝으면 .90). 밝기 .62 초과면 `.light` 로 배경·글자를 뒤집는다
  - 두 번째 색은 **첫 색 가중치의 35% 이상일 때만** 그라디언트에 쓴다 (금색 포스터에 올리브 얼룩이 끼던 문제)
  - 버튼 세 개는 **모두 같은 반투명 머티리얼**이고 길찾기만 채움이 진하다(.42 / .20).
    꽉 찬 색으로 칠하면 덩어리처럼 튀고 칙칙해진다. 글자는 `--tkp-ink` 라 대비는 항상 안전하고,
    강조색은 "보이기만" 하면 되므로 어둡게 누르지 않는다 (`tkFitContrast` 목표 1.7)
  - 무채색 포스터는 색을 지어내지 않고 밝기만 따라간다
- **관리자 미리보기와 공개 페이지는 CSS 가 같아야 한다** — 여백과 `background-attachment` 가 달라
  "미리보기랑 실제가 다르다"가 됐었다. 여백은 같은 값을 쓰고, `background-attachment` 는 **양쪽 다 `scroll`**.
  `fixed` 는 뷰포트 기준이라 박스 안에서 스크롤하는 미리보기에선 그라디언트가 다른 자리에 그려진다
- 뽑은 값은 **`.tkp-page` 요소 자체에** 얹어야 한다 — `:root` 에 얹으면
  `.tkp-page` 의 기본값 선언이 상속값을 이겨서 조용히 무시된다 (공개 페이지만 기본 보라로 남았던 적 있음)
- `.tk-canvas` 의 `touch-action: none` 은 **에디터(`.editing`)에만** 걸어야 한다. 공개 페이지에 걸면 스크롤이 죽는다
- `is_published=false`면 `/api/tickets/{slug}`와 `/t/{slug}` 모두 404
- `GET /t/{slug}`는 `ticket.html`의 `<!--OG-->` 자리에 og 태그를 문자열 치환으로 주입 (카톡 공유 미리보기용).
  **주소는 반드시 외부에서 열리는 절대 주소여야 한다** — 내부 주소가 박히면 카톡이 이미지를 못 가져와
  미리보기가 흰 칸으로 뜬다 (실제로 그랬다). 두 겹으로 막는다:
  1. `.env` 의 `PUBLIC_BASE_URL` (역방향 프록시 뒤에서는 필수). 있으면 이 값을 쓴다
  2. 없으면 `request.base_url` — 이게 맞으려면 uvicorn 에 `--proxy-headers --forwarded-allow-ips "*"` 가 있어야 한다 (Dockerfile)
  - 카카오는 URL 단위로 캐시하므로 태그를 고쳐도 **카카오 개발자 도구에서 캐시 초기화**를 해야 반영된다
  - og 이미지는 가로형(권장 2:1)에 수백 KB 대가 안전하다. 세로로 긴 원본 포스터는 작게 잘려 나오거나 실패할 수 있다
- 업로드는 content-type + **매직 넘버** 둘 다 검사, 파일명은 `secrets.token_hex(16)` — 원본 파일명 절대 사용 안 함
- 크기 제한은 `MAX_UPLOAD_MB` (기본 25, `0`이면 무제한). 조각 단위 스트리밍이라 큰 파일도 메모리를 먹지 않는다.
  실패하면 반쪽 파일을 지운다. 프록시(nginx)에도 자체 본문 크기 제한이 있으니 앱 로그에 요청이 안 찍히면 그쪽을 봐야 한다

### SSE 실시간 업데이트
- 엔드포인트: `GET /api/reservations/stream`
- 이벤트: `reservation_created`, `reservation_confirmed`, `reservation_deleted`
- 동기 라우트에서 발행 시 `Broadcaster.publish`가 `call_soon_threadsafe`로 asyncio 루프에 스케줄
- 25초마다 ping으로 연결 유지

### DB 마이그레이션 전략
- Alembic 없음. `main.py::migrate_schema()`가 시작 시 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 실행 (멱등)
- 새 컬럼 추가 시:
  1. `models.py`에 Column 추가 (fresh DB 대응)
  2. `migrate_schema()`에 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 추가 (기존 DB 대응)
  3. 기존 row에 유의미한 값이 필요하면 `server_default` 지정하거나 `init_data()`에서 백필

### 로깅
- `app_logging.py`의 `log_event(event, **fields)`가 `event=X key=value` 형식 구조화 로그 출력
- 출력 대상: stdout (docker logs) + `/app/logs/app.log` (10MB × 5 rotate)
- HTTP 미들웨어가 4xx/5xx 및 unhandled exception을 자동 기록
- 로그 확인: `docker logs bandroom_app` 또는 `tail -f backend/logs/app.log`

### 타임존
- 컨테이너 TZ는 `Asia/Seoul` (docker-compose에 `TZ` / `PGTZ` 설정)
- `date`, `start_time`, `end_time`은 벽시계 값이므로 TZ와 무관
- `created_at`은 `func.now()` 기반 → DB TZ 영향 받음. 세션 만료는 `datetime.utcnow()` 기준

## 작업 시 주의사항

- **프론트엔드 빌드 없음**: `frontend/`는 `./frontend:/app/frontend` 볼륨으로 마운트돼 브라우저 새로고침만으로 반영됨. 백엔드 변경만 `--build` 필요
- **`api()` 는 FormData 를 건드리지 않는다**: 본문이 FormData 면 Content-Type 을 붙이지 않아야 한다.
  `application/json` 을 씌우면 multipart boundary 가 사라져 서버가 422 를 낸다 (이미 한 번 겪음)
- **관리자 JS는 ES 모듈이 아니다**: 인라인 `onclick`이 전역 함수를 부르므로 일반 `<script>` 태그 + 전역 스코프를 유지한다. 새 페이지는 `PAGE_LOADERS.<page> = load<Page>` 로 자기 로더를 등록하고, `admin.html` 맨 아래 script 목록에 추가한다 (core.js가 항상 먼저)
- **관리자 페이지에는 SSE 미연결**: 목록은 수동 새로고침 또는 액션 후 재호출
- **대시보드·통계는 매출이 아니라 이용 건수 기준**: 팀 대부분이 선불(`monthly`/`dues`)이라 예약 건당 매출이 0이다. 매출로 재면 그래프가 통째로 비어 "예약이 없다"로 읽힌다. 건수를 주 지표로, 시간·매출은 보조로 표기한다. 방별 비율도 건수 기준. 실제 수입은 정산 화면(회비 + 팀 이용료)에 있다
- **정적 자원 캐시**: 셸과 JS/CSS 의 캐시 수명이 어긋나면 옛 JS 에 새 HTML 이 붙어 화면이 죽는다 (두 번 겪음). 방어가 세 겹이다:
  1. HTML 셸과 `/static` 에 `Cache-Control: no-cache` (`main.py` 미들웨어) — ETag 로 304 는 그대로 나간다
  2. `main.py::render_page()` 가 셸의 `/static/*.js|css` 주소에 `?v=<가장 최근 mtime>` 을 붙인다. **이게 핵심** — 이미 캐시된 사본에는 헤더가 소급되지 않으므로 주소를 바꿔야 한다. 프론트만 고쳐도(재빌드 없이) 값이 바뀐다
  3. 새 DOM 요소를 읽을 땐 `core.js::setText()` 처럼 없으면 넘어가게 쓴다
  세 페이지(`/`, `/admin`, `/t/{slug}`)가 모두 `render_page()` 를 지난다
- **포트**: 앱 8010, DB 호스트 5433 (5432는 다른 프로젝트가 점유 가능)
- **Docker Compose v1 환경** (구형 시놀로지): `docker-compose up --build -d` 써야 함. `--build`만 단독이면 v1은 거부
- **시놀로지에서 docker.sock 권한**: `sudo` 필요하거나 `docker` 그룹에 사용자 추가
- **uploads 볼륨**: 시놀로지 배포 시 `./uploads` 디렉토리 권한 확인. 없으면 티켓 배경 업로드가 실패한다

## 커밋 컨벤션
```
feat: <새 기능>
fix: <버그 수정>
chore: <빌드/인프라/타임존 등>
```
한 줄 제목 + 빈 줄 + 상세 설명. Co-Authored-By 포함.
