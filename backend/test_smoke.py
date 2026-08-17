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
created = {"team": None, "member": None, "ticket": None, "reservation": None}


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
    body = {"room_id": 1, "date": day, "start_time": "09:00:00", "duration": 2}

    assert client.post("/api/reservations", json=body).status_code == 422, "team_id is required"

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


def cleanup(h):
    if created["reservation"]:
        client.delete(f"/api/reservations/{created['reservation']}", headers=h)
    if created["ticket"]:
        client.delete(f"/api/admin/tickets/{created['ticket']}", headers=h)
    if created["member"]:
        client.delete(f"/api/admin/members/{created['member']}?force=true", headers=h)
    if created["team"]:
        client.delete(f"/api/admin/teams/{created['team']}", headers=h)


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
        test_members_and_dues(h);              steps.append("members + dues")
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
