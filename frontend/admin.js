'use strict';

/* ============================================================
   State
   ============================================================ */
let authToken      = '';
let currentUser    = null;     // {id, username, role, is_active}
let currentPage    = 'dashboard';
let currentPeriod  = 'all';
let currentRoom    = 'all';
let currentStatus  = 'pending';

let allReservations = [];
let allUsers        = [];
let allBlocked      = [];
let allInquiries    = [];

let currentInqStatus = 'new';
let currentInqCat    = 'all';

let deleteTargetId        = null;
let confirmTargetId       = null;
let editTargetUserId      = null;
let deleteBlockedTargetId = null;

let calCursor = new Date();
calCursor.setDate(1);

let statsRange = 6;  // months

const ROOM_PRICES = { 1: 15000, 2: 8000 };

const DAY_KO   = ['일','월','화','수','목','금','토'];

/* ============================================================
   Helpers
   ============================================================ */
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtTime(t) { return String(t).substring(0, 5); }
function fmtDateKo(s) {
  const d = new Date(s + 'T00:00:00');
  return `${d.getMonth()+1}월 ${d.getDate()}일 (${DAY_KO[d.getDay()]})`;
}
function fmtDateTime(s) {
  const d = new Date(s);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
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

function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (authToken) headers['X-Auth-Token'] = authToken;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(path, { ...opts, headers });
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
    if (res.status === 403) {
      // Must change password
      showChangePassword();
      return;
    }
    if (!res.ok) throw new Error();
    currentUser = await res.json();
    showDashboard();
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

function showDashboard() {
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

  // Show/hide system-only menu items
  document.querySelectorAll('.system-only').forEach(el => {
    el.style.display = currentUser.role === 'system' ? '' : 'none';
  });

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

    if (data.must_change_password) {
      showChangePassword();
      return;
    }

    // Fetch full info
    const me = await api('/api/admin/me');
    currentUser = await me.json();

    showDashboard();
  } catch (e) {
    err.textContent = e.message;
    err.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = '로그인';
  }
});

async function logout() {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  sessionStorage.removeItem('bandroom_admin_token');
  authToken = ''; currentUser = null;
  showLogin();
}

/* ============================================================
   Change Password (first login)
   ============================================================ */
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
    showDashboard();
    showToast('비밀번호가 설정되었습니다.', 'success');
  } catch (e) {
    err.textContent = e.message;
    err.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = '비밀번호 설정';
  }
});

function cancelChangePassword() {
  sessionStorage.removeItem('bandroom_admin_token');
  authToken = '';
  showLogin();
}

/* ============================================================
   Page Switching
   ============================================================ */
function switchPage(page) {
  if (page === 'users' && currentUser?.role !== 'system') return;
  currentPage = page;

  document.querySelectorAll('.admin-page').forEach(p => p.style.display = 'none');
  document.getElementById(page + 'Page').style.display = 'block';

  document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
  document.querySelectorAll('.mobile-nav-item[data-mtab]').forEach(item => {
    item.classList.toggle('active', item.dataset.mtab === page);
  });

  if (page === 'dashboard')         loadDashboard();
  else if (page === 'reservations') loadAllReservations();
  else if (page === 'users')        loadUsers();
  else if (page === 'blocked')      loadBlocked();
  else if (page === 'calendar')     loadCalendar();
  else if (page === 'stats')        loadStats();
  else if (page === 'inquiries')    loadInquiries();
}

function switchPageMobile(page) {
  switchPage(page);
}

/* ============================================================
   Reservations: Load
   ============================================================ */
async function loadAllReservations() {
  document.getElementById('reservationList').innerHTML = '<div class="spinner"></div>';
  try {
    const res = await api('/api/reservations');
    if (!res.ok) throw new Error();
    allReservations = await res.json();
  } catch {
    allReservations = [];
    showToast('데이터를 불러오지 못했습니다.', 'error');
  }
  applyFilters();
}

/* ============================================================
   Dashboard: Load & Render
   ============================================================ */
async function loadDashboard() {
  try {
    const res = await api('/api/reservations');
    if (!res.ok) throw new Error();
    allReservations = await res.json();
  } catch {
    allReservations = [];
    showToast('데이터를 불러오지 못했습니다.', 'error');
  }
  renderDashboard();
}

function resFee(r) {
  return (ROOM_PRICES[r.room_id] || 0) * (r.duration || 0);
}

function dateRanges() {
  const today = new Date();
  const todayStr = toDateStr(today);
  const wkStart = new Date(today); wkStart.setDate(today.getDate() - today.getDay());
  const wkEnd   = new Date(wkStart); wkEnd.setDate(wkStart.getDate() + 6);
  const monStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monEnd   = new Date(today.getFullYear(), today.getMonth()+1, 0);
  return {
    today: todayStr,
    weekStart: toDateStr(wkStart), weekEnd: toDateStr(wkEnd),
    monthStart: toDateStr(monStart), monthEnd: toDateStr(monEnd),
  };
}

function renderDashboard() {
  const { today, weekStart, weekEnd, monthStart, monthEnd } = dateRanges();

  const confirmed = allReservations.filter(r => r.status === 'confirmed');
  const pending   = allReservations.filter(r => r.status === 'pending');

  // KPI: revenue + count per period (confirmed only)
  const inRange = (r, s, e) => r.date >= s && r.date <= e;
  const sumFee  = (arr) => arr.reduce((n, r) => n + resFee(r), 0);

  const confToday = confirmed.filter(r => r.date === today);
  const confWeek  = confirmed.filter(r => inRange(r, weekStart, weekEnd));
  const confMonth = confirmed.filter(r => inRange(r, monthStart, monthEnd));

  document.getElementById('kpiRevToday').textContent = sumFee(confToday).toLocaleString();
  document.getElementById('kpiRevWeek').textContent  = sumFee(confWeek).toLocaleString();
  document.getElementById('kpiRevMonth').textContent = sumFee(confMonth).toLocaleString();
  document.getElementById('kpiCntToday').textContent = confToday.length;
  document.getElementById('kpiCntWeek').textContent  = confWeek.length;
  document.getElementById('kpiCntMonth').textContent = confMonth.length;

  // Pending highlight
  const pendingFee = sumFee(pending);
  document.getElementById('pendingSub').textContent =
    pending.length === 0 ? '대기 중인 예약이 없습니다.' : `${pending.length}건 · 입금 확인이 필요합니다`;
  document.getElementById('pendingAmount').textContent =
    pending.length === 0 ? '—' : `${pendingFee.toLocaleString()}원`;
  document.getElementById('pendingHighlight').classList.toggle('empty', pending.length === 0);

  // 7-day bar chart
  renderWeekChart(confirmed);

  // Room breakdown (this month)
  renderRoomBreakdown(confMonth);
}

