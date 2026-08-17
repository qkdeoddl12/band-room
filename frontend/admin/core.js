'use strict';

/* ============================================================
   Core: state, helpers, auth, page routing
   Loaded first — every other admin/*.js file depends on this.
   ============================================================ */
let authToken   = '';
let currentUser = null;     // {id, username, role, is_active}
let currentPage = 'dashboard';

let allReservations = [];
let allUsers        = [];
let allBlocked      = [];
let allInquiries    = [];

let roomsById = {};         // {1: {id, name, hourly_price}, ...}
let teamsById = {};         // {1: {id, name, billing_type, ...}, ...}
let appSettings = {};       // 요금 기본값 등 (환경 설정에서 관리)

/* 과금 방식 표기는 여기 한 곳. 파일마다 따로 두면 문구가 갈린다. */
const BILLING = {
  hourly:  { label: '시간당',    cls: 'default' },
  monthly: { label: '월 이용료',  cls: 'monthly' },
  dues:    { label: '월회비',    cls: 'dues'    },
};

const DAY_KO = ['일','월','화','수','목','금','토'];

/* Each page module registers itself here so core.js does not need to know
   which functions exist in which file. */
const PAGE_LOADERS = {};

/* ============================================================
   Helpers
   ============================================================ */
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function ymStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function fmtTime(t) { return String(t).substring(0, 5); }
/* 종료 00:00 은 '그날 24시'라는 뜻이라 그대로 두면 00:00 으로 보인다. */
function fmtEndTime(t) { return fmtTime(t) === '00:00' ? '24:00' : fmtTime(t); }
function fmtDateKo(s) {
  const d = new Date(s + 'T00:00:00');
  return `${d.getMonth()+1}월 ${d.getDate()}일 (${DAY_KO[d.getDay()]})`;
}
function fmtDateTime(s) {
  const d = new Date(s);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
}
function fmtRelative(iso) {
  const d = new Date(iso);
  const diff = Math.max(0, Date.now() - d.getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return '방금 전';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const dy = Math.floor(h / 24);
  if (dy < 30) return `${dy}일 전`;
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
}
/* DB 에는 숫자만 저장한다. 보여줄 때만 하이픈을 넣는다.
   번호처럼 안 생긴 값은 손대지 않고 그대로 돌려준다. */
function formatPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^[\d\s\-()+.]+$/.test(raw)) return raw;

  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+') || d.length < 8) return raw;

  if (d.startsWith('02')) {                                  // 서울 국번
    if (d.length === 9)  return `${d.slice(0,2)}-${d.slice(2,5)}-${d.slice(5)}`;
    if (d.length === 10) return `${d.slice(0,2)}-${d.slice(2,6)}-${d.slice(6)}`;
  }
  if (/^1[5-9]\d{2}/.test(d) && d.length === 8) {             // 1588 같은 대표번호
    return `${d.slice(0,4)}-${d.slice(4)}`;
  }
  if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
  return raw;
}

/* 입력하는 동안 자동으로 하이픈을 넣어준다. */
function attachPhoneMask(input) {
  if (!input) return;
  input.addEventListener('input', () => {
    const atEnd = input.selectionStart === input.value.length;
    const formatted = formatPhone(input.value);
    if (formatted !== input.value) {
      input.value = formatted;
      if (atEnd) input.setSelectionRange(formatted.length, formatted.length);
    }
  });
}

/* ============================================================
   포지션(파트) 피커 — 팀·멤버가 같은 UI 와 같은 콤마 문자열을 쓴다.
   고정 항목은 체크박스, 그 외는 자유 입력으로 받는다.
   ============================================================ */
/* 한 팀에 기타가 둘일 수 있어 리드·세컨을 따로 둔다.
   저장은 콤마 문자열이고 같은 값만 중복 제거되므로 셋은 공존한다. */
const FIXED_PARTS = ['보컬', '기타', '리드기타', '세컨기타', '베이스', '드럼', '키보드'];

