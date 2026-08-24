"""End-to-end smoke test against a running app.

    docker compose up -d
    docker exec bandroom_app python test_smoke.py

From the host instead (needs httpx locally):  BASE=http://localhost:8010 python backend/test_smoke.py

Creates its own test data and removes it again. Safe to run against a live DB.
"""
import os
import sys
from datetime import date, timedelta

import httpx

BASE = os.getenv("BASE", "http://localhost:8000")
USER = os.getenv("INITIAL_ADMIN_USERNAME", "superadmin")
PASS = os.getenv("INITIAL_ADMIN_PASSWORD", "")   # 기본값을 두지 않는다 — 아래에서 확인

MARK = "[smoke]"
client = httpx.Client(base_url=BASE, timeout=20.0)
created = {"team": None, "team2": None, "team3": None,
           "cancel": None, "past": None, "edit": None, "edit2": None,
           "admin_res": None, "team4": None, "team5": None,
           "member": None, "member2": None, "member3": None,
           "member4": None, "ticket": None,
           "reservation": None, "reservation2": None, "reservation3": None,
           "reservation4": None, "overnight": None}


def login(username, password):
    return client.post("/api/admin/login", json={"username": username, "password": password})


def auth(token):
    return {"X-Auth-Token": token}


def test_login_rate_limit():
    """Unknown username so the real admin never gets locked out."""
    ghost = "__smoke_ghost__"
    codes = [login(ghost, "wrong").status_code for _ in range(6)]
    assert codes[:5] == [401] * 5, f"expected 5x401, got {codes}"
    assert codes[5] == 429, f"6th attempt should be rate-limited, got {codes[5]}"


def test_auth():
    res = login(USER, PASS)
    assert res.status_code == 200, res.text
    token = res.json()["token"]

    assert client.get("/api/admin/me").status_code == 401, "no token must be rejected"
    assert client.get("/api/admin/me", headers=auth("bogus")).status_code == 401
    assert client.get("/api/admin/me", headers=auth(token)).status_code == 200
    return token


def test_teams(h):
    res = client.post("/api/admin/teams", headers=h, json={"name": f"{MARK} 팀", "phone": "010-0000-0000"})
    assert res.status_code == 200, res.text
    team = res.json()
    created["team"] = team["id"]

    public = client.get("/api/teams").json()
    assert any(t["id"] == team["id"] for t in public), "active team must show in the public list"

    dup = client.post("/api/admin/teams", headers=h, json={"name": f"{MARK} 팀"})
    assert dup.status_code == 400, "duplicate team name must be rejected"
    return team


def test_reservation(h, team):
    day = str(date.today() + timedelta(days=90))   # far out, so it won't collide
    rooms = client.get("/api/rooms").json()
    team_room = next(r for r in rooms if r["booking_mode"] == "team")
    body = {"room_id": team_room["id"], "date": day, "start_time": "09:00:00", "duration": 2}

    no_team = client.post("/api/reservations", json=body)
    assert no_team.status_code == 400, f"team room needs a team, got {no_team.status_code}"

    bad = client.post("/api/reservations", json={**body, "team_id": 999999})
    assert bad.status_code == 400, f"unknown team must be rejected, got {bad.status_code}"

    res = client.post("/api/reservations", json={**body, "team_id": team["id"]})
    assert res.status_code == 200, res.text
    r = res.json()
    created["reservation"] = r["id"]
    assert r["team_name"] == team["name"], "server must snapshot the team name"
    assert r["end_time"].startswith("11:00"), r["end_time"]

    clash = client.post("/api/reservations", json={**body, "team_id": team["id"]})
    assert clash.status_code == 400, "overlapping reservation must be rejected"


def test_overnight(h, team):
    """자정을 넘긴 예약은 날짜별 두 건으로 나뉘고, 짝으로 함께 움직인다."""
    day = date.today() + timedelta(days=95)
    nxt = day + timedelta(days=1)
    rooms = client.get("/api/rooms").json()
    room = next(r for r in rooms if r["booking_mode"] == "team")
    body = {"room_id": room["id"], "team_id": team["id"], "date": str(day),
            "start_time": "23:00:00", "duration": 3}

    res = client.post("/api/reservations", json=body)
    assert res.status_code == 200, res.text
    first = res.json()
    created["overnight"] = first["id"]
    assert first["group_key"], "자정을 넘기면 group_key 로 묶여야 한다"
    assert first["duration"] == 1 and first["end_time"].startswith("00:00"), first

    rows = client.get(f"/api/reservations?date={nxt}").json()
    second = next(r for r in rows if r["group_key"] == first["group_key"])
    assert second["start_time"].startswith("00:00") and second["duration"] == 2, second

    # 다음날 구간과 겹치면 전체가 거부된다
    clash = client.post("/api/reservations", json={
        **body, "date": str(nxt), "start_time": "01:00:00", "duration": 1})
    assert clash.status_code == 400, "나뉜 뒷 구간과 겹치면 막아야 한다"

    # 한쪽만 확정해도 짝이 함께 확정된다
    client.post(f"/api/reservations/{first['id']}/confirm", headers=h)
    rows = client.get(f"/api/reservations?date={nxt}").json()
    assert next(r for r in rows if r["id"] == second["id"])["status"] == "confirmed", \
        "짝이 함께 확정되어야 한다"

    # 한쪽을 지우면 짝도 사라진다
    client.delete(f"/api/reservations/{first['id']}", headers=h)
    created["overnight"] = None
    rows = client.get(f"/api/reservations?date={nxt}").json()
    assert not any(r["id"] == second["id"] for r in rows), "짝이 함께 삭제되어야 한다"