function renderWeekChart(confirmedRes) {
  const chart = document.getElementById('weekChart');
  const days = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    days.push({
      date: toDateStr(d),
      label: `${d.getMonth()+1}/${d.getDate()}`,
      weekday: DAY_KO[d.getDay()],
      isToday: toDateStr(d) === toDateStr(today),
    });
  }

  const revByDate = {};
  confirmedRes.forEach(r => { revByDate[r.date] = (revByDate[r.date] || 0) + resFee(r); });

  const max = Math.max(1, ...days.map(d => revByDate[d.date] || 0));

  chart.innerHTML = days.map(d => {
    const val = revByDate[d.date] || 0;
    const pct = (val / max) * 100;
    return `
      <div class="bar-col${d.isToday ? ' today' : ''}">
        <div class="bar-value">${val > 0 ? val.toLocaleString() : ''}</div>
        <div class="bar-track">
          <div class="bar-fill" style="height:${pct}%"></div>
        </div>
        <div class="bar-label">${d.label}<br><span>${d.weekday}</span></div>
      </div>
    `;
  }).join('');
}

function renderRoomBreakdown(confMonth) {
  const rooms = [
    { id: 1, name: '합주실',      cls: 'r1', color: 'var(--room1)' },
    { id: 2, name: '개인연습실',   cls: 'r2', color: 'var(--room2)' },
  ];
  const total = confMonth.reduce((n, r) => n + resFee(r), 0) || 1;

  const html = rooms.map(room => {
    const items = confMonth.filter(r => r.room_id === room.id);
    const rev = items.reduce((n, r) => n + resFee(r), 0);
    const pct = Math.round((rev / total) * 100);
    return `
      <div class="room-row">
        <div class="room-row-head">
          <span class="res-room-tag ${room.cls}">${room.name}</span>
          <span class="room-row-count">${items.length}건</span>
        </div>
        <div class="room-row-meter">
          <div class="room-row-meter-fill ${room.cls}" style="width:${pct}%"></div>
        </div>
        <div class="room-row-amount">
          <span>${rev.toLocaleString()}원</span>
          <span class="room-row-pct">${pct}%</span>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('roomBreakdown').innerHTML =
    confMonth.length === 0
      ? '<div class="admin-empty" style="padding:24px;"><div class="admin-empty-text">이번 달 확정된 예약이 없습니다.</div></div>'
      : html;
}

function goToPendingList() {
  setStatus('pending');
  switchPage('reservations');
}

/* ============================================================
   Filters
   ============================================================ */
function syncChips(attr, value) {
  document.querySelectorAll(`.filter-panel .chip[data-${attr}]`).forEach(c => {
    c.classList.toggle('active', c.dataset[attr] === value);
  });
}

function setPeriod(period) {
  currentPeriod = period;
  syncChips('period', period);
  applyFilters();
}

function setRoom(room) {
  currentRoom = room;
  syncChips('room', room);
  applyFilters();
}

function setStatus(status) {
  currentStatus = status;
  syncChips('status', status);
  applyFilters();
}

function applyFilters() {
  if (currentPage !== 'reservations') return;

  const today = toDateStr(new Date());
  const wkStart = new Date(); wkStart.setDate(wkStart.getDate() - wkStart.getDay());
  const wkStartStr = toDateStr(wkStart);
  const wkEnd = new Date(wkStart); wkEnd.setDate(wkEnd.getDate() + 6);
  const wkEndStr = toDateStr(wkEnd);
  const monStart = toDateStr(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const monEnd   = toDateStr(new Date(new Date().getFullYear(), new Date().getMonth()+1, 0));

  const search = document.getElementById('searchInput').value.trim().toLowerCase();

  let filtered = allReservations.filter(r => {
    if (currentPeriod === 'today' && r.date !== today) return false;
    if (currentPeriod === 'week'  && (r.date < wkStartStr || r.date > wkEndStr))  return false;
    if (currentPeriod === 'month' && (r.date < monStart   || r.date > monEnd))    return false;
    if (currentRoom !== 'all' && String(r.room_id) !== currentRoom) return false;
    if (currentStatus !== 'all' && r.status !== currentStatus) return false;
    if (search) {
      const hay = `${r.team_name||''} ${r.members||''} ${r.note||''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => (a.date + a.start_time > b.date + b.start_time) ? 1 : -1);
  renderList(filtered);
}

function renderList(items) {
  const container = document.getElementById('reservationList');
  if (items.length === 0) {
    container.innerHTML = `
      <div class="admin-empty">
        <span class="admin-empty-icon">📭</span>
        <div class="admin-empty-text">예약이 없습니다.</div>
      </div>`;
    return;
  }

  const groups = {};
  items.forEach(r => { (groups[r.date] ||= []).push(r); });

  let html = '<div class="reservation-list">';
  Object.keys(groups).sort().forEach(date => {
    const today = toDateStr(new Date());
    const label = date === today ? `오늘 · ${fmtDateKo(date)}` : fmtDateKo(date);
    html += `<div class="date-group-header">📅 ${label}</div>`;

    groups[date].forEach(r => {
      const cls   = r.room_id === 1 ? 'r1' : 'r2';
      const name  = r.room_id === 1 ? '합주실' : '개인연습실';
      const det   = [r.members, r.note].filter(Boolean).join(' · ');
      const isPending = r.status === 'pending';
      const fee   = (ROOM_PRICES[r.room_id] || 0) * r.duration;

      const statusBadge = isPending
        ? `<span class="res-status-admin pending">🕐 입금 대기</span>`
        : `<span class="res-status-admin confirmed">✅ 확정</span>`;

      const confirmBtn = isPending
        ? `<button class="btn-confirm-deposit" onclick="openConfirmModal(${r.id})" aria-label="확정">입금확인</button>`
        : '';

      html += `
        <div class="reservation-item${isPending ? ' pending' : ''}">
          <span class="res-room-tag ${cls}">${name}</span>
          <div class="res-info">
            <div class="res-date-label">${fmtDateKo(r.date)} ${statusBadge}</div>
            <div class="res-name">${escHtml(r.team_name || '(이름 없음)')}</div>
            ${det ? `<div class="res-detail">👥 ${escHtml(det)}</div>` : ''}
            <div class="res-fee">💰 ${fee.toLocaleString()}원</div>
          </div>
          <div class="res-time-info">
            <div class="res-time-main">${fmtTime(r.start_time)} ~ ${fmtTime(r.end_time)}</div>
            <div class="res-duration">${r.duration}시간</div>
          </div>
          <div class="res-actions">
            ${confirmBtn}
            <button class="btn-delete" onclick="openDeleteModal(${r.id})" aria-label="삭제">🗑</button>
          </div>
        </div>`;
    });
  });
  html += '</div>';
  container.innerHTML = html;
}

/* ============================================================
   Reservation Delete Modal
   ============================================================ */
function openDeleteModal(id) {
  const r = allReservations.find(x => x.id === id);
  if (!r) return;
  deleteTargetId = id;
  const name = r.room_id === 1 ? '합주실' : '개인연습실';
  document.getElementById('deleteTarget').innerHTML = `
    <b>${escHtml(r.team_name || '(이름 없음)')}</b><br>
    ${name} · ${fmtTime(r.start_time)} ~ ${fmtTime(r.end_time)} (${r.duration}시간)<br>
    ${fmtDateKo(r.date)}
    ${r.members ? `<br>👥 ${escHtml(r.members)}` : ''}
  `;
  document.getElementById('deleteOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeDeleteModal() {
  document.getElementById('deleteOverlay').classList.remove('open');
  document.body.style.overflow = '';
  deleteTargetId = null;
}

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  if (!deleteTargetId) return;
  const btn = document.getElementById('confirmDeleteBtn');
  btn.disabled = true; btn.textContent = '취소 중...';
  try {
    const res = await api(`/api/reservations/${deleteTargetId}`, { method: 'DELETE' });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '삭제 실패');
    }
    closeDeleteModal();
    await loadAllReservations();
    showToast('예약이 취소되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '예약 취소 확정';
  }
});