function splitParts(parts) {
  return String(parts || '').split(',').map(s => s.trim()).filter(Boolean);
}

/* 저장된 값 중 고정 항목은 체크하고, 나머지는 자유 입력칸에 되돌려 놓는다. */
function renderPartPicker(boxId, textId, parts) {
  const all    = splitParts(parts);
  const fixed  = new Set(all.filter(p => FIXED_PARTS.includes(p)));
  const custom = all.filter(p => !FIXED_PARTS.includes(p));

  document.getElementById(boxId).innerHTML = FIXED_PARTS.map(p => `
    <label class="part-check${fixed.has(p) ? ' active' : ''}">
      <input type="checkbox" value="${escHtml(p)}" ${fixed.has(p) ? 'checked' : ''}
             onchange="this.closest('.part-check').classList.toggle('active', this.checked)">
      <span>${escHtml(p)}</span>
    </label>
  `).join('');
  document.getElementById(textId).value = custom.join(', ');
}

function readPartPicker(boxId, textId) {
  const checked = [...document.querySelectorAll(`#${boxId} input:checked`)].map(i => i.value);
  const custom  = splitParts(document.getElementById(textId).value);
  return [...new Set([...checked, ...custom])].join(',');
}

/* 목록에 뿌릴 태그. 고정 항목이 아닌 것은 다른 색으로 구분한다. */
function partTagsHtml(parts) {
  const all = splitParts(parts);
  if (!all.length) return '<span class="part-tag empty">포지션 미지정</span>';
  return all.map(p =>
    `<span class="part-tag${FIXED_PARTS.includes(p) ? '' : ' custom'}">${escHtml(p)}</span>`
  ).join('');
}

function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showToast(msg, type='success') {
  const el = document.getElementById('adminToast');
  el.textContent = msg;
  el.className   = `admin-toast ${type} show`;
  setTimeout(() => { el.className = 'admin-toast'; }, 3000);
}