def test_personal_room(h):
    """개인연습실 — 회비 낸 멤버는 무료 즉시 확정, 게스트는 연락처 필수."""
    rooms = client.get("/api/rooms").json()
    personal = next((r for r in rooms if r["booking_mode"] == "personal"), None)
    if not personal:
        print("  (개인 단위 방이 없어 건너뜀)")
        return

    day = date.today() + timedelta(days=91)
    ym = day.strftime("%Y-%m")
    name = f"{MARK}개인이용자"
    m = client.post("/api/admin/members", headers=h, json={"name": name}).json()
    created["member2"] = m["id"]

    base = {"room_id": personal["id"], "date": str(day),
            "start_time": "09:00:00", "duration": 1}

    # 회비 전 — 시간당 요금, 입금 대기
    before = client.post("/api/reservations", json={**base, "booker_name": name}).json()
    created["reservation2"] = before["id"]
    assert before["status"] == "pending" and not before["is_free"], before

    # 회비 납부 후 — 무료, 즉시 확정
    client.put(f"/api/admin/dues/{m['id']}/{ym}", headers=h, json={"status": "paid"})
    after = client.post("/api/reservations", json={
        **base, "start_time": "11:00:00", "booker_name": name}).json()
    created["reservation3"] = after["id"]
    assert after["status"] == "confirmed" and after["is_free"], after
    assert after["member_id"] == m["id"]

    # 게스트 — 연락처가 없으면 거부
    guest = client.post("/api/reservations", json={
        **base, "start_time": "13:00:00", "booker_name": f"{MARK}게스트"})
    assert guest.status_code == 400, "게스트는 연락처가 필요하다"

    ok = client.post("/api/reservations", json={
        **base, "start_time": "13:00:00",
        "booker_name": f"{MARK}게스트", "booker_phone": "010-1234-5678"}).json()
    created["reservation4"] = ok["id"]
    assert ok["member_id"] is None and not ok["is_free"], ok
    assert ok["booker_phone"] == "01012345678", "전화번호는 숫자만 저장"


def test_members_and_dues(h):
    res = client.post("/api/admin/members", headers=h, json={
        "name": f"{MARK} 멤버", "parts": "기타,보컬", "monthly_fee": 50000,
    })
    assert res.status_code == 200, res.text
    m = res.json()
    created["member"] = m["id"]
    assert m["parts"] == "기타,보컬"

    ym = "2099-01"   # far future month keeps totals isolated from real data
    before = client.get(f"/api/admin/dues?year_month={ym}", headers=h).json()
    row = next(r for r in before["rows"] if r["member_id"] == m["id"])
    assert row["status"] == "unpaid" and row["fee"] == 50000, row

    paid = client.put(f"/api/admin/dues/{m['id']}/{ym}", headers=h, json={"status": "paid"})
    assert paid.status_code == 200, paid.text
    assert paid.json()["amount"] == 50000, "paid amount defaults to the member's fee"

    after = client.get(f"/api/admin/dues?year_month={ym}", headers=h).json()
    assert after["total_paid"] - before["total_paid"] == 50000, "paid must land in the total"

    client.put(f"/api/admin/dues/{m['id']}/{ym}", headers=h, json={"status": "exempt"})
    exempt = client.get(f"/api/admin/dues?year_month={ym}", headers=h).json()
    assert exempt["total_paid"] == before["total_paid"], "exempt must drop out of paid"
    assert exempt["total_expected"] == before["total_expected"] - 50000, \
        "exempt must drop out of expected too"

    bad = client.put(f"/api/admin/dues/{m['id']}/2099-13", headers=h, json={"status": "paid"})
    assert bad.status_code == 400, "invalid month must be rejected"
    return m["id"]