document.getElementById('deleteOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDeleteModal();
});

/* ============================================================
   Reservation Confirm (deposit verified) Modal
   ============================================================ */
function openConfirmModal(id) {
  const r = allReservations.find(x => x.id === id);
  if (!r) return;
  confirmTargetId = id;
  const name = r.room_id === 1 ? '합주실' : '개인연습실';
  const fee  = (ROOM_PRICES[r.room_id] || 0) * r.duration;
  document.getElementById('confirmTarget').innerHTML = `
    <b>${escHtml(r.team_name || '(이름 없음)')}</b><br>
    ${name} · ${fmtTime(r.start_time)} ~ ${fmtTime(r.end_time)} (${r.duration}시간)<br>
    ${fmtDateKo(r.date)}<br>
    💰 ${fee.toLocaleString()}원
    ${r.members ? `<br>👥 ${escHtml(r.members)}` : ''}
  `;
  document.getElementById('confirmOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeConfirmModal() {
  document.getElementById('confirmOverlay').classList.remove('open');
  document.body.style.overflow = '';
  confirmTargetId = null;
}

document.getElementById('confirmReservationBtn').addEventListener('click', async () => {
  if (!confirmTargetId) return;
  const btn = document.getElementById('confirmReservationBtn');
  btn.disabled = true; btn.textContent = '확정 중...';
  try {
    const res = await api(`/api/reservations/${confirmTargetId}/confirm`, { method: 'POST' });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '확정 실패');
    }
    closeConfirmModal();
    await loadAllReservations();
    showToast('예약이 확정되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '예약 확정';
  }
});

document.getElementById('confirmOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeConfirmModal();
});


/* ============================================================
   Calendar: Load & Render
   ============================================================ */
async function loadCalendar() {
  document.getElementById('calendarGrid').innerHTML = '<div class="spinner"></div>';
  try {
    const [resRes, blkRes] = await Promise.all([
      api('/api/reservations'),
      api('/api/blocked'),
    ]);
    if (!resRes.ok) throw new Error();
    allReservations = await resRes.json();
    allBlocked      = blkRes.ok ? await blkRes.json() : [];
  } catch {
    showToast('데이터를 불러오지 못했습니다.', 'error');
    allReservations = [];
    allBlocked = [];
  }
  renderCalendar();
}

function calPrevMonth() {
  calCursor.setMonth(calCursor.getMonth() - 1);
  renderCalendar();
}
function calNextMonth() {
  calCursor.setMonth(calCursor.getMonth() + 1);
  renderCalendar();
}
function calGoToday() {
  calCursor = new Date(); calCursor.setDate(1);
  renderCalendar();
}