function openOverlay(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeOverlay(id) {
  document.getElementById(id).classList.remove('open');
  document.body.style.overflow = '';
}
/* Backdrop click closes — call once per overlay at module load. */
function bindOverlayClose(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', e => { if (e.target === e.currentTarget) (fn || (() => closeOverlay(id)))(); });
}

function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (authToken) headers['X-Auth-Token'] = authToken;
  // FormData 는 브라우저가 boundary 를 포함한 multipart Content-Type 을 직접 붙인다.
  // 여기서 application/json 을 씌우면 서버가 본문을 파싱하지 못해 422 가 난다.
  const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  if (opts.body && !isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(path, { ...opts, headers });
}

/* Throws with the server's `detail` message so callers can just toast e.message. */
async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  if (!res.ok) {
    if (res.status === 401) { forceLogout(); throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.'); }
    let detail = '요청에 실패했습니다.';
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

/* ============================================================
   Rooms (prices come from the API, not hardcoded)
   ============================================================ */
async function loadRooms() {
  try {
    const rooms = await apiJson('/api/rooms');
    roomsById = Object.fromEntries(rooms.map(r => [r.id, r]));
  } catch { roomsById = {}; }
}

/* 팀·멤버 등록창의 기본 금액 채우기에 쓴다. system 이 아니면 못 읽으므로 조용히 넘긴다. */
async function loadAppSettings() {
  try {
    const data = await apiJson('/api/admin/settings');
    appSettings = data.values || {};
  } catch { appSettings = {}; }
}

function settingNum(key, fallback = 0) {
  const n = Number(appSettings[key]);
  return Number.isFinite(n) ? n : fallback;
}

/* 팀 목록을 한 번 받아 캐시까지 채운다.
   예전엔 loadTeams() 와 이 함수가 같은 요청을 각각 보내고 있었다. */
async function loadTeamsCache() {
  try {
    teamsById = Object.fromEntries(
      (await apiJson('/api/admin/teams')).map(t => [t.id, t]),
    );
  } catch { teamsById = {}; }
}

function cacheTeams(teams) {
  teamsById = Object.fromEntries(teams.map(t => [t.id, t]));
}

function roomName(id) {
  if (id === null || id === undefined) return '전체 공간';
  return roomsById[id]?.name || `공간 ${id}`;
}
/* 방 id 를 박아두면 DB 를 새로 만들거나 방을 추가했을 때 색이 어긋난다.
   예약 페이지와 같이 목록 순서로 정한다. null 은 '전체 공간'. */
function roomTagCls(id) {
  if (id === null || id === undefined) return 'all';
  const idx = Object.values(roomsById).sort((a, b) => a.id - b.id)
    .findIndex(r => r.id === id);
  return `r${Math.min(2, Math.max(1, idx + 1))}`;
}
function roomPrice(id)  { return roomsById[id]?.hourly_price || 0; }
/* 예약 시점에 정해진 is_free 만 본다.
   지금의 팀 과금 방식을 다시 조회하면, 팀을 월정액으로 바꾸는 순간
   그 팀의 과거 시간당 예약까지 매출에서 사라진다. */
function resFee(r) {
  if (r.is_free) return 0;
  return roomPrice(r.room_id) * (r.duration || 0);
}
function resFeeLabel(r) {
  const fee = resFee(r);
  if (fee > 0) return `${fee.toLocaleString()}원`;
  if (r.member_id) return '회비 납부 멤버';
  return BILLING[teamsById[r.team_id]?.billing_type]?.label || '무료';
}

/* ============================================================
   Auth
   ============================================================ */
async function init() {
  const stored = sessionStorage.getItem('bandroom_admin_token');
  if (!stored) { showLogin(); return; }

  authToken = stored;
  try {
    const res = await api('/api/admin/me');
    if (res.status === 403) { showChangePassword(); return; }
    if (!res.ok) throw new Error();
    currentUser = await res.json();
    await showDashboard();
  } catch {
    sessionStorage.removeItem('bandroom_admin_token');
    authToken = '';
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('changePwScreen').style.display = 'none';
  document.getElementById('adminDashboard').classList.remove('show');
  document.getElementById('loginPassword').value = '';
}

function showChangePassword() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('changePwScreen').style.display = 'flex';
  document.getElementById('adminDashboard').classList.remove('show');
  document.getElementById('newPw').value = '';
  document.getElementById('confirmPw').value = '';
  document.getElementById('changePwError').classList.remove('show');
}

async function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('changePwScreen').style.display = 'none';
  document.getElementById('adminDashboard').classList.add('show');

  document.getElementById('adminUsername').textContent = currentUser.username;
  const badge = document.getElementById('adminRoleBadge');
  if (currentUser.role === 'system') {
    badge.textContent = '시스템 관리자';
    badge.className   = 'user-role-badge system';
  } else {
    badge.textContent = '예약 관리자';
    badge.className   = 'user-role-badge reservation';
  }

  document.querySelectorAll('.system-only').forEach(el => {
    el.style.display = currentUser.role === 'system' ? '' : 'none';
  });

  await Promise.all([loadRooms(), loadTeamsCache(), loadAppSettings()]);
  switchPage('dashboard');
  refreshInquiryBadge();
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');

  btn.disabled = true; btn.textContent = '확인 중...';
  err.classList.remove('show');

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '로그인 실패');
    }
    const data = await res.json();
    authToken = data.token;
    sessionStorage.setItem('bandroom_admin_token', data.token);

    if (data.must_change_password) { showChangePassword(); return; }

    const me = await api('/api/admin/me');
    currentUser = await me.json();
    await showDashboard();
  } catch (e) {
    err.textContent = e.message;
    err.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = '로그인';
  }
});

async function logout() {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  forceLogout();
}