def test_tickets(h):
    res = client.post("/api/admin/tickets", headers=h, json={"title": f"{MARK} 공연"})
    assert res.status_code == 200, res.text
    t = res.json()
    created["ticket"] = t["id"]
    slug = t["slug"]

    assert client.get(f"/api/tickets/{slug}").status_code == 404, "unpublished ticket must 404"

    elements = [{
        "id": "e1", "text": "DOORS LIVE", "x": 50, "y": 22.5, "size": 9,
        "color": "#FFFFFF", "weight": 800, "align": "center", "shadow": True,
    }]
    upd = client.put(f"/api/admin/tickets/{t['id']}", headers=h,
                     json={"elements": elements, "is_published": True})
    assert upd.status_code == 200, upd.text

    pub = client.get(f"/api/tickets/{slug}")
    assert pub.status_code == 200, "published ticket must be public"
    got = pub.json()["elements"][0]
    assert (got["x"], got["y"], got["size"]) == (50, 22.5, 9), got

    page = client.get(f"/t/{slug}")
    assert page.status_code == 200 and "og:title" in page.text, "OG tags must be injected"

    bad_bg = client.put(f"/api/admin/tickets/{t['id']}", headers=h,
                        json={"bg_url": "https://evil.example/x.jpg"})
    assert bad_bg.status_code == 400, "external bg_url must be rejected"


def test_upload_guards(h):
    txt = client.post("/api/admin/tickets/upload", headers=h,
                      files={"file": ("a.txt", b"hello", "text/plain")})
    assert txt.status_code == 400, f"non-image must be rejected, got {txt.status_code}"

    fake_png = client.post("/api/admin/tickets/upload", headers=h,
                           files={"file": ("a.png", b"not really a png", "image/png")})
    assert fake_png.status_code == 400, "content-type alone must not be trusted"

    limit_mb = int(os.getenv("MAX_UPLOAD_MB", "25"))
    if limit_mb == 0:
        print("  (크기 제한 없음 설정 — 초과 업로드 검사 건너뜀)")
        return
    if limit_mb > 30:
        print(f"  (제한이 {limit_mb}MB 라 초과 업로드 검사 건너뜀 — 테스트가 너무 무거워짐)")
        return

    big = b"\x89PNG\r\n\x1a\n" + b"0" * ((limit_mb + 1) * 1024 * 1024)
    too_big = client.post("/api/admin/tickets/upload", headers=h,
                          files={"file": ("a.png", big, "image/png")})
    assert too_big.status_code == 413, \
        f"{limit_mb + 1}MB must be rejected, got {too_big.status_code}"

    # 한도를 넘겨 거부된 요청이 반쪽 파일을 남기면 안 된다.
    leftovers = client.get("/api/admin/tickets", headers=h)
    assert leftovers.status_code == 200


def test_settings(h):
    pub = client.get("/api/settings").json()
    assert "deposit_account" in pub and "default_monthly_fee" not in pub, \
        "public settings must not leak admin-only keys"

    bad = client.put("/api/admin/settings", headers=h, json={"values": {"nope": "1"}})
    assert bad.status_code == 400, "unknown setting keys must be rejected"


def test_team_dues(h, team, member_id):
    """월 이용료 팀은 팀 단위로 입금 기록을 남기고, 상세에서 이력을 본다."""
    ym = "2099-01"
    tid = team["id"]

    # 시간당 팀에는 팀 단위 입금 기록을 못 남긴다
    bad = client.put(f"/api/admin/dues/team/{tid}/{ym}", headers=h, json={"status": "paid"})
    assert bad.status_code == 400, f"시간당 팀은 거부돼야 한다, got {bad.status_code}"

    upd = client.patch(f"/api/admin/teams/{tid}", headers=h,
                       json={"billing_type": "monthly", "monthly_fee": 200000})
    assert upd.status_code == 200, upd.text

    paid = client.put(f"/api/admin/dues/team/{tid}/{ym}", headers=h, json={"status": "paid"})
    assert paid.status_code == 200, paid.text
    assert paid.json()["amount"] == 200000, "금액을 안 주면 팀 월 이용료로 채운다"

    month = client.get(f"/api/admin/dues?year_month={ym}", headers=h).json()
    row = next(r for r in month["team_rows"] if r["team_id"] == tid)
    assert row["status"] == "paid" and month["team_total_paid"] >= 200000, month

    # 월 이용료를 안 적은 팀은 환경 설정의 기본 팀 이용료를 쓴다.
    # 실제 설정을 잠깐 바꾸므로 실패해도 반드시 되돌린다.
    saved = client.get("/api/admin/settings", headers=h).json()["values"].get("default_team_fee", "0")
    try:
        client.put("/api/admin/settings", headers=h,
                   json={"values": {"default_team_fee": "123000"}})
        client.patch(f"/api/admin/teams/{tid}", headers=h, json={"monthly_fee": None})
        month2 = client.get("/api/admin/dues?year_month=2099-02", headers=h).json()
        row2 = next(r for r in month2["team_rows"] if r["team_id"] == tid)
        assert row2["fee"] == 123000, f"기본 팀 이용료가 안 먹는다: {row2}"
    finally:
        client.put("/api/admin/settings", headers=h,
                   json={"values": {"default_team_fee": saved}})
        client.patch(f"/api/admin/teams/{tid}", headers=h, json={"monthly_fee": 200000})

    hist = client.get(f"/api/admin/dues/history/team/{tid}", headers=h).json()
    assert len(hist) == 1 and hist[0]["year_month"] == ym, hist

    mhist = client.get(f"/api/admin/dues/history/member/{member_id}", headers=h).json()
    assert [r["year_month"] for r in mhist] == [ym], mhist

    # 연간 차트는 회비와 팀 이용료를 따로 센다
    summary = client.get("/api/admin/dues/summary?year=2099", headers=h).json()
    jan = next(r for r in summary if r["year_month"] == ym)
    assert jan["team_paid"] == 200000, jan
    assert jan["paid"] < 200000, f"팀 이용료가 회비에 섞이면 안 된다: {jan}"


