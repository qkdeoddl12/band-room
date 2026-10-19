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
- 이용안내: `http://localhost:8010/guide` (인쇄하면 A4 PDF)
- 공개 티켓: `http://localhost:8010/t/{slug}`
- pgadmin: `http://127.0.0.1:5050` (계정은 `.env`)
- DB: `127.0.0.1:5433` (loopback 전용, 내부는 5432)

운영: 시놀로지 DSM 내장 역방향 프록시 → `LAN IP:8010`. 공유기는 80/443만 포워딩.
앱 포트만 0.0.0.0 바인딩(프록시가 붙어야 함), DB·pgadmin 은 loopback.

코드 변경 후 앱만 재빌드: `docker compose up -d --build app`
DB 백업 즉시 1회: `docker compose exec db-backup sh /backup.sh once`
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
  favicon.svg               # 문 모양 파비콘 (다섯 페이지 공용)
  parts.js                  # 포지션 고정 목록 — 관리자·오픈잼 공용 (여기 한 곳)
  guide.html  guide.js      # 이용안내 (/guide) — 화면 + 인쇄용 PDF
  openjam.html  openjam.js  # 오픈 잼 (/openjam) — 회원이 곡을 발제하고 자리를 잡는다
  guide/                    # 이용안내에 넣은 화면 캡처 (UI 바뀌면 다시 찍을 것)
  ticket.html  ticket.js    # 공개 티켓 페이지 (/t/{slug})
  ticket-render.js          # 티켓 렌더 — 에디터·공개 페이지 공용
  style.css                 # 공용 스타일 (모바일 우선, 데스크탑은 phone-frame)
uploads/            # 티켓 배경 이미지 (볼륨 마운트, git 제외)
backups/            # DB 덤프 (db-backup 사이드카가 채운다, git 제외)
scripts/
  pg-backup.sh      # 매일 pg_dump + 검증 + 보관기간 정리