function renderCalendar() {
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();
  document.getElementById('calTitle').textContent = `${y}년 ${m+1}월`;

  const lastDate = new Date(y, m + 1, 0).getDate();
  const firstDow = new Date(y, m, 1).getDay();   // 0 = Sunday
  const today    = toDateStr(new Date());

  const weekdayHead = DAY_KO.map((d, i) => {
    const cls = i === 0 ? 'sunday' : (i === 6 ? 'saturday' : '');
    return `<div class="cal-dow ${cls}">${d}</div>`;
  }).join('');

  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell empty"></div>';

  for (let d = 1; d <= lastDate; d++) {
    const dateStr = toDateStr(new Date(y, m, d));
    const dow     = new Date(y, m, d).getDay();
    const weekendCls = dow === 0 ? ' sunday' : (dow === 6 ? ' saturday' : '');

    const dayRes = allReservations.filter(r => r.date === dateStr);
    const dayBlk = allBlocked.filter(b => b.date === dateStr);

    const r1 = dayRes.filter(r => r.room_id === 1);
    const r2 = dayRes.filter(r => r.room_id === 2);
    const hasPending1 = r1.some(r => r.status === 'pending');
    const hasPending2 = r2.some(r => r.status === 'pending');

    const bars = [];
    if (r1.length) bars.push(`<div class="cal-bar r1${hasPending1 ? ' has-pending' : ''}">합주실 ${r1.length}</div>`);
    if (r2.length) bars.push(`<div class="cal-bar r2${hasPending2 ? ' has-pending' : ''}">개인 ${r2.length}</div>`);
    if (dayBlk.length) bars.push(`<div class="cal-bar blocked">🚫 차단 ${dayBlk.length}</div>`);

    cells += `
      <div class="cal-cell${dateStr === today ? ' today' : ''}${weekendCls}"
           onclick="openDayDetail('${dateStr}')">
        <div class="cal-date">${d}</div>
        <div class="cal-bars">${bars.join('')}</div>
      </div>
    `;
  }

  document.getElementById('calendarGrid').innerHTML = weekdayHead + cells;
}

function openDayDetail(dateStr) {
  const title = document.getElementById('dayDetailTitle');
  const body  = document.getElementById('dayDetailBody');

  title.textContent = fmtDateKo(dateStr);

  const dayRes = allReservations.filter(r => r.date === dateStr)
    .sort((a, b) => a.start_time > b.start_time ? 1 : -1);
  const dayBlk = allBlocked.filter(b => b.date === dateStr);

  let html = '';

  if (dayBlk.length) {
    html += '<div class="cal-detail-section">';
    html += '<div class="cal-detail-label">🚫 차단</div>';
    dayBlk.forEach(b => {
      const allDay = !b.start_time || !b.end_time;
      const timeStr = allDay ? '하루 종일' : `${fmtTime(b.start_time)} ~ ${fmtTime(b.end_time)}`;
      html += `
        <div class="cal-detail-blocked">
          <span class="res-room-tag ${roomTagCls(b.room_id)}">${roomName(b.room_id)}</span>
          <span class="cal-detail-time">${timeStr}</span>
          ${b.reason ? `<span class="blocked-reason">${escHtml(b.reason)}</span>` : ''}
        </div>
      `;
    });
    html += '</div>';
  }

  if (dayRes.length) {
    html += '<div class="cal-detail-section">';
    html += `<div class="cal-detail-label">📋 예약 ${dayRes.length}건</div>`;
    dayRes.forEach(r => {
      const cls   = r.room_id === 1 ? 'r1' : 'r2';
      const name  = r.room_id === 1 ? '합주실' : '개인연습실';
      const isPending = r.status === 'pending';
      const statusBadge = isPending
        ? `<span class="res-status-admin pending">🕐 대기</span>`
        : `<span class="res-status-admin confirmed">✅ 확정</span>`;
      html += `
        <div class="cal-detail-res">
          <div class="cal-detail-res-head">
            <span class="res-room-tag ${cls}">${name}</span>
            ${statusBadge}
            <span class="cal-detail-time">${fmtTime(r.start_time)} ~ ${fmtTime(r.end_time)}</span>
          </div>
          <div class="cal-detail-res-body">
            <b>${escHtml(r.team_name || '(이름 없음)')}</b>
            ${r.members ? `<span class="cal-detail-sub">👥 ${escHtml(r.members)}</span>` : ''}
            ${r.note    ? `<span class="cal-detail-sub">📝 ${escHtml(r.note)}</span>` : ''}
          </div>
        </div>
      `;
    });
    html += '</div>';
  }

  if (!dayBlk.length && !dayRes.length) {
    html = '<div class="admin-empty" style="padding:24px;"><span class="admin-empty-icon">📭</span><div class="admin-empty-text">예약이 없습니다.</div></div>';
  }

  body.innerHTML = html;
  document.getElementById('dayDetailOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeDayDetail() {
  document.getElementById('dayDetailOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('dayDetailOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDayDetail();
});


/* ============================================================
   Stats: Load & Render
   ============================================================ */
async function loadStats() {
  try {
    const res = await api('/api/reservations');
    if (!res.ok) throw new Error();
    allReservations = await res.json();
  } catch {
    allReservations = [];
    showToast('데이터를 불러오지 못했습니다.', 'error');
  }
  renderStats();
}

function setStatsRange(months) {
  statsRange = months;
  document.querySelectorAll('#statsPage .chip[data-range]').forEach(c => {
    c.classList.toggle('active', Number(c.dataset.range) === months);
  });
  renderStats();
}

function statsRangeBounds() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth() - (statsRange - 1), 1);
  return {
    startStr: toDateStr(start),
    endStr:   toDateStr(today),
    startDate: start,
    endDate: today,
  };
}

function renderStats() {
  const { startStr, endStr, startDate } = statsRangeBounds();

  const inRange = (r) => r.date >= startStr && r.date <= endStr;
  const scoped = allReservations.filter(inRange);

  const confirmed = scoped.filter(r => r.status === 'confirmed');
  const pending   = scoped.filter(r => r.status === 'pending');

  const revenue = confirmed.reduce((n, r) => n + resFee(r), 0);
  const totalHours = confirmed.reduce((n, r) => n + (r.duration || 0), 0);
  const avg = confirmed.length ? (totalHours / confirmed.length) : 0;
  const rate = scoped.length ? Math.round(confirmed.length / scoped.length * 100) : 0;

  document.getElementById('statsRev').textContent = revenue.toLocaleString();
  document.getElementById('statsCount').textContent = confirmed.length;
  document.getElementById('statsRate').textContent  = rate;
  document.getElementById('statsPendingCnt').textContent = pending.length;
  document.getElementById('statsAvg').textContent = confirmed.length ? avg.toFixed(1) : '—';

  renderMonthChart(confirmed, startDate);
  renderWeekdayChart(confirmed);
  renderHourChart(confirmed);
  renderStatsRoomBreakdown(confirmed, revenue);
}