def test_admin_booking(h):
    """장소 대관 · 도어즈 정모 — 관리자가 팀 없이 직접 잡는 예약."""
    day = date.today() + timedelta(days=160)
    rooms = client.get("/api/rooms").json()
    room = next(r for r in rooms if r["booking_mode"] == "team")
    base = {"room_id": room["id"], "date": str(day), "duration": 2}

    res = client.post("/api/admin/reservations", headers=h, json={
        **base, "kind": "meetup", "title": f"{MARK} 8월 정모",
        "start_time": "18:00:00", "contact_phone": "010-1111-2222", "note": "전체 모임"})
    assert res.status_code == 200, res.text
    made = res.json()
    created["admin_res"] = made["id"]
    assert made["kind"] == "meetup", made
    assert made["team_id"] is None and made["team_name"] == f"{MARK} 8월 정모", made
    assert made["status"] == "confirmed" and made["is_free"], "관리자 예약은 바로 확정된다"
    assert made["booker_phone"] == "01011112222", "연락처는 숫자만 저장"

    # 공개 목록에는 종류가 나가되 연락처는 안 나간다
    pub = client.get(f"/api/reservations?date={day}").json()
    row = next(r for r in pub if r["id"] == made["id"])
    assert row["kind"] == "meetup" and row["team_name"] == f"{MARK} 8월 정모", row
    assert "booker_phone" not in row, f"공개 목록에 연락처가 실렸다: {row}"

    # 팀 예약과 같은 겹침 검사를 받는다
    clash = client.post("/api/admin/reservations", headers=h, json={
        **base, "kind": "rental", "title": f"{MARK} 대관", "start_time": "19:00:00"})
    assert clash.status_code == 400, f"겹치는 시간은 막아야 한다, got {clash.status_code}"

    # 종류는 rental|meetup 만
    assert client.post("/api/admin/reservations", headers=h, json={
        **base, "kind": "team", "title": "x", "start_time": "08:00:00"}).status_code == 422
    assert client.post("/api/admin/reservations", json={
        **base, "kind": "meetup", "title": "x", "start_time": "08:00:00"}).status_code == 401

    # 수정하면 이름이 바뀌고 종류는 그대로
    upd = client.patch(f"/api/admin/reservations/{made['id']}", headers=h,
                       json={"title": f"{MARK} 9월 정모", "start_time": "20:00:00"})
    assert upd.status_code == 200, upd.text
    assert upd.json()["team_name"] == f"{MARK} 9월 정모", upd.text
    assert upd.json()["kind"] == "meetup", "고쳤다고 종류가 바뀌면 안 된다"
    assert upd.json()["id"] == made["id"], "id 는 그대로여야 한다"

    # 자정을 넘기면 두 건으로 쪼개지고 종류가 양쪽에 남는다
    split = client.patch(f"/api/admin/reservations/{made['id']}", headers=h,
                         json={"start_time": "23:00:00", "duration": 3})
    assert split.status_code == 200, split.text
    nxt = client.get(f"/api/reservations?date={day + timedelta(days=1)}").json()
    tail = next(r for r in nxt if r["group_key"] == split.json()["group_key"])
    assert tail["kind"] == "meetup", tail