docker-compose.yml
```

## 아키텍처 요점

### 인증 (관리자만 존재, 일반 사용자는 로그인 없음)
- 토큰 기반. `X-Auth-Token` 헤더로 전달, 서버는 `admin_sessions`에서 조회
- **세션 12시간 만료 + 슬라이딩 갱신** (`deps.SESSION_TTL`). 남은 시간이 절반 아래일 때만 UPDATE
- **로그인 실패 5회/5분 → 429** (`routers/auth.py`의 인메모리 dict, 단일 프로세스 전제).
  키는 **(아이디, 접속 IP)** — 아이디만으로 세면 남이 틀린 비번을 넣어 관리자를 잠글 수 있다
- **비밀번호 변경은 현재 비밀번호를 받는다** (`current_password`). 바꾸면 **그 세션만 남기고** 나머지 세션을 지운다.
  관리자가 남의 비밀번호를 초기화하면 그 사람 세션은 전부 지운다
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
- `_assert_slots_free()` 는 **방 행을 `FOR UPDATE` 로 잠그고** 겹침을 본다 — 안 그러면 두 명이 동시에 같은 칸을 잡는다
- **자정 넘김 예약**: 23시에 3시간을 고르면 서버가 `_split_by_day()`로 날짜별 두 건(23~24시 / 0~2시)으로 나눠 저장하고 `group_key`로 묶는다. 확정·취소는 `_group_rows()`로 짝을 함께 처리. 날짜별 타임라인·겹침 검사는 그대로 동작. 프론트는 종료 시각을 다음날 `OVERNIGHT_END`(6시)까지 고를 수 있고(서버도 `reservations.py::OVERNIGHT_END` 로 막는다 — 관리자 예약은 제외), 다음날 예약·차단도 같이 조회해 미리 막는다
- **팀은 등록된 활성 팀에서만 선택** — `team_id` 필수. 서버가 `team_name`을 스냅샷으로 채운다
- 요금은 `rooms.hourly_price`, 입금 계좌는 `app_settings`에서 온다 (프론트 하드코딩 없음)
- **오래 빌리면 시간당 요금이 내려간다** — `rooms.long_hourly_price` (NULL 이면 할인 없음).
  경계는 `LONG_HOURS = 3` 시간이고 `app.js` 와 `admin/core.js` 의 `roomPrice(id, hours)` 가 같은 값을 쓴다 (`guide.js` 안내 문구도 같은 상수).
  금액은 관리자 환경 설정에서 방마다 정한다 — 화면에 박지 않는다

### 팀 · 멤버 · 정산
- `teams.billing_type` 세 가지 — 예약 확정 흐름과 정산이 여기서 갈린다:
  | 값 | 뜻 | 예약 | 정산 |
  |---|---|---|---|
  | `hourly` | 쓸 때마다 시간당 | `pending` → 관리자 확정 | 매출에 합산 |
  | `monthly` | 팀이 월 이용료 일괄 (`monthly_fee`) | 즉시 `confirmed` | 건별 0원 |
  | `dues` | 멤버가 각자 월회비 (`dues_fee`) | 즉시 `confirmed` | 멤버별 수납 |
- 과금 방식을 바꾸면 안 쓰는 금액 컬럼은 비운다(`_apply_billing`) — 되돌렸을 때 옛 금액이 되살아나지 않게
- 비활성 팀은 예약 드롭다운에서 사라짐. 예약 이력·소속 멤버·**회비/이용료 기록**이 있으면 삭제 불가 (지우면 정산 기록이 같이 날아간다)
- `teams.is_doors` = 도어즈 밴드인가 외부 밴드인가. **`billing_type` 과는 별개다** —
  외부 밴드도 월 이용료를 낼 수 있고, 도어즈 밴드도 시간당일 수 있다.
  멤버의 `is_doors` 와 같은 뜻이고, 팀 목록에서 외부는 `외부` 뱃지가 붙는다
- **한 멤버가 팀 여러 개에 속할 수 있다.** 소속의 정본은 `member_teams` 조인 테이블이고,
  `members.team_id` 는 그 중 **대표 팀**(목록 첫 팀)일 뿐 — 회비 주체가 아니다.
  두 값은 `deps.set_member_teams()` 한 곳에서만 함께 쓴다. `MemberResponse.teams` 가 전체 소속을 싣는다
- `members.is_doors` = 도어즈 멤버십 여부. **소속과는 별개다.** 멤버 관리 기본 필터가 도어즈다
  팀 이용료 팀으로 옮겨간 사람도 도어즈 명부에는 남는다
- **회비는 소속 팀마다 각각 청구된다** — 두 밴드를 하면 그 달 회비도 두 건이다.
  그 중 `monthly` 팀 건만 개인 회비에서 빠진다 (`DuesRow.covered_by_team`). 나머지 팀 몫은 그대로 청구된다
- 팀 하나만 안 받으려면 `member_teams.dues_exempt` (멤버 수정창의 '회비 제외할 팀').
  `members.dues_exempt` 는 전체 면제라 범위가 다르다
- **등급 `members.role`**: `member` 일반 / `staff` 운영진 / `leader` 모임장.
  운영진·모임장은 **회비 기본값이 면제**다 (`routers/dues.py` 의 `off`). 어디까지나 *기본값* —
  그 달에 기록을 남기면(`member_dues` upsert) 그 값이 이긴다. 화면 배지·금액칸 잠금은
  `members.js::roleExempt` 하나가 판단하고 `dues.js` 도 그걸 쓴다 (members.js 가 먼저 로드됨)
- 회비 금액: `member.monthly_fee` > `team.dues_fee` > `app_settings.default_monthly_fee` (`deps.resolve_member_fee`)
- 팀 이용료: `team.monthly_fee` > `app_settings.default_team_fee` (`deps.default_team_fee`). 프론트·백엔드가 같은 순서를 쓴다
- **팀 레퍼토리**(`team_songs`): 곡마다 `status` = `candidate` 후보 / `practicing` 연습중 / `done` 완곡.
  목적이 "이 팀이 어떤 곡을 할 수 있나" 라서 목록은 **완곡 → 연습중 → 후보** 순, 같은 상태 안에서는 제목순
  (`teams.py::_song_sort`). 팀을 지우면 곡도 함께 지워지고, 곡이 있다고 팀 삭제를 막지는 않는다
  - `TeamResponse.done_song_count` = 완곡 수. 팀 목록 카드에 `완곡 N곡` 으로 나온다 (멤버 구할 때 참고)
  - 곡 `link` 는 화면에서 href 로 나가므로 **http/https 만** 통과한다. 티켓 `map_url` 과 같은 규칙이라
    `deps.clean_http_url()` 한 곳에 모아 두고 둘이 공유한다 — 복사해두면 규칙이 갈린다
  - 상태 라벨은 `teams.js::SONG_STATUS` 한 곳에만 둔다. 상태 칩은 정산 회비 칩(`.dues-chip`)과 같은 패턴
- 팀 상세 모달은 `멤버 | 레퍼토리` 탭으로 나뉜다 (`teams.js::detailTab`). 팀을 새로 열면 멤버 탭으로 돌아가고
  펼쳐둔 곡 편집창도 닫힌다 — 안 닫으면 남의 팀 곡을 고치게 된다
- `parts`는 콤마 문자열(`"기타,보컬"`), 조인 테이블 없음. 고정 목록은 **`frontend/parts.js` 한 곳** —
  관리자(멤버·팀 수정창)와 공개 오픈 잼이 같은 어휘를 써야 한다. 전에는 `core.js` 와 `openjam.js` 가
  각자 복사본을 갖고 있었다. `admin.html` · `openjam.html` 이 다른 스크립트보다 **먼저** 이 파일을 읽는다
- 팀 카드·상세의 나이 통계는 `TeamResponse.age_avg` / `age_buckets` (서버 집계, `teams.py::_age_stats`).
  나이는 한국식 연 나이, 연령대는 10년 단위에 60 이상 한 묶음. **출생년도를 모르는 멤버는 아예 뺀다**
- 전화번호는 **숫자만 저장**하고 화면에서만 하이픈을 붙인다 (`deps.normalize_phone` / `core.js::formatPhone`).
  번호처럼 안 생긴 값은 손대지 않는다
- `member_dues` = (member_id, **team_id**, year_month) 유니크. status는 `paid|unpaid|exempt|pending`.
  무소속이면 `team_id` 가 NULL 이므로 Postgres 15 의 `NULLS NOT DISTINCT` 로 중복을 막는다
  (`migrate_schema()` 가 인덱스로 건다 — 옛 `uq_member_dues_month` 가 남아 있을 때만 한 번 옮긴다)
  - **월회비는 도어즈 회비다** — `GET /api/admin/dues` 는 `is_doors=true` 인 활성 멤버만 센다.
    도어즈가 아니면 낼 것이 없어 목록에 있어봐야 '팀 납부' 뱃지만 달고 자리를 차지한다.
    회비 팀에 도어즈 아닌 멤버가 있으면 팀 상세 명단에 '회비 대상 아님' 으로 표시된다
  - `GET /api/admin/dues`는 활성 **도어즈** 멤버를 **소속마다 한 건씩** 반환하고, 기록 없는 달은 기본값으로 채워 보낸다. **조회로 row를 만들지 않는다** — 생성은 PUT upsert에서만
  - 쓰기는 `PUT /api/admin/dues/{member_id}/{year_month}?team_id=` — 생략하면 무소속 건. 남의 팀이면 400
  - 프론트에서 행을 찾을 땐 `member_id` 만으로 부족하다. **`team_id` 까지 봐야 한다**
- `team_dues` = (team_id, year_month) 유니크. **`billing_type='monthly'` 팀만** 대상 (다른 과금 방식은 400). `member_dues`와 같은 모양이고 같은 규칙(조회로 row 안 만듦)
  - **회비와 이용료는 절대 합산하지 않는다** — 성격이 다른 수입이다. KPI 카드 · 수납률 막대 · 연간 차트(스택 2계열) 모두 따로 센다
  - 계열 색은 화면 어디서나 같다: 월회비 `--room1`(보라) / 월 이용료 `--room2`(청록) / 정모 참가비 앰버
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
  2. 없으면 `request.base_url` — 이게 맞으려면 uvicorn 에 `--proxy-headers` 가 있어야 한다 (Dockerfile).
     `--forwarded-allow-ips` 는 `127.0.0.1,172.16.0.0/12` (도커 브리지 게이트웨이) 만 믿는다.
     `"*"` 로 두면 누구나 `X-Forwarded-For` 로 IP 를 속여 로그인 잠금을 피한다. CIDR 은 uvicorn 0.30+ 필요
  - 카카오는 URL 단위로 캐시하므로 태그를 고쳐도 **카카오 개발자 도구에서 캐시 초기화**를 해야 반영된다
  - og 이미지는 가로형(권장 2:1)에 수백 KB 대가 안전하다. 세로로 긴 원본 포스터는 작게 잘려 나오거나 실패할 수 있다
- 업로드는 content-type + **매직 넘버** 둘 다 검사, 파일명은 `secrets.token_hex(16)` — 원본 파일명 절대 사용 안 함.
  검사·저장 규칙은 `backend/uploads_util.py::save_image` 한 곳에 있다 (티켓 배경 · 정모 사진 공유) —
  복사해두면 한쪽만 느슨해진다
- 크기 제한은 `MAX_UPLOAD_MB` (기본 25, `0`이면 무제한). 조각 단위 스트리밍이라 큰 파일도 메모리를 먹지 않는다.
  실패하면 반쪽 파일을 지운다. 프록시(nginx)에도 자체 본문 크기 제한이 있으니 앱 로그에 요청이 안 찍히면 그쪽을 봐야 한다

### 정모 기록 (`meetup_records` / `meetup_attendees` / `meetup_songs`)
정모 예약(`kind='meetup'`) 한 건에 기록 하나(`reservation_id` 유니크). 날짜·장소는 예약이
갖고 있어서 **다시 적지 않고 끌어온다**. 예약을 지우면 기록도 함께 사라진다(CASCADE). 관리자 전용
- 저장은 `PUT /api/admin/meetups/{id}` 로 **통째로 갈아끼운다** — 참석자·곡을 한 화면에서
  같이 고치므로 항목별 API 보다 단순하고, 지운 줄이 남을 일이 없다
- 참석 구분 `pay_type`: `dues` 월회비 / `walk_in` 당일 참가비 / `free` 무료 참관.
  **금액은 `walk_in` 일 때만 저장한다** — 서버가 나머지를 0 으로 눌러 정산에 엉뚱한 돈이 안 섞이게 한다
- 곡 라인업은 `meetup_songs.parts` JSON `[{part, name, member_id}]` — **포지션과 사람을 골라서** 넣는다.
  사람은 **그 기록의 참석 명단**(체크한 멤버 + 외부 게스트)에서만 고른다. 게스트는 `member_id=null` 이고
  이름만 남는다. 이름은 스냅샷이라 멤버를 지워도 기록이 살아 있다 (예약 `team_name` 과 같은 이유)
  - 참석자를 빼면 드롭다운은 갱신되지만 **이미 고른 값은 남긴다** (`meetups.js::refreshSongWho`) —
    기록을 조용히 지우면 안 된다. 옛 기록의 낯선 포지션도 목록에 끼워 유지한다
  - 포지션·이름이 빈 줄은 저장하지 않는다 (화면에서 지운 것)
- 사진은 `/uploads/` 로 시작하는 주소만 받는다 (티켓 배경과 같은 규칙)
- **당일 참가비는 정산의 세 번째 수입**이다. 월회비(보라) · 팀 이용료(청록) 에 이어 앰버.
  **셋을 절대 합산하지 않는다** — KPI 카드 · 연간 차트 계열 모두 따로 센다.
  참가비는 **정모(예약) 날짜 기준**으로 센다 — 기록을 언제 적었는지와 무관해야 한다

### 오픈 잼 (`open_jams` / `open_jam_slots`)
1곡 단위로 발제해 포지션별 선착순으로 사람을 모으는 단기 프로젝트 (`doors_open_jam_system.pdf`).
**팀이 아니다** — `teams` 에 만들지 않는다. 회비가 소속 팀마다 청구되므로(위 참조)
팀으로 만들면 참여자에게 회비가 한 건 더 붙는다
- `"보컬1, 기타2"` 는 **슬롯 3개**다. 자리 단위로 두어야 선착순이 그대로 "빈 자리 잡기"가 된다
- **선착순 경합은 조건부 UPDATE 로 막는다** — `WHERE id = ? AND member_id IS NULL`.
  영향 행이 0이면 그 사이 누가 채운 것이므로 400. 두 명이 동시에 눌러도 한 명만 들어간다
- 신원은 로그인 없이 **이름 → 활동 멤버 조회** (`reservations.find_member_by_name` 재사용).
  명부에 없으면 거부한다 — 사실상 유일하면서 30명 명부에는 충분한 방어다
- **토큰은 생성 응답에만 싣는다.** `manage_token`(발제자) / `claim_token`(지원자) 이
  목록에 실리면 남의 잼을 마감·삭제하거나 남의 자리를 뺄 수 있다.
  공개 스키마(`OpenJamPublic`)를 따로 두고 연락처도 뺀다. 관리자 응답에만 연락처가 있다
- 상태는 **발제자가** `POST /api/openjams/{id}/status` 로 옮긴다 (manage_token).
  `recruiting` 모집중 → `closed` 모집완료 → `done` 종료.
  **`done` 이면 공개 목록에서 내려간다** (`GET /api/openjams` 는 recruiting·closed 만 준다).
  하차가 생기면 `closed → recruiting` 으로 되돌릴 수 있다 — 기획서가 하차를 전제한다.
  `done` 에서 되살리는 건 발제자가 못 하고 관리자만 한다 (`PATCH /api/admin/openjams/{id}`)
- **마감만 하고 방치된 잼은 표시만 한다** — `closed_at` 부터 `openjams.py::STALE_DAYS`(21일,
  기획서 "3주~1개월" 의 하한)가 지나면 `is_stale`·`closed_days` 가 붙어 공개 화면과 관리자
  화면에 `마감 N일 지남` 이 뜬다. **자동으로 종료시키지 않는다** — 합주가 정말 끝났는지는
  사람만 안다. `closed → recruiting` 으로 되돌리면 `closed_at` 도 지워 다시 마감할 때부터 센다
- 모집이 `closed` 인 잼만 예약할 수 있다. `POST /api/reservations` 에 `jam_id` 를 주면
  `kind='openjam'`, 이름은 `[오픈잼] {title}`, **무료 + 즉시 확정**
  (참여자 전원이 이미 월회비를 내는 회원이다)

### 예약 종류 (`reservations.kind`)
- `team` 팀 합주 · `personal` 개인연습실 — **이용자**가 만든다
- `rental` 장소 대관 · `meetup` 도어즈 정모 — **관리자**가 `POST /api/admin/reservations` 로 만든다
- `openjam` 오픈 잼 — 회원이 `POST /api/reservations` 에 `jam_id` 를 주면 만들어진다
- 대관·정모는 팀도 이용자도 없다. 표시 이름은 **`team_name` 에 넣는다** — 목록·타임라인·캘린더가
  이미 그 칸을 읽고 있어서 화면을 안 고쳐도 이름이 나온다 (예약 시점 스냅샷이라는 뜻도 그대로 맞다)
- 바로 `confirmed` + `is_free=True` 로 들어간다. 요금·입금 확인 단계가 없다.
  대관비를 남기고 싶어지면 `is_free` 를 끄고 기존 입금 확인 흐름에 태우면 된다
- **종류는 만들 때 정해지고 수정으로 바뀌지 않는다.** 수정 라우트가 `kind` 를 그대로 물려준다.
  대관·정모·**오픈잼**을 고칠 땐 팀을 요구하지 않고 `title` 한 칸만 받는다 (`reservations.js::RES_KIND` 에도 있어야 팀 드롭다운에 안 탄다)
- 이용자 타임라인에서 **방 색(보라·청록)이 아니라 자기 색**으로 나온다 (대관 앰버 / 정모 슬레이트).
  팀 합주 옆에 놓였을 때 갈라져 보여야 한다. `ReservationPublic.kind` 는 공개한다 (개인정보 아님)
- 기존 행 백필: `team_id IS NULL` 이면 `personal`, 아니면 기본값 `team`

### 공개 API 와 관리자 API 는 갈라져 있다
- `GET /api/reservations` 는 **인증이 없다** — 주소만 알면 누구나 받아간다.
  그래서 `ReservationPublic` 으로 내보낸다: 연락처·메모·예약자 실명·취소 토큰 없음.
  타임라인에 실제로 쓰는 것만 (`id room_id date start_time end_time duration team_name members status group_key`)
- 관리자 화면은 `GET /api/admin/reservations` (`get_current_admin`) 로 전부 본다.
  두 라우트가 `_reservation_query()` 하나를 공유한다
- `members`(참여 멤버) 는 자유 입력이라 연락처를 적는 사람이 있었다 (개인연습실 예약에서 실제로 샜다).
  개인연습실은 이 칸을 아예 받지 않고(화면에서도 숨김), 공개 응답은 번호처럼 생긴 건 지운다 (`ReservationPublic._hide_phone`)
- 개인연습실은 `team_name` 이 이용자 실명이라 공개 목록·SSE 에선 `우*수` 로 가린다 (`schemas.mask_name`). 관리자 화면은 그대로
- 로그인 없는 쓰기(예약·문의·오픈잼 발제·지원)는 IP 마다 10분 횟수 제한이 있다 (`deps.rate_limit`, 인메모리)
- **공개 스키마에 필드를 더할 땐 그게 남에게 보여도 되는지 먼저 본다.**
  전에는 한 엔드포인트가 둘 다 맡아서 `booker_phone` 이 그대로 새고 있었다

### 본인 취소 (로그인 없음)
- 예약을 만들 때 `reservations.cancel_token` 을 발급하고 **생성 응답에만** 실어 보낸다
  (`ReservationCreated`). 목록에 실으면 남의 예약도 지워진다
- 프론트는 `localStorage['bandroom_my_res']` 에 `{예약id: {token, date, group_key}}` 로 보관.
  읽을 때 지난 날짜를 털어낸다 (`app.js::loadMyRes`)
- `POST /api/reservations/{id}/cancel` — 토큰은 `secrets.compare_digest` 로 맞추고,
  **시작 시각이 지나면 400**. 자정 넘김은 `_group_rows` 로 짝까지 함께 지운다
- 다른 기기에서는 취소가 안 된다 (그게 설계다). 그 경우는 문의로 받는다

### 관리자 예약 수정
- `PATCH /api/admin/reservations/{id}` — 보낸 항목만 바뀐다. 슬롯 충돌·차단 검사는
  생성과 같은 `_assert_slots_free()` 를 쓰되 `exclude_ids` 로 자기 자신을 뺀다
  (안 빼면 메모만 고쳐도 "이미 예약이 있습니다" 가 난다)
- **행을 지웠다 다시 만들지 않는다** — id 가 바뀌면 그 id 를 들고 있던 화면이 전부 어긋난다.
  구간 수만큼 기존 행을 고쳐 쓰고, 남는 행만 지운다. 자정을 넘기면 두 건이 되고 되돌리면 한 건이 된다
- 상태(`status`) · 무료 여부(`is_free`) · `cancel_token` 은 그대로 물려준다.
  시간을 옮겼다고 입금이 취소되는 것도 아니고, 이용자 취소 버튼이 죽어서도 안 된다

### 이용안내 페이지 (`/guide`)
- `frontend/guide.html` + `guide.js` + `style.css` 의 `.guide-*`. 인쇄 CSS 로 A4 PDF 가 바로 나온다
  (`window.print()`, `@page size: A4`, `print-color-adjust: exact`)
- 요금·계좌는 `/api/rooms` · `/api/settings` 에서 받아 채운다 — **안내문에 금액을 박지 않는다**
- 화면 캡처는 `frontend/guide/*.png`. **예약 화면을 바꾸면 다시 찍어야 한다.**
  계좌 숫자는 캡처에서 가려 뒀다 (계좌가 바뀌면 이미지만 옛값으로 남으므로)
- `guide.js::OVERNIGHT_END` 는 `app.js` · `reservations.py` 의 같은 값과 맞춰야 한다

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

### DB 백업
- `db-backup` 사이드카가 매일 `BACKUP_HOUR`시 05분에 `./backups/bandroom-YYYY-MM-DD_HHMM.dump` 를 떨군다
  (`scripts/pg-backup.sh`). 새 이미지를 받지 않으려고 `postgres:15-alpine` 을 db 와 공유한다
- `pg_dump -Fc` 커스텀 포맷 — 압축돼 있고 `pg_restore` 로 테이블 단위 복구도 된다
- **반쪽 파일이 멀쩡한 백업인 척 남지 않게** `.part` 로 쓰고 다 되면 `mv` 한다.
  이어서 `pg_restore --list` 로 열어보고, 못 열면 지우고 실패로 남긴다
- 옛 덤프 삭제는 **백업이 성공했을 때만** 돈다 (`BACKUP_KEEP_DAYS`, 기본 14일).
  실패한 날 옛것까지 지워버리면 백업이 통째로 사라진다
- 즉시 한 번: `docker compose exec db-backup sh /backup.sh once`
- 복구:
  ```bash
  # 통째로 되돌리기 (기존 DB 를 버리고 새로 만든다)
  docker compose exec db-backup psql -d postgres -c "DROP DATABASE bandroom"
  docker compose exec db-backup psql -d postgres -c "CREATE DATABASE bandroom"
  docker compose exec db-backup pg_restore -d bandroom --no-owner /backups/<파일>.dump
  docker compose restart app
  ```
  운영 DB 를 건드리기 전에는 `restore_test` 같은 임시 DB 로 먼저 열어보고 행 수를 비교할 것
- **시놀로지에서는 `./backups` 를 따로 챙길 필요가 없다** — 프로젝트 폴더를 Hyper Backup 대상으로
  잡으면 DB 덤프와 `./uploads` 가 함께 따라간다. 덤프는 git 에 올라가지 않는다(`.gitignore`)
- 로그: `docker logs bandroom_dbbackup`

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
- **목록 카드는 `.entity-cards` / `.ecard*` 공용** (멤버·팀). 새 목록도 이걸 쓴다.
  카드 전체가 상세로 가고 `.ecard-edit` 버튼만 `event.stopPropagation()` 으로 수정창을 연다.
  `.entity-list` / `.entity-item` 은 티켓 통계 줄에서만 쓰는 옛 형태
- **항목 많은 수정창은 `.modal.wide` + `.form-grid`/`.form-col`** (멤버·팀). 좁은 화면에선 `display: contents` 로
  그냥 세로로 쌓이고, 900px 이상에서만 2열이 된다. 칼럼에 항목을 넣을 땐 **양쪽 높이를 맞춰야** 스크롤이 안 생긴다
  - 데스크탑 `max-height` 는 `body:has(.admin-dashboard) .modal` 이 88vh 로 잡고 있으니 같은 특이도로 눌러야 먹는다
  - **관리자 모달은 본문만 스크롤한다 (폰·PC 공통)** (`.modal` 은 flex column + `overflow:hidden`,
    `.modal-body` 가 `overflow-y:auto` + `min-height:0`). 전에는 모달 전체가 스크롤 컨테이너라
    조금만 넘쳐도(팀 수정창 26px) 아래 버튼이 잘린 채 보이고 스크롤바도 눈에 안 띄었다
  - `.modal-actions` 는 `position: sticky; bottom: 0` — 내용이 길어도 저장·삭제가 항상 보인다.
    이때 본문 아래 여백은 액션 줄이 갖는다(`.modal-body:has(.modal-actions) { padding-bottom: 0 }`).
    **액션 줄이 없는 모달**(문의 상세·차단 등록 등)은 `:has()` 로 걸러 원래 여백을 지킨다
  - 액션 줄 아래 여백은 `calc(24px + env(safe-area-inset-bottom))` — 폰은 시트가 화면 바닥에
    붙으므로(`.modal-overlay { align-items: flex-end }`) 홈 인디케이터를 피해야 한다. PC 는 env() 가 0
  - 선택자가 전부 `body:has(.admin-dashboard)` 라 예약 페이지 모달은 예전 그대로다
- **Pydantic 필드 이름이 타입 이름을 가릴 수 있다**: `date: Optional[date] = None` 은
  `= None` 이 클래스 안에 `date` 를 묶어버려 타입이 통째로 `None` 이 된다 (422 `Input should be None`).
  `date: date` 처럼 기본값이 없으면 안 그런다. 기본값을 붙일 땐 `dt.date` / `dt.time` 을 쓴다
- **FastAPI 검증 오류의 `detail` 은 배열이다**: 그대로 토스트에 넘기면 `[object Object]` 가 뜬다.
  `core.js::apiJson` 이 배열이면 `필드: 메시지` 로 풀어준다
- **관리자 JS는 전역 스코프라 함수 이름이 충돌한다**: 나중에 로드되는 파일이 조용히 이긴다.
  `setTeamDuesStatus`(dues.js, 팀 이용료)와 팀 상세 명단의 회비 칩이 같은 이름이라 후자가 죽어 있었다 —
  지금은 `setRosterDuesStatus`(teams.js)로 나눠 놓았다. 새 전역 함수는 `grep -rn "function 이름"` 으로 먼저 확인할 것
- **관리자 JS는 ES 모듈이 아니다**: 인라인 `onclick`이 전역 함수를 부르므로 일반 `<script>` 태그 + 전역 스코프를 유지한다. 새 페이지는 `PAGE_LOADERS.<page> = load<Page>` 로 자기 로더를 등록하고, `admin.html` 맨 아래 script 목록에 추가한다 (core.js가 항상 먼저)
- **관리자 페이지에는 SSE 미연결**: 목록은 수동 새로고침 또는 액션 후 재호출
- **대시보드·통계는 매출이 아니라 이용 건수 기준**: 팀 대부분이 선불(`monthly`/`dues`)이라 예약 건당 매출이 0이다. 매출로 재면 그래프가 통째로 비어 "예약이 없다"로 읽힌다. 건수를 주 지표로, 시간·매출은 보조로 표기한다. 방별 비율도 건수 기준. 실제 수입은 정산 화면(회비 + 팀 이용료)에 있다
- **정적 자원 캐시**: 셸과 JS/CSS 의 캐시 수명이 어긋나면 옛 JS 에 새 HTML 이 붙어 화면이 죽는다 (두 번 겪음). 방어가 세 겹이다:
  1. HTML 셸과 `/static` 에 `Cache-Control: no-cache` (`main.py` 미들웨어) — ETag 로 304 는 그대로 나간다
  2. `main.py::render_page()` 가 셸의 `/static/*.js|css` 주소에 `?v=<가장 최근 mtime>` 을 붙인다. **이게 핵심** — 이미 캐시된 사본에는 헤더가 소급되지 않으므로 주소를 바꿔야 한다. 프론트만 고쳐도(재빌드 없이) 값이 바뀐다
  3. 새 DOM 요소를 읽을 땐 `core.js::setText()` 처럼 없으면 넘어가게 쓴다
  다섯 페이지(`/`, `/admin`, `/guide`, `/openjam`, `/t/{slug}`)가 모두 `render_page()` 를 지난다
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