function renderMonthChart(confirmedRes, startDate) {
  const chart = document.getElementById('monthChart');
  const months = [];
  const cursor = new Date(startDate);
  for (let i = 0; i < statsRange; i++) {
    months.push({
      y: cursor.getFullYear(), m: cursor.getMonth(),
      key: `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}`,
      label: `${cursor.getMonth()+1}월`,
      labelFull: cursor.getMonth() === 0 ? `${cursor.getFullYear()}년` : '',
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const byMonth = {};
  months.forEach(m => { byMonth[m.key] = { r1: 0, r2: 0 }; });
  confirmedRes.forEach(r => {
    const key = r.date.substring(0, 7);
    if (!byMonth[key]) return;
    const fee = resFee(r);
    if (r.room_id === 1) byMonth[key].r1 += fee;
    else if (r.room_id === 2) byMonth[key].r2 += fee;
  });

  const max = Math.max(1, ...months.map(m => byMonth[m.key].r1 + byMonth[m.key].r2));

  chart.innerHTML = months.map(m => {
    const v = byMonth[m.key];
    const total = v.r1 + v.r2;
    const pct   = (total / max) * 100;
    const r1Pct = total > 0 ? (v.r1 / total) * 100 : 0;
    return `
      <div class="stack-col">
        <div class="stack-value">${total > 0 ? (total/10000).toFixed(0) + '만' : ''}</div>
        <div class="stack-track">
          <div class="stack-fill" style="height:${pct}%;">
            <div class="stack-r1" style="height:${r1Pct}%"></div>
          </div>
        </div>
        <div class="stack-label">${m.label}${m.labelFull ? `<br><span>${m.labelFull}</span>` : ''}</div>
      </div>
    `;
  }).join('');
}

function renderWeekdayChart(confirmedRes) {
  const chart = document.getElementById('weekdayChart');
  const byDow = [0,0,0,0,0,0,0];
  confirmedRes.forEach(r => {
    const d = new Date(r.date + 'T00:00:00');
    byDow[d.getDay()] += (r.duration || 0);
  });
  const max = Math.max(1, ...byDow);

  chart.innerHTML = byDow.map((hrs, i) => {
    const pct = (hrs / max) * 100;
    const cls = i === 0 ? 'sunday' : (i === 6 ? 'saturday' : '');
    return `
      <div class="bar-col ${cls}">
        <div class="bar-value">${hrs > 0 ? hrs + 'h' : ''}</div>
        <div class="bar-track">
          <div class="bar-fill" style="height:${pct}%"></div>
        </div>
        <div class="bar-label">${DAY_KO[i]}</div>
      </div>
    `;
  }).join('');
}

function renderHourChart(confirmedRes) {
  const chart = document.getElementById('hourChart');
  const HOUR_START = 9, HOUR_END = 23;
  const hours = HOUR_END - HOUR_START;
  const counts = new Array(hours).fill(0);
  confirmedRes.forEach(r => {
    const startH = Number(String(r.start_time).substring(0,2));
    const dur    = r.duration || 0;
    for (let h = startH; h < startH + dur; h++) {
      const idx = h - HOUR_START;
      if (idx >= 0 && idx < hours) counts[idx]++;
    }
  });
  const max = Math.max(1, ...counts);
  chart.innerHTML = counts.map((c, i) => {
    const pct = (c / max) * 100;
    const hr = HOUR_START + i;
    return `
      <div class="bar-col">
        <div class="bar-value">${c > 0 ? c : ''}</div>
        <div class="bar-track">
          <div class="bar-fill" style="height:${pct}%"></div>
        </div>
        <div class="bar-label">${hr}</div>
      </div>
    `;
  }).join('');
}

function renderStatsRoomBreakdown(confirmedRes, total) {
  const rooms = [
    { id: 1, name: '합주실',     cls: 'r1' },
    { id: 2, name: '개인연습실',  cls: 'r2' },
  ];
  const sum = total || 1;

  const html = rooms.map(room => {
    const items = confirmedRes.filter(r => r.room_id === room.id);
    const rev = items.reduce((n, r) => n + resFee(r), 0);
    const hours = items.reduce((n, r) => n + (r.duration||0), 0);
    const pct = Math.round((rev / sum) * 100);
    return `
      <div class="room-row">
        <div class="room-row-head">
          <span class="res-room-tag ${room.cls}">${room.name}</span>
          <span class="room-row-count">${items.length}건 · ${hours}시간</span>
        </div>
        <div class="room-row-meter">
          <div class="room-row-meter-fill ${room.cls}" style="width:${pct}%"></div>
        </div>
        <div class="room-row-amount">
          <span>${rev.toLocaleString()}원</span>
          <span class="room-row-pct">${pct}%</span>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('statsRoomBreakdown').innerHTML =
    confirmedRes.length === 0
      ? '<div class="admin-empty" style="padding:24px;"><div class="admin-empty-text">기간 내 확정된 예약이 없습니다.</div></div>'
      : html;
}


/* ============================================================
   Inquiries
   ============================================================ */
const INQ_META = {
  question:  { icon: '💬', label: '문의',       cls: 'cat-question'  },
  complaint: { icon: '🛠', label: '불편사항',    cls: 'cat-complaint' },
  incident:  { icon: '⚠️', label: '사고 접수',   cls: 'cat-incident'  },
};

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

async function loadInquiries() {
  document.getElementById('inquiryList').innerHTML = '<div class="spinner"></div>';
  try {
    const res = await api('/api/admin/inquiries');
    if (!res.ok) throw new Error();
    allInquiries = await res.json();
  } catch {
    allInquiries = [];
    showToast('데이터를 불러오지 못했습니다.', 'error');
  }
  renderInquiries();
  refreshInquiryBadge();
}

async function refreshInquiryBadge() {
  if (allInquiries.length === 0) {
    try {
      const res = await api('/api/admin/inquiries?status=new');
      if (res.ok) allInquiries = await res.json();
    } catch {}
  }
  const newCount = allInquiries.filter(i => i.status === 'new').length;
  ['navInquiryBadge', 'mobileInquiryBadge'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (newCount > 0) { el.textContent = newCount; el.style.display = 'inline-flex'; }
    else el.style.display = 'none';
  });
}

function setInquiryStatus(s) {
  currentInqStatus = s;
  document.querySelectorAll('#inquiriesPage .chip[data-inq-status]').forEach(c => {
    c.classList.toggle('active', c.dataset.inqStatus === s);
  });
  renderInquiries();
}

function setInquiryCat(c) {
  currentInqCat = c;
  document.querySelectorAll('#inquiriesPage .chip[data-inq-cat]').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.inqCat === c);
  });
  renderInquiries();
}

function renderInquiries() {
  const list = document.getElementById('inquiryList');

  let items = allInquiries.slice();
  if (currentInqStatus !== 'all') items = items.filter(i => i.status === currentInqStatus);
  if (currentInqCat    !== 'all') items = items.filter(i => i.category === currentInqCat);

  if (items.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">📭</span><div class="admin-empty-text">해당되는 문의가 없습니다.</div></div>';
    return;
  }

  let html = '<div class="inquiry-list">';
  items.forEach(i => {
    const meta = INQ_META[i.category] || { icon: '📩', label: i.category, cls: '' };
    const isNew = i.status === 'new';
    const preview = escHtml((i.content || '').replace(/\s+/g, ' ').slice(0, 120));
    html += `
      <div class="inquiry-item ${meta.cls}${isNew ? ' new' : ''}" onclick="openInquiryDetail(${i.id})">
        <div class="inquiry-head">
          <span class="inquiry-cat-tag ${meta.cls}">${meta.icon} ${meta.label}</span>
          ${isNew ? '<span class="inquiry-status-badge new">새 접수</span>' : '<span class="inquiry-status-badge resolved">처리완료</span>'}
          <span class="inquiry-time">${fmtRelative(i.created_at)}</span>
        </div>
        <div class="inquiry-preview">${preview}</div>
        ${(i.contact_name || i.contact_phone) ? `<div class="inquiry-contact">👤 ${escHtml(i.contact_name || '')} ${escHtml(i.contact_phone || '')}</div>` : ''}
      </div>
    `;
  });
  html += '</div>';
  list.innerHTML = html;
}

function openInquiryDetail(id) {
  const i = allInquiries.find(x => x.id === id);
  if (!i) return;
  const meta = INQ_META[i.category] || { icon: '📩', label: i.category };
  const body = document.getElementById('inquiryDetailBody');
  const isNew = i.status === 'new';

  body.innerHTML = `
    <div class="inquiry-detail-head">
      <span class="inquiry-cat-tag ${meta.cls}">${meta.icon} ${meta.label}</span>
      ${isNew ? '<span class="inquiry-status-badge new">새 접수</span>' : '<span class="inquiry-status-badge resolved">처리완료</span>'}
      <span class="inquiry-time">${fmtDateTime(i.created_at)}</span>
    </div>

    <div class="inquiry-detail-content">${escHtml(i.content).replace(/\n/g, '<br>')}</div>

    ${(i.contact_name || i.contact_phone) ? `
      <div class="inquiry-detail-contact">
        <div class="inquiry-detail-label">연락처</div>
        ${i.contact_name  ? `<div>👤 ${escHtml(i.contact_name)}</div>`  : ''}
        ${i.contact_phone ? `<div>📞 <a href="tel:${escHtml(i.contact_phone)}">${escHtml(i.contact_phone)}</a></div>` : ''}
      </div>
    ` : '<div class="inquiry-detail-contact muted">연락처 정보 없음</div>'}

    ${!isNew ? `
      <div class="inquiry-detail-resolved">
        ✅ ${escHtml(i.resolved_by || '관리자')} · ${fmtDateTime(i.resolved_at)}
      </div>
    ` : ''}

    <div style="display:flex;gap:10px;margin-top:20px;">
      <button onclick="deleteInquiry(${i.id})" class="btn-danger" style="flex:1;">삭제</button>
      ${isNew
        ? `<button onclick="resolveInquiry(${i.id})" class="btn-submit" style="flex:2;margin-top:0;">처리 완료</button>`
        : `<button onclick="closeInquiryDetail()" class="btn-submit" style="flex:2;margin-top:0;">닫기</button>`}
    </div>
  `;
  document.getElementById('inquiryDetailOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeInquiryDetail() {
  document.getElementById('inquiryDetailOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('inquiryDetailOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeInquiryDetail();
});

async function resolveInquiry(id) {
  try {
    const res = await api(`/api/admin/inquiries/${id}/resolve`, { method: 'POST' });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '처리 실패');
    }
    closeInquiryDetail();
    await loadInquiries();
    showToast('처리 완료로 변경되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function deleteInquiry(id) {
  if (!confirm('이 문의를 삭제하시겠습니까?\n삭제된 내용은 복구할 수 없습니다.')) return;
  try {
    const res = await api(`/api/admin/inquiries/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '삭제 실패');
    }
    closeInquiryDetail();
    await loadInquiries();
    showToast('삭제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}


/* ============================================================
   Blocked Periods: Load & Render
   ============================================================ */
async function loadBlocked() {
  const list = document.getElementById('blockedList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    const res = await api('/api/blocked');
    if (!res.ok) throw new Error();
    allBlocked = await res.json();
  } catch {
    allBlocked = [];
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">목록을 불러오지 못했습니다.</div></div>';
    return;
  }
  renderBlocked();
}

function roomName(id) {
  if (id === 1) return '합주실';
  if (id === 2) return '개인연습실';
  return '전체 공간';
}

function roomTagCls(id) { return id === 1 ? 'r1' : (id === 2 ? 'r2' : 'all'); }

function renderBlocked() {
  const list = document.getElementById('blockedList');

  const today = toDateStr(new Date());
  const upcoming = allBlocked.filter(b => b.date >= today);
  const past     = allBlocked.filter(b => b.date <  today);

  if (allBlocked.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">🚫</span><div class="admin-empty-text">등록된 차단 설정이 없습니다.</div></div>';
    return;
  }

  const renderOne = (b) => {
    const allDay = !b.start_time || !b.end_time;
    const timeStr = allDay
      ? '<span class="blocked-allday">하루 종일</span>'
      : `${fmtTime(b.start_time)} ~ ${fmtTime(b.end_time)}`;
    return `
      <div class="blocked-item">
        <div class="blocked-date">
          <div class="blocked-date-main">${fmtDateKo(b.date)}</div>
          <div class="blocked-time">${timeStr}</div>
        </div>
        <div class="blocked-meta">
          <span class="res-room-tag ${roomTagCls(b.room_id)}">${roomName(b.room_id)}</span>
          ${b.reason ? `<span class="blocked-reason">${escHtml(b.reason)}</span>` : ''}
        </div>
        <button class="btn-delete" onclick="openDeleteBlockedModal(${b.id})" aria-label="해제">🗑</button>
      </div>
    `;
  };

  let html = '<div class="blocked-list">';
  if (upcoming.length > 0) {
    html += '<div class="date-group-header">🔔 예정된 차단</div>';
    upcoming.forEach(b => { html += renderOne(b); });
  }
  if (past.length > 0) {
    html += '<div class="date-group-header" style="margin-top:12px;color:var(--text-light);">지난 차단</div>';
    past.forEach(b => { html += renderOne(b); });
  }
  html += '</div>';
  list.innerHTML = html;
}

function openCreateBlockedModal() {
  const today = toDateStr(new Date());
  document.getElementById('blockDate').value = today;
  document.getElementById('blockDate').min = today;
  document.getElementById('blockAllDay').checked = true;
  document.getElementById('blockTimeRow').style.display = 'none';
  document.getElementById('blockRoom').value = '';
  document.getElementById('blockReason').value = '';
  populateBlockTimes();
  document.getElementById('createBlockedOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCreateBlockedModal() {
  document.getElementById('createBlockedOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function populateBlockTimes() {
  const start = document.getElementById('blockStart');
  const end   = document.getElementById('blockEnd');
  start.innerHTML = '';
  end.innerHTML   = '';
  for (let h = 9; h < 23; h++) {
    const v = `${String(h).padStart(2,'0')}:00`;
    start.innerHTML += `<option value="${v}">${v}</option>`;
  }
  for (let h = 10; h <= 23; h++) {
    const v = `${String(h).padStart(2,'0')}:00`;
    end.innerHTML += `<option value="${v}">${v}</option>`;
  }
  start.value = '09:00';
  end.value   = '23:00';
}

document.getElementById('blockAllDay').addEventListener('change', e => {
  document.getElementById('blockTimeRow').style.display = e.target.checked ? 'none' : 'block';
});

document.getElementById('blockStart').addEventListener('change', () => {
  const s = Number(document.getElementById('blockStart').value.split(':')[0]);
  const end = document.getElementById('blockEnd');
  end.innerHTML = '';
  for (let h = s + 1; h <= 23; h++) {
    const v = `${String(h).padStart(2,'0')}:00`;
    end.innerHTML += `<option value="${v}">${v}</option>`;
  }
  end.value = `${String(Math.min(23, s + 1)).padStart(2,'0')}:00`;
});

document.getElementById('createBlockedForm').addEventListener('submit', async e => {
  e.preventDefault();
  const allDay = document.getElementById('blockAllDay').checked;
  const date   = document.getElementById('blockDate').value;
  if (!date) { showToast('날짜를 선택해주세요.', 'error'); return; }
  const roomVal = document.getElementById('blockRoom').value;
  const reason  = document.getElementById('blockReason').value.trim() || null;

  const body = { date, reason };
  if (roomVal) body.room_id = Number(roomVal);
  if (!allDay) {
    const s = document.getElementById('blockStart').value;
    const ed = document.getElementById('blockEnd').value;
    if (s >= ed) { showToast('종료 시간은 시작 시간 이후여야 합니다.', 'error'); return; }
    body.start_time = s + ':00';
    body.end_time   = ed + ':00';
  }

  const btn = document.getElementById('createBlockedBtn');
  btn.disabled = true; btn.textContent = '등록 중...';
  try {
    const res = await api('/api/admin/blocked', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '등록 실패');
    }
    closeCreateBlockedModal();
    await loadBlocked();
    showToast('차단이 등록되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '차단 등록';
  }
});

document.getElementById('createBlockedOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeCreateBlockedModal();
});

function openDeleteBlockedModal(id) {
  const b = allBlocked.find(x => x.id === id);
  if (!b) return;
  deleteBlockedTargetId = id;
  const allDay = !b.start_time || !b.end_time;
  const timeStr = allDay ? '하루 종일' : `${fmtTime(b.start_time)} ~ ${fmtTime(b.end_time)}`;
  document.getElementById('deleteBlockedTarget').innerHTML = `
    <b>${fmtDateKo(b.date)}</b><br>
    ${roomName(b.room_id)} · ${timeStr}
    ${b.reason ? `<br>📝 ${escHtml(b.reason)}` : ''}
  `;
  document.getElementById('deleteBlockedOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeDeleteBlockedModal() {
  document.getElementById('deleteBlockedOverlay').classList.remove('open');
  document.body.style.overflow = '';
  deleteBlockedTargetId = null;
}

document.getElementById('confirmDeleteBlockedBtn').addEventListener('click', async () => {
  if (!deleteBlockedTargetId) return;
  const btn = document.getElementById('confirmDeleteBlockedBtn');
  btn.disabled = true; btn.textContent = '해제 중...';
  try {
    const res = await api(`/api/admin/blocked/${deleteBlockedTargetId}`, { method: 'DELETE' });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '해제 실패');
    }
    closeDeleteBlockedModal();
    await loadBlocked();
    showToast('차단이 해제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '해제';
  }
});

document.getElementById('deleteBlockedOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDeleteBlockedModal();
});


/* ============================================================
   Users: Load & Render
   ============================================================ */
async function loadUsers() {
  const list = document.getElementById('usersList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    const res = await api('/api/admin/users');
    if (!res.ok) throw new Error();
    allUsers = await res.json();
  } catch {
    allUsers = [];
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">목록을 불러오지 못했습니다.</div></div>';
    return;
  }
  renderUsers();
}

function renderUsers() {
  const list = document.getElementById('usersList');
  if (allUsers.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">👤</span><div class="admin-empty-text">계정이 없습니다.</div></div>';
    return;
  }

  let html = '<div class="user-list">';
  allUsers.forEach(u => {
    const isMe = u.id === currentUser.id;
    const roleClass = u.role === 'system' ? 'system' : 'reservation';
    const roleName  = u.role === 'system' ? '시스템 관리자' : '예약 관리자';
    const roleIcon  = u.role === 'system' ? '⚙️' : '📋';

    html += `
      <div class="user-item ${u.is_active ? '' : 'inactive'}">
        <div class="user-avatar ${roleClass}">${u.username.charAt(0).toUpperCase()}</div>
        <div class="user-meta">
          <div class="user-meta-top">
            <span class="user-meta-name">${escHtml(u.username)}</span>
            ${isMe ? '<span class="user-self-tag">나</span>' : ''}
            ${u.is_active ? '' : '<span class="user-inactive-tag">비활성</span>'}
          </div>
          <div class="user-meta-bottom">
            <span class="user-role-badge ${roleClass}">${roleIcon} ${roleName}</span>
            <span class="user-created">가입: ${fmtDateTime(u.created_at)}</span>
          </div>
        </div>
        <button class="btn-edit-user" onclick="openEditUserModal(${u.id})">수정</button>
      </div>`;
  });
  html += '</div>';
  list.innerHTML = html;
}

/* ============================================================
   Create User Modal
   ============================================================ */
function openCreateUserModal() {
  document.getElementById('newUsername').value = '';
  document.querySelectorAll('input[name="newRole"]').forEach((r, i) => {
    r.checked = i === 0;
  });
  syncRoleOptionStyles('newRole');
  document.getElementById('createUserOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCreateUserModal() {
  document.getElementById('createUserOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('createUserOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeCreateUserModal();
});

document.getElementById('createUserForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('newUsername').value.trim();
  const role = document.querySelector('input[name="newRole"]:checked').value;

  const btn = document.getElementById('createUserBtn');
  btn.disabled = true; btn.textContent = '생성 중...';

  try {
    const res = await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, role }),
    });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '생성 실패');
    }
    const data = await res.json();
    closeCreateUserModal();
    await loadUsers();
    openTempPasswordModal(data.user.username, data.temp_password);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '계정 생성';
  }
});