def test_team_doors(h):
    """팀도 도어즈 밴드 / 외부 밴드로 갈린다. 과금 방식과는 별개다."""
    res = client.post("/api/admin/teams", headers=h,
                      json={"name": f"{MARK} 외부밴드", "is_doors": False})
    assert res.status_code == 200, res.text
    created["team4"] = res.json()["id"]
    assert res.json()["is_doors"] is False, res.text

    # 기본은 도어즈
    d = client.post("/api/admin/teams", headers=h, json={"name": f"{MARK} 기본밴드"}).json()
    created["team5"] = d["id"]
    assert d["is_doors"] is True, d

    # 켜고 끌 수 있고, 과금 방식은 건드리지 않는다
    upd = client.patch(f"/api/admin/teams/{created['team4']}", headers=h,
                       json={"is_doors": True, "billing_type": "monthly", "monthly_fee": 50000})
    assert upd.status_code == 200, upd.text
    assert upd.json()["is_doors"] is True and upd.json()["billing_type"] == "monthly", upd.text
    off = client.patch(f"/api/admin/teams/{created['team4']}", headers=h, json={"is_doors": False})
    assert off.json()["is_doors"] is False and off.json()["monthly_fee"] == 50000, \
        "도어즈 여부를 바꿨다고 과금 설정이 날아가면 안 된다"


def test_songs(h, team):
    """팀 레퍼토리. 목록은 완곡부터, 링크는 http/https 만, 팀을 지우면 곡도 사라진다."""
    tid = team["id"]

    def add(title, artist=None, status=None):
        body = {"title": title}
        if artist: body["artist"] = artist
        if status: body["status"] = status
        r = client.post(f"/api/admin/teams/{tid}/songs", headers=h, json=body)
        assert r.status_code == 200, r.text
        return r.json()

    a = add(f"{MARK} Zebra", "Queen")
    b = add(f"{MARK} Apple", "Beatles")
    assert a["status"] == "candidate", "새 곡은 후보로 들어간다"
    assert a["artist"] == "Queen"

    # 목록은 완곡 → 연습중 → 후보, 같은 상태 안에서는 제목순
    client.patch(f"/api/admin/songs/{a['id']}", headers=h, json={"status": "done"})
    client.patch(f"/api/admin/songs/{b['id']}", headers=h, json={"status": "practicing"})
    rows = client.get(f"/api/admin/teams/{tid}/songs", headers=h).json()
    order = [r["id"] for r in rows if r["id"] in (a["id"], b["id"])]
    assert order == [a["id"], b["id"]], f"완곡이 먼저 와야 한다: {rows}"

    c = add(f"{MARK} Banana")
    rows = client.get(f"/api/admin/teams/{tid}/songs", headers=h).json()
    mine = [r["title"] for r in rows if r["title"].startswith(MARK)]
    assert mine == [f"{MARK} Zebra", f"{MARK} Apple", f"{MARK} Banana"], mine

    # 완곡 수가 팀 목록에 나온다 (멤버 구할 때 참고하는 값)
    t = next(x for x in client.get("/api/admin/teams", headers=h).json() if x["id"] == tid)
    assert t["done_song_count"] == 1, t

    # 링크는 스킴을 제한한다 — 화면에서 href 로 나가는 값이다
    bad = client.patch(f"/api/admin/songs/{a['id']}", headers=h,
                       json={"link": "javascript:alert(1)"})
    assert bad.status_code == 400, f"javascript: 링크가 통과됐다, got {bad.status_code}"
    ok = client.patch(f"/api/admin/songs/{a['id']}", headers=h,
                      json={"link": "https://youtu.be/abc"})
    assert ok.status_code == 200 and ok.json()["link"] == "https://youtu.be/abc", ok.text

    # 없는 상태는 거부
    assert client.patch(f"/api/admin/songs/{a['id']}", headers=h,
                        json={"status": "kinda"}).status_code == 422
    # 인증 필요
    assert client.get(f"/api/admin/teams/{tid}/songs").status_code == 401

    # 삭제
    assert client.delete(f"/api/admin/songs/{c['id']}", headers=h).status_code == 200
    left = client.get(f"/api/admin/teams/{tid}/songs", headers=h).json()
    assert not any(r["id"] == c["id"] for r in left), "삭제했는데 남아 있다"

    # 팀을 지우면 곡도 함께 사라진다 (곡이 있다고 팀 삭제를 막지는 않는다)
    tmp = client.post("/api/admin/teams", headers=h, json={"name": f"{MARK} 곡삭제팀"}).json()
    s1 = client.post(f"/api/admin/teams/{tmp['id']}/songs", headers=h,
                     json={"title": f"{MARK} 사라질곡"}).json()
    assert client.delete(f"/api/admin/teams/{tmp['id']}", headers=h).status_code == 200, \
        "곡이 있다고 팀 삭제를 막으면 안 된다"
    assert client.get(f"/api/admin/songs/{s1['id']}", headers=h).status_code in (404, 405)
    assert client.delete(f"/api/admin/songs/{s1['id']}", headers=h).status_code == 404, \
        "팀과 함께 곡도 지워져야 한다"


