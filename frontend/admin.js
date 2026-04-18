'use strict';

/* ============================================================
   State
   ============================================================ */
let authToken      = '';
let currentUser    = null;     // {id, username, role, is_active}
let currentPage    = 'reservations';
let currentPeriod  = 'today';
let currentRoom    = 'all';

let allReservations = [];
let allUsers        = [];

let deleteTargetId   = null;
let editTargetUserId = null;

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

  switchPage('reservations');
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

  document.getElementById('reservationsFilters').style.display =
    page === 'reservations' ? '' : 'none';

  if (page === 'reservations') loadAllReservations();
  else if (page === 'users')   loadUsers();
}

function switchPageMobile(page) {
  if (page === 'users' && currentUser?.role !== 'system') return;
  switchPage(page);
  syncMobileNav(page);
}

function syncMobileNav(activeKey) {
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.mtab === activeKey);
  });
}

/* ============================================================
   Reservations: Load & Stats
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
  updateStats();
  applyFilters();
}

function updateStats() {
  const today = toDateStr(new Date());
  const wkStart = new Date(); wkStart.setDate(wkStart.getDate() - wkStart.getDay());
  const wkStartStr = toDateStr(wkStart);
  const wkEnd = new Date(wkStart); wkEnd.setDate(wkEnd.getDate() + 6);
  const wkEndStr = toDateStr(wkEnd);
  const monStart = toDateStr(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const monEnd   = toDateStr(new Date(new Date().getFullYear(), new Date().getMonth()+1, 0));

  document.getElementById('statToday').textContent = allReservations.filter(r => r.date === today).length;
  document.getElementById('statWeek').textContent  = allReservations.filter(r => r.date >= wkStartStr && r.date <= wkEndStr).length;
  document.getElementById('statMonth').textContent = allReservations.filter(r => r.date >= monStart && r.date <= monEnd).length;
  document.getElementById('statAll').textContent   = allReservations.length;
}

/* ============================================================
   Filters
   ============================================================ */
function setPeriod(period, el) {
  currentPeriod = period;
  document.querySelectorAll('.admin-sidebar .sidebar-item[data-period]').forEach(item => {
    item.classList.toggle('active', item.dataset.period === period);
  });
  applyFilters();
}

function setPeriodMobile(period) {
  currentPeriod = period;
  switchPage('reservations');
  document.querySelectorAll('.admin-sidebar .sidebar-item[data-period]').forEach(item => {
    item.classList.toggle('active', item.dataset.period === period);
  });
  syncMobileNav(period);
  applyFilters();
}

function setRoom(room, el) {
  currentRoom = room;
  document.querySelectorAll('.admin-sidebar .sidebar-item[data-room]').forEach(item => {
    item.classList.toggle('active', item.dataset.room === room);
  });
  document.getElementById('roomSelect').value = room;
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

  const search    = document.getElementById('searchInput').value.trim().toLowerCase();
  const roomSel   = document.getElementById('roomSelect').value;
  const roomFilter = roomSel !== 'all' ? roomSel : currentRoom;

  let filtered = allReservations.filter(r => {
    if (currentPeriod === 'today' && r.date !== today) return false;
    if (currentPeriod === 'week'  && (r.date < wkStartStr || r.date > wkEndStr))  return false;
    if (currentPeriod === 'month' && (r.date < monStart   || r.date > monEnd))    return false;
    if (roomFilter !== 'all' && String(r.room_id) !== roomFilter) return false;
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

      html += `
        <div class="reservation-item">
          <span class="res-room-tag ${cls}">${name}</span>
          <div class="res-info">
            <div class="res-date-label">${fmtDateKo(r.date)}</div>
            <div class="res-name">${escHtml(r.team_name || '(이름 없음)')}</div>
            ${det ? `<div class="res-detail">👥 ${escHtml(det)}</div>` : ''}
          </div>
          <div class="res-time-info">
            <div class="res-time-main">${fmtTime(r.start_time)} ~ ${fmtTime(r.end_time)}</div>
            <div class="res-duration">${r.duration}시간</div>
          </div>
          <button class="btn-delete" onclick="openDeleteModal(${r.id})" aria-label="삭제">🗑</button>
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