/* ============================================================
   Temp Password Result Modal
   ============================================================ */
function openTempPasswordModal(username, password) {
  document.getElementById('tempPwUsername').textContent = username;
  document.getElementById('tempPwValue').textContent = password;
  document.getElementById('copyTempPwBtn').textContent = '복사';
  document.getElementById('tempPasswordOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeTempPasswordModal() {
  document.getElementById('tempPasswordOverlay').classList.remove('open');
  document.body.style.overflow = '';
  document.getElementById('tempPwValue').textContent = '';
}

async function copyTempPassword() {
  const pw = document.getElementById('tempPwValue').textContent;
  const btn = document.getElementById('copyTempPwBtn');
  try {
    await navigator.clipboard.writeText(pw);
    btn.textContent = '복사됨 ✓';
    setTimeout(() => { btn.textContent = '복사'; }, 1500);
  } catch {
    showToast('클립보드 복사에 실패했습니다.', 'error');
  }
}

document.getElementById('tempPasswordOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeTempPasswordModal();
});

/* ============================================================
   Edit User Modal
   ============================================================ */
function openEditUserModal(userId) {
  const u = allUsers.find(x => x.id === userId);
  if (!u) return;
  editTargetUserId = userId;

  const isMe = u.id === currentUser.id;
  document.getElementById('editUserTarget').innerHTML = `
    <b>${escHtml(u.username)}</b>${isMe ? ' (나)' : ''}<br>
    <span style="color:var(--text-sub);font-weight:500;font-size:13px;">
      ${u.role === 'system' ? '⚙️ 시스템 관리자' : '📋 예약 관리자'}
       · ${u.is_active ? '활성' : '비활성'}
    </span>
  `;

  document.getElementById('editPassword').value = '';
  document.querySelectorAll('input[name="editRole"]').forEach(r => {
    r.checked = (r.value === u.role);
  });
  document.getElementById('editActive').checked = u.is_active;
  syncRoleOptionStyles('editRole');

  document.getElementById('editUserOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeEditUserModal() {
  document.getElementById('editUserOverlay').classList.remove('open');
  document.body.style.overflow = '';
  editTargetUserId = null;
}

document.getElementById('editUserOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeEditUserModal();
});