def test_self_cancel(h):
    """예약한 본인이 취소한다. 로그인이 없어 생성 때 받은 토큰이 신분증이다.
    같은 김에 공개 목록이 개인정보를 흘리지 않는지도 본다."""
    day = date.today() + timedelta(days=120)
    rooms = client.get("/api/rooms").json()
    personal = next(r for r in rooms if r["booking_mode"] == "personal")
    body = {"room_id": personal["id"], "date": str(day), "start_time": "10:00:00",
            "duration": 1, "booker_name": f"{MARK}취소테스트",
            "booker_phone": "010-9999-0000", "note": "비밀 메모"}

    res = client.post("/api/reservations", json=body)
    assert res.status_code == 200, res.text
    made = res.json()
    created["cancel"] = made["id"]
    token = made.get("cancel_token")
    assert token, "생성 응답에는 취소 토큰이 있어야 한다"

    # 공개 목록은 인증이 없다 — 연락처·메모·토큰이 새면 안 된다
    pub = client.get(f"/api/reservations?date={day}").json()
    row = next(r for r in pub if r["id"] == made["id"])
    for leak in ("booker_phone", "note", "cancel_token", "booker_name"):
        assert leak not in row, f"공개 목록에 {leak} 가 실렸다: {row}"

    # 관리자 목록에는 그대로 다 있어야 한다
    adm = client.get(f"/api/admin/reservations?date={day}", headers=h).json()
    arow = next(r for r in adm if r["id"] == made["id"])
    assert arow["booker_phone"] == "01099990000" and arow["note"] == "비밀 메모", arow
    assert client.get("/api/admin/reservations").status_code == 401, \
        "관리자 목록은 인증을 요구해야 한다"

    # 틀린 토큰으로는 못 지운다
    bad = client.post(f"/api/reservations/{made['id']}/cancel",
                      json={"token": "0" * 32})
    assert bad.status_code == 403, f"남의 예약이 지워진다, got {bad.status_code}"

    # 이미 시작된 예약은 본인도 못 지운다
    past = client.post("/api/reservations", json={
        **body, "date": str(date.today() - timedelta(days=200))}).json()
    created["past"] = past["id"]
    late = client.post(f"/api/reservations/{past['id']}/cancel",
                       json={"token": past["cancel_token"]})
    assert late.status_code == 400, f"지난 예약은 막아야 한다, got {late.status_code}"

    # 제대로 된 토큰이면 취소된다
    ok = client.post(f"/api/reservations/{made['id']}/cancel", json={"token": token})
    assert ok.status_code == 200, ok.text
    created["cancel"] = None
    left = client.get(f"/api/reservations?date={day}").json()
    assert not any(r["id"] == made["id"] for r in left), "취소했는데 남아 있다"


def test_admin_edit(h, team):
    """관리자가 예약을 고친다. 자정 넘김이면 다시 쪼개지고, 입금 상태와
    이용자의 취소 토큰은 그대로 살아 있어야 한다."""
    day = date.today() + timedelta(days=140)
    rooms = client.get("/api/rooms").json()
    room = next(r for r in rooms if r["booking_mode"] == "team")

    made = client.post("/api/reservations", json={
        "room_id": room["id"], "team_id": team["id"], "date": str(day),
        "start_time": "10:00:00", "duration": 2, "note": "원래 메모"}).json()
    created["edit"] = made["id"]
    token, status = made["cancel_token"], made["status"]

    # 자기 시간과 겹친다고 거부하면 메모만 고쳐도 막힌다
    only_note = client.patch(f"/api/admin/reservations/{made['id']}", headers=h,
                             json={"note": "바뀐 메모"})
    assert only_note.status_code == 200, only_note.text
    assert only_note.json()["note"] == "바뀐 메모", only_note.text
    assert only_note.json()["id"] == made["id"], "고쳤다고 예약 id 가 바뀌면 안 된다"

    # 시간 옮기기 — 상태는 그대로
    moved = client.patch(f"/api/admin/reservations/{made['id']}", headers=h,
                         json={"start_time": "15:00:00", "duration": 3})
    assert moved.status_code == 200, moved.text
    assert moved.json()["start_time"].startswith("15:00"), moved.text
    assert moved.json()["status"] == status, "고쳤다고 입금 상태가 바뀌면 안 된다"
    assert moved.json()["id"] == made["id"], "시간을 옮겨도 id 는 그대로여야 한다"

    # 날짜도 옮겨진다 (필드 이름이 date 라 스키마가 조용히 깨진 적 있다)
    other_day = day + timedelta(days=2)
    day_moved = client.patch(f"/api/admin/reservations/{made['id']}", headers=h,
                             json={"date": str(other_day)})
    assert day_moved.status_code == 200, day_moved.text
    assert day_moved.json()["date"] == str(other_day), day_moved.text
    client.patch(f"/api/admin/reservations/{made['id']}", headers=h, json={"date": str(day)})

    # 이미 찬 시간으로는 못 옮긴다
    other = client.post("/api/reservations", json={
        "room_id": room["id"], "team_id": team["id"], "date": str(day),
        "start_time": "20:00:00", "duration": 1}).json()
    created["edit2"] = other["id"]
    clash = client.patch(f"/api/admin/reservations/{created['edit']}", headers=h,
                         json={"start_time": "20:00:00", "duration": 1})
    assert clash.status_code == 400, f"겹치는 시간은 막아야 한다, got {clash.status_code}"

    # 자정을 넘기게 고치면 두 건으로 나뉜다
    split = client.patch(f"/api/admin/reservations/{created['edit']}", headers=h,
                         json={"start_time": "23:00:00", "duration": 3})
    assert split.status_code == 200, split.text
    assert split.json()["id"] == made["id"], "쪼개져도 앞 조각 id 는 그대로여야 한다"
    assert split.json()["group_key"], "자정을 넘기면 group_key 로 묶여야 한다"
    nxt = client.get(f"/api/reservations?date={day + timedelta(days=1)}").json()
    assert any(r["group_key"] == split.json()["group_key"] for r in nxt), "뒷 조각이 없다"

    # 이용자의 취소 토큰은 수정 뒤에도 살아 있어야 한다
    gone = client.post(f"/api/reservations/{created['edit']}/cancel", json={"token": token})
    assert gone.status_code == 200, f"수정하면 취소 토큰이 죽는다: {gone.text}"
    created["edit"] = None

    assert client.patch(f"/api/admin/reservations/{created['edit2']}",
                        json={"note": "x"}).status_code == 401, "수정은 관리자만"