/* Session gone (expired / revoked) — drop local state and show the gate. */
function forceLogout() {
  sessionStorage.removeItem('bandroom_admin_token');
  authToken = ''; currentUser = null;
  showLogin();
}

document.getElementById('changePwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw1 = document.getElementById('newPw').value;
  const pw2 = document.getElementById('confirmPw').value;
  const err = document.getElementById('changePwError');
  const btn = document.getElementById('changePwBtn');

  if (pw1 !== pw2) {
    err.textContent = '비밀번호가 일치하지 않습니다.';
    err.classList.add('show');
    return;
  }

  btn.disabled = true; btn.textContent = '설정 중...';
  err.classList.remove('show');

  try {
    const res = await api('/api/admin/change-password', {
      method: 'POST',
      body: JSON.stringify({ new_password: pw1 }),
    });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '비밀번호 변경 실패');
    }
    currentUser = await res.json();
    await showDashboard();
    showToast('비밀번호가 설정되었습니다.', 'success');
  } catch (e) {
    err.textContent = e.message;
    err.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = '비밀번호 설정';
  }
});

function cancelChangePassword() {
  forceLogout();
}

/* ============================================================
   Page Switching
   ============================================================ */
const SYSTEM_ONLY_PAGES = ['users', 'settings', 'blocked', 'audit'];

function switchPage(page) {
  if (SYSTEM_ONLY_PAGES.includes(page) && currentUser?.role !== 'system') return;
  currentPage = page;

  document.querySelectorAll('.admin-page').forEach(p => p.style.display = 'none');
  const el = document.getElementById(page + 'Page');
  if (el) el.style.display = 'block';

  document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
  document.querySelectorAll('.mobile-nav-item[data-mtab]').forEach(item => {
    item.classList.toggle('active', item.dataset.mtab === page);
  });

  closeMoreMenu();
  PAGE_LOADERS[page]?.();
}

function switchPageMobile(page) {
  switchPage(page);
}

/* Mobile bottom nav has 5 slots; everything else lives behind "더보기". */
function openMoreMenu() { openOverlay('moreMenuOverlay'); }
function closeMoreMenu() {
  const el = document.getElementById('moreMenuOverlay');
  if (el && el.classList.contains('open')) closeOverlay('moreMenuOverlay');
}
bindOverlayClose('moreMenuOverlay');

/* ============================================================
   입금 이력 — 멤버 상세와 팀 상세가 같은 모양을 쓴다
   ============================================================ */
const DUES_LABEL = { paid: '납부', unpaid: '미납', pending: '확인중', exempt: '면제' };

async function renderDuesHistory(elId, path) {
  const box = document.getElementById(elId);
  if (!box) return;
  if (!path) { box.innerHTML = ''; return; }

  box.innerHTML = '<div class="dues-hist"><div class="dues-hist-head">입금 이력</div><div class="spinner"></div></div>';
  let rows;
  try {
    rows = await apiJson(path);
  } catch {
    box.innerHTML = '';   // 이력을 못 받아도 수정은 되어야 한다
    return;
  }

  const body = rows.length === 0
    ? '<div class="dues-hist-empty">아직 입금 기록이 없습니다.</div>'
    : rows.map(r => `
        <div class="dues-hist-row">
          <span class="dh-ym">${escHtml(r.year_month)}</span>
          <span class="dh-status ${r.status}">${DUES_LABEL[r.status] || r.status}</span>
          <span class="dh-amt">${r.amount ? r.amount.toLocaleString() + '원' : '—'}</span>
          <span class="dh-date">${r.paid_on ? escHtml(r.paid_on.slice(5)) : ''}</span>
        </div>
        ${r.memo ? `<div class="dh-memo">${escHtml(r.memo)}</div>` : ''}
      `).join('');

  box.innerHTML = `
    <div class="dues-hist">
      <div class="dues-hist-head">입금 이력<span>최근 ${rows.length}건</span></div>
      <div class="dues-hist-rows">${body}</div>
    </div>`;
}