document.getElementById('editUserForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!editTargetUserId) return;

  const password = document.getElementById('editPassword').value;
  const role     = document.querySelector('input[name="editRole"]:checked').value;
  const isActive = document.getElementById('editActive').checked;

  const body = { role, is_active: isActive };
  if (password) body.password = password;

  const btn = document.getElementById('editUserBtn');
  btn.disabled = true; btn.textContent = '저장 중...';

  try {
    const res = await api(`/api/admin/users/${editTargetUserId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '저장 실패');
    }
    closeEditUserModal();
    await loadUsers();
    showToast('계정이 수정되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '변경 저장';
  }
});

async function deleteCurrentUser() {
  if (!editTargetUserId) return;
  const u = allUsers.find(x => x.id === editTargetUserId);
  if (!u) return;

  if (!confirm(`정말 [${u.username}] 계정을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;

  try {
    const res = await api(`/api/admin/users/${editTargetUserId}`, { method: 'DELETE' });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || '삭제 실패');
    }
    closeEditUserModal();
    await loadUsers();
    showToast(`계정 [${u.username}] 이(가) 삭제되었습니다.`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* ============================================================
   Role option styles (radio look)
   ============================================================ */
function syncRoleOptionStyles(name) {
  document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
    input.closest('.role-option').classList.toggle('active', input.checked);
  });
}

document.querySelectorAll('input[name="newRole"]').forEach(input => {
  input.addEventListener('change', () => syncRoleOptionStyles('newRole'));
});
document.querySelectorAll('input[name="editRole"]').forEach(input => {
  input.addEventListener('change', () => syncRoleOptionStyles('editRole'));
});

/* ============================================================
   Init
   ============================================================ */
init();