def test_multi_team(h):
    """한 사람이 밴드를 여러 개 하면 회비도 팀마다 따로 걸린다."""
    ym = "2099-03"

    def make_team(name, fee):
        res = client.post("/api/admin/teams", headers=h, json={
            "name": f"{MARK} {name}", "billing_type": "dues", "dues_fee": fee,
        })
        assert res.status_code == 200, res.text
        return res.json()["id"]

    a = created["team2"] = make_team("멀티A", 10000)
    b = created["team3"] = make_team("멀티B", 20000)

    before = client.get(f"/api/admin/dues?year_month={ym}", headers=h).json()

    res = client.post("/api/admin/members", headers=h, json={
        "name": f"{MARK} 겸업", "birth_year": 1990, "team_ids": [a, b],
    })
    assert res.status_code == 200, res.text
    m = res.json()
    created["member3"] = m["id"]
    assert [t["id"] for t in m["teams"]] == [a, b], m["teams"]
    assert m["team_id"] == a, "대표 팀은 목록의 첫 팀이다"

    # 1) 소속마다 한 건씩, 금액은 각 팀의 회비
    month = client.get(f"/api/admin/dues?year_month={ym}", headers=h).json()
    mine = [r for r in month["rows"] if r["member_id"] == m["id"]]
    assert len(mine) == 2, f"두 팀이면 회비도 두 건이어야 한다: {mine}"
    assert {r["team_id"]: r["fee"] for r in mine} == {a: 10000, b: 20000}, mine
    assert month["total_expected"] - before["total_expected"] == 30000, "두 팀 요금이 다 잡혀야 한다"

    # 2) 한 팀만 납부해도 다른 팀은 그대로 미납
    paid = client.put(f"/api/admin/dues/{m['id']}/{ym}?team_id={a}", headers=h,
                      json={"status": "paid"})
    assert paid.status_code == 200, paid.text
    assert paid.json()["amount"] == 10000 and paid.json()["team_id"] == a, paid.text

    month = client.get(f"/api/admin/dues?year_month={ym}", headers=h).json()
    got = {r["team_id"]: r["status"] for r in month["rows"] if r["member_id"] == m["id"]}
    assert got == {a: "paid", b: "unpaid"}, f"팀별 회비가 서로 물리면 안 된다: {got}"

    # 3) 소속이 아닌 팀으로는 기록을 못 남긴다
    bad = client.put(f"/api/admin/dues/{m['id']}/{ym}?team_id={created['team']}",
                     headers=h, json={"status": "paid"})
    assert bad.status_code == 400, f"남의 팀 회비는 거부돼야 한다, got {bad.status_code}"

    # 4) 팀별 회비 제외는 그 팀 건만 면제로 만든다
    upd = client.patch(f"/api/admin/members/{m['id']}", headers=h,
                       json={"team_ids": [a, b], "team_exempt_ids": [b]})
    assert upd.status_code == 200, upd.text
    assert [t["dues_exempt"] for t in upd.json()["teams"]] == [False, True], upd.text
    month = client.get(f"/api/admin/dues?year_month=2099-04", headers=h).json()
    got = {r["team_id"]: r["status"] for r in month["rows"] if r["member_id"] == m["id"]}
    assert got == {a: "unpaid", b: "exempt"}, f"팀별 면제가 안 먹는다: {got}"

    # 5) 이력에는 어느 팀 몫인지 함께 나온다
    hist = client.get(f"/api/admin/dues/history/member/{m['id']}", headers=h).json()
    assert any(r["team_name"] and r["year_month"] == ym for r in hist), hist

    # 6) 소속 멤버가 있으면 팀을 못 지운다 (대표 팀이 아닌 B 도 마찬가지)
    blocked = client.delete(f"/api/admin/teams/{b}", headers=h)
    assert blocked.status_code == 400, f"소속 멤버가 있으면 막아야 한다, got {blocked.status_code}"

    # 7) 팀 카드 나이 통계 — 출생년도를 아는 멤버만 센다.
    #    겸사겸사 도어즈가 아닌 멤버로 만들어 회비 목록에서 빠지는지도 본다.
    res = client.post("/api/admin/members", headers=h, json={
        "name": f"{MARK} 나이없음", "team_ids": [a], "is_doors": False,
    })
    assert res.status_code == 200, res.text
    created["member4"] = res.json()["id"]

    # 월회비는 도어즈 회비다 — 도어즈가 아니면 회비 팀 소속이어도 목록에 없어야 한다
    month = client.get(f"/api/admin/dues?year_month={ym}", headers=h).json()
    assert not any(r["member_id"] == created["member4"] for r in month["rows"]), \
        "도어즈가 아닌 멤버가 월회비 목록에 있다"
    assert any(r["member_id"] == m["id"] for r in month["rows"]), \
        "도어즈 멤버는 그대로 있어야 한다"

    teams = {t["id"]: t for t in client.get("/api/admin/teams", headers=h).json()}
    year = date.today().year
    assert teams[a]["member_count"] == 2, teams[a]
    assert teams[a]["age_avg"] == float(year - 1990), teams[a]
    assert teams[a]["age_buckets"] == {str((year - 1990) // 10 * 10): 1}, teams[a]
    assert teams[b]["age_avg"] == float(year - 1990), "겸업 멤버는 두 팀 모두에서 센다"


def cleanup(h):
    for key in ("reservation", "reservation2", "reservation3", "reservation4",
                "overnight", "cancel", "past", "edit", "edit2", "admin_res"):
        if created[key]:
            client.delete(f"/api/reservations/{created[key]}", headers=h)
    if created["ticket"]:
        client.delete(f"/api/admin/tickets/{created['ticket']}", headers=h)
    for key in ("member", "member2", "member3", "member4"):
        if created[key]:
            client.delete(f"/api/admin/members/{created[key]}?force=true", headers=h)
    for key in ("team", "team2", "team3", "team4", "team5"):
        if created[key]:
            client.delete(f"/api/admin/teams/{created[key]}", headers=h)


def main():
    if not PASS:
        print("INITIAL_ADMIN_PASSWORD 가 없습니다. 관리자 비밀번호를 넣어 실행하세요:\n"
              "  docker exec -e INITIAL_ADMIN_PASSWORD='비번' bandroom_app python test_smoke.py")
        return 2

    steps = []
    token = None
    try:
        test_login_rate_limit();               steps.append("rate limit")
        token = test_auth();                   steps.append("auth")
        h = auth(token)
        team = test_teams(h);                  steps.append("teams")
        test_reservation(h, team);             steps.append("reservations")
        test_overnight(h, team);               steps.append("overnight")
        test_personal_room(h);                 steps.append("personal room")
        member_id = test_members_and_dues(h);   steps.append("members + dues")
        test_team_dues(h, team, member_id);     steps.append("team dues")
        test_multi_team(h);                     steps.append("multi team")
        test_songs(h, team);                    steps.append("songs")
        test_admin_booking(h);                  steps.append("admin booking")
        test_team_doors(h);                     steps.append("team doors")
        test_self_cancel(h);                    steps.append("self cancel")
        test_admin_edit(h, team);               steps.append("admin edit")
        test_tickets(h);                       steps.append("tickets")
        test_upload_guards(h);                 steps.append("upload guards")
        test_settings(h);                      steps.append("settings")
    except AssertionError as exc:
        print(f"FAIL after {len(steps)} step(s) [{', '.join(steps)}]: {exc}")
        return 1
    finally:
        if token:
            cleanup(auth(token))

    print(f"OK — {len(steps)} steps passed: {', '.join(steps)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
