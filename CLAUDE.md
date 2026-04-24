# Band Room — 합주실 예약 시스템

FastAPI + vanilla JS + PostgreSQL 기반 소규모 예약 앱. 합주실/개인연습실 예약을 사용자가 신청하면, 관리자가 입금 확인 후 확정하는 플로우.

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
접속:
- 예약 페이지: `http://localhost:8000/`
- 관리자: `http://localhost:8000/admin`
- pgadmin: `http://localhost:5050` (admin@bandroom.com / admin1234)
- DB: 외부에서 `localhost:5433` (내부는 5432)

코드 변경 후 앱만 재빌드: `docker compose up -d --build app`

## 디렉토리
```
backend/
  main.py           # 모든 FastAPI 라우트 · 미들웨어 · 시작 훅
  models.py         # SQLAlchemy 모델
  schemas.py        # Pydantic 스키마
  database.py       # 엔진 · SessionLocal · get_db
  broadcaster.py    # SSE용 asyncio.Queue 팬아웃
  app_logging.py    # bandroom 로거 (stream + rotating file)
  logs/             # docker-compose 볼륨 마운트 (app.log, 런타임 생성)
  Dockerfile
  requirements.txt
frontend/
  index.html  app.js    # 사용자 예약 페이지
  admin.html  admin.js  # 관리자 대시보드
  style.css             # 공용 스타일 (모바일 우선, 데스크탑은 phone-frame)
docker-compose.yml
```

## 아키텍처 요점

### 인증 (관리자만 존재, 일반 사용자는 로그인 없음)
- 토큰 기반. `X-Auth-Token` 헤더로 전달, 서버는 `admin_sessions`에서 조회
- 두 단계 의존성:
  - `get_current_admin_raw`: 인증만 확인 (비밀번호 변경 엔드포인트용)
  - `get_current_admin`: 추가로 `must_change_password` 체크, true면 403
- 역할: `system` (전체) / `reservation` (예약만). `require_system_admin` 의존성으로 분리
- 초기 계정: 환경변수 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` (기본: superadmin / superadmin1234)

### 예약 상태 플로우
- 사용자가 `POST /api/reservations` → `status='pending'`으로 저장
- 관리자가 입금 확인 후 `POST /api/reservations/{id}/confirm` → `status='confirmed'`
- 슬롯 충돌 검사는 상태 무관 (pending도 슬롯을 점유)
- 요금: 합주실 15,000원/h, 개인연습실 8,000원/h (프론트에서만 계산/표시, DB엔 저장 안 함)
- 입금 계좌: 농협 352-1068-1777-83 (예금주: 황은희)

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
  3. 기존 row에 유의미한 값이 필요하면 `server_default` 지정

### 로깅
- `app_logging.py`의 `log_event(event, **fields)`가 `event=X key=value` 형식 구조화 로그 출력
- 출력 대상: stdout (docker logs) + `/app/logs/app.log` (10MB × 5 rotate)
- HTTP 미들웨어가 4xx/5xx 및 unhandled exception을 자동 기록
- 로그 확인: `docker logs bandroom_app` 또는 `tail -f backend/logs/app.log`

### 타임존
- 컨테이너 TZ는 `Asia/Seoul` (docker-compose에 `TZ` / `PGTZ` 설정)
- `date`, `start_time`, `end_time`은 벽시계 값이므로 TZ와 무관
- `created_at`은 `func.now()` 기반 → DB TZ 영향 받음

## 작업 시 주의사항

- **프론트엔드 빌드 없음**: `frontend/`는 `./frontend:/app/frontend` 볼륨으로 마운트돼 브라우저 새로고침만으로 반영됨. 백엔드 변경만 `--build` 필요
- **관리자 페이지에는 SSE 미연결**: 목록은 수동 새로고침 또는 액션 후 `loadAllReservations()` 재호출
- **포트 충돌**: DB 호스트 포트 5433 (5432는 다른 프로젝트가 점유 가능)
- **Docker Compose v1 환경** (구형 시놀로지): `docker-compose up --build -d` 써야 함. `--build`만 단독이면 v1은 거부
- **시놀로지에서 docker.sock 권한**: `sudo` 필요하거나 `docker` 그룹에 사용자 추가

## 커밋 컨벤션
```
feat: <새 기능>
fix: <버그 수정>
chore: <빌드/인프라/타임존 등>
```
한 줄 제목 + 빈 줄 + 상세 설명. Co-Authored-By 포함.
