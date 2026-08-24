'use strict';

/* ============================================================
   대시보드 · 예약 관리 · 캘린더 · 통계
   ============================================================ */
let currentPeriod = 'all';
let currentRoom   = 'all';
let currentStatus = 'pending';

let deleteTargetId  = null;
let confirmTargetId = null;

let calCursor = new Date();
calCursor.setDate(1);

let statsRange = 6;  // months

PAGE_LOADERS.dashboard    = loadDashboard;
PAGE_LOADERS.reservations = loadAllReservations;
PAGE_LOADERS.calendar     = loadCalendar;
PAGE_LOADERS.stats        = loadStats;

/* ============================================================
   Reservations: Load
   ============================================================ */
async function loadAllReservations() {
  document.getElementById('reservationList').innerHTML = '<div class="spinner"></div>';
  try {
    allReservations = await apiJson('/api/admin/reservations');
  } catch (e) {
    allReservations = [];
    showToast(e.message, 'error');
  }
  applyFilters();
}

/* ============================================================
   Dashboard
   ============================================================ */
async function loadDashboard() {
  try {
    allReservations = await apiJson('/api/admin/reservations');
  } catch (e) {
    allReservations = [];
    showToast(e.message, 'error');
  }
  renderDashboard();
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

  const inRange = (r, s, e) => r.date >= s && r.date <= e;
  const sumFee  = (arr) => arr.reduce((n, r) => n + resFee(r), 0);

  const confToday = confirmed.filter(r => r.date === today);
  const confWeek  = confirmed.filter(r => inRange(r, weekStart, weekEnd));
  const confMonth = confirmed.filter(r => inRange(r, monthStart, monthEnd));

  // 팀 대부분이 선불이라 예약 매출은 0에 가깝다 — 이용 건수를 앞에 세운다.
  [['Today', confToday], ['Week', confWeek], ['Month', confMonth]].forEach(([key, rows]) => {
    setText(`kpiCnt${key}`, rows.length);
    setText(`kpiRev${key}`, usageSub(rows));
  });

  const pendingFee = sumFee(pending);
  document.getElementById('pendingSub').textContent =
    pending.length === 0 ? '대기 중인 예약이 없습니다.' : `${pending.length}건 · 입금 확인이 필요합니다`;
  document.getElementById('pendingAmount').textContent =
    pending.length === 0 ? '—' : `${pendingFee.toLocaleString()}원`;
  document.getElementById('pendingHighlight').classList.toggle('empty', pending.length === 0);

  renderWeekChart(confirmed);
  renderRoomBreakdown('roomBreakdown', confMonth, { emptyMsg: '이번 달 확정된 예약이 없습니다.' });
}

/* KPI 아래 줄 — 시간 합계, 받을 돈이 있으면 그것도. */
function usageSub(rows) {
  const hours = rows.reduce((n, r) => n + (r.duration || 0), 0);
  const fee = rows.reduce((n, r) => n + resFee(r), 0);
  return `확정 ${hours}시간` + (fee ? ` · ${fee.toLocaleString()}원` : '');
}

/* 막대차트 3개가 같은 DOM 을 각자 만들고 있었다. 하나로 모은다.
   bars: [{ value, label, sub, title, cls }] */
function renderBarChart(elId, bars, emptyMsg) {
  const el = document.getElementById(elId);
  if (!bars.some(b => b.value > 0)) {
    el.innerHTML = `<div class="chart-empty">${escHtml(emptyMsg)}</div>`;
    return;
  }
  const max = Math.max(...bars.map(b => b.value));
  el.innerHTML = bars.map(b => `
    <div class="bar-col${b.cls ? ' ' + b.cls : ''}">
      <div class="bar-value">${b.value === max ? escHtml(b.peakLabel ?? String(b.value)) : ''}</div>
      <div class="bar-track" title="${escHtml(b.title)}" aria-label="${escHtml(b.title)}">
        <div class="bar-fill${b.value ? '' : ' is-zero'}" style="height:${(b.value / max) * 100}%"></div>
      </div>
      <div class="bar-label">${b.label}${b.sub ? `<br><span>${escHtml(b.sub)}</span>` : ''}</div>
    </div>`).join('');
}

function renderWeekChart(confirmedRes) {
  const byDate = {};
  confirmedRes.forEach(r => {
    const cur = byDate[r.date] || { count: 0, hours: 0 };
    cur.count += 1;
    cur.hours += r.duration || 0;
    byDate[r.date] = cur;
  });

  const today = new Date();
  const bars = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const date = toDateStr(d);
    const { count, hours } = byDate[date] || { count: 0, hours: 0 };
    bars.push({
      value: count,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      sub: DAY_KO[d.getDay()],
      title: `${d.getMonth() + 1}/${d.getDate()} ${DAY_KO[d.getDay()]} · ${count}건 · ${hours}시간`,
      peakLabel: `${count}건`,
      cls: date === toDateStr(today) ? 'today' : '',
    });
  }
  renderBarChart('weekChart', bars, '최근 7일 확정된 예약이 없습니다.');
}

function roomList() {
  return Object.values(roomsById).sort((a, b) => a.id - b.id);
}

/* 대시보드와 통계에서 같은 표를 각각 그리고 있었다. 시간 표시 여부만 다르다. */
function renderRoomBreakdown(elId, items, { emptyMsg } = {}) {
  // 매출 비율로 재면 선불 팀이 전부 0이라 막대가 비어 보인다 — 건수로 잰다.
  const total = items.length || 1;
  const el = document.getElementById(elId);

  if (items.length === 0) {
    el.innerHTML = `<div class="admin-empty" style="padding:24px;"><div class="admin-empty-text">${escHtml(emptyMsg)}</div></div>`;
    return;
  }

  el.innerHTML = roomList().map(room => {
    const rows = items.filter(r => r.room_id === room.id);
    const rev = rows.reduce((n, r) => n + resFee(r), 0);
    const hours = rows.reduce((n, r) => n + (r.duration || 0), 0);
    const pct = Math.round((rows.length / total) * 100);
    return `
      <div class="room-row">
        <div class="room-row-head">
          <span class="res-room-tag ${roomTagCls(room.id)}">${escHtml(room.name)}</span>
          <span class="room-row-count">${rows.length}건</span>
        </div>
        <div class="room-row-meter">
          <div class="room-row-meter-fill ${roomTagCls(room.id)}" style="width:${pct}%"></div>
        </div>
        <div class="room-row-amount">
          <span>${hours}시간${rev ? ` · ${rev.toLocaleString()}원` : ''}</span>
          <span class="room-row-pct">${pct}%</span>
        </div>
      </div>`;
  }).join('');
}

function goToPendingList() {
  currentStatus = 'pending';
  switchPage('reservations');
  syncChips('status', 'pending');
}

/* ============================================================
   Filters
   ============================================================ */
function syncChips(attr, value) {
  document.querySelectorAll(`.filter-panel .chip[data-${attr}]`).forEach(c => {
    c.classList.toggle('active', c.dataset[attr] === value);
  });
}

function setPeriod(period) { currentPeriod = period; syncChips('period', period); applyFilters(); }
function setRoom(room)     { currentRoom = room;     syncChips('room', room);     applyFilters(); }
function setStatus(status) { currentStatus = status; syncChips('status', status); applyFilters(); }

function applyFilters() {
  if (currentPage !== 'reservations') return;

  // 같은 계산이 dateRanges() 에 이미 있다.
  const { today, weekStart: wkStartStr, weekEnd: wkEndStr,
          monthStart: monStart, monthEnd: monEnd } = dateRanges();

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
      const det   = [r.members, r.note].filter(Boolean).join(' · ');
      const isPending = r.status === 'pending';

      const statusBadge = isPending
        ? `<span class="res-status-admin pending">🕐 입금 대기</span>`
        : `<span class="res-status-admin confirmed">✅ 확정</span>`;

      const confirmBtn = isPending
        ? `<button class="btn-confirm-deposit" onclick="openConfirmModal(${r.id})" aria-label="확정">입금확인</button>`
        : '';

      html += `
        <div class="reservation-item${isPending ? ' pending' : ''}">
          <span class="res-room-tag ${roomTagCls(r.room_id)}">${escHtml(roomName(r.room_id))}</span>
          <div class="res-info">
            <div class="res-date-label">${fmtDateKo(r.date)} ${statusBadge}</div>
            <div class="res-name">
              ${escHtml(r.team_name || r.booker_name || '(이름 없음)')}
              ${RES_KIND[r.kind] ? `<span class="kind-tag ${RES_KIND[r.kind].cls}">${RES_KIND[r.kind].label}</span>` : ''}
              ${r.member_id ? '<span class="booker-tag member">멤버</span>' : ''}
              ${r.booker_name && !r.member_id ? '<span class="booker-tag guest">게스트</span>' : ''}
            </div>
            ${r.booker_phone ? `<div class="res-detail">📞 ${escHtml(formatPhone(r.booker_phone))}</div>` : ''}
            ${det ? `<div class="res-detail">👥 ${escHtml(det)}</div>` : ''}
            <div class="res-fee">💰 ${resFeeLabel(r)}</div>
          </div>
          <div class="res-time-info">
            <div class="res-time-main">${fmtTime(r.start_time)} ~ ${fmtEndTime(r.end_time)}</div>
            <div class="res-duration">${r.duration}시간${r.group_key ? ' <span class="overnight-tag">🌙</span>' : ''}</div>
          </div>
          <div class="res-actions">
            ${confirmBtn}
            <button class="btn-edit-res" onclick="openResEditModal(${r.id})" aria-label="수정">수정</button>
            <button class="btn-delete" onclick="openDeleteModal(${r.id})" aria-label="삭제">🗑</button>
          </div>
        </div>`;
    });
  });
  html += '</div>';
  container.innerHTML = html;
}

/* ============================================================
   Reservation Edit — 이용자가 시간을 바꿔달라고 할 때 쓴다.
   서버가 슬롯을 다시 검사하고, 자정을 넘기면 다시 두 건으로 쪼갠다.
   ============================================================ */
let editResId = null;

/* 예약 종류. 팀·개인은 이용자가 만들고 대관·정모는 관리자가 만든다.
   라벨을 여기 한 곳에만 둔다. */
const RES_KIND = {
  rental: { label: '대관', cls: 'rental' },
  meetup: { label: '정모', cls: 'meetup' },
};

function openResEditModal(id) {
  const r = allReservations.find(x => x.id === id);
  if (!r) return;
  editResId = id;

  // 자정을 넘긴 예약은 나뉜 두 건이 한 예약이다 — 합친 시간으로 보여준다.
  const pair = r.group_key
    ? allReservations.filter(x => x.group_key === r.group_key)
        .sort((a, b) => `${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`))
    : [r];
  const head = pair[0];
  const total = pair.reduce((sum, x) => sum + x.duration, 0);

  const note = document.getElementById('resEditOvernight');
  note.style.display = pair.length > 1 ? '' : 'none';
  note.textContent = pair.length > 1
    ? '🌙 자정을 넘긴 예약입니다. 나뉜 두 건을 한 건으로 고칩니다.' : '';

  document.getElementById('resEditRoom').innerHTML = Object.values(roomsById)
    .sort((a, b) => a.id - b.id)
    .map(room => `<option value="${room.id}"${room.id === head.room_id ? ' selected' : ''}>${escHtml(room.name)}</option>`)
    .join('');
  document.getElementById('resEditStart').innerHTML = Array.from({ length: 24 }, (_, h) => {
    const v = `${String(h).padStart(2, '0')}:00`;
    return `<option value="${v}"${head.start_time.startsWith(v) ? ' selected' : ''}>${v}</option>`;
  }).join('');
  document.getElementById('resEditTeam').innerHTML = Object.values(teamsById)
    .filter(t => t.is_active || t.id === head.team_id)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `<option value="${t.id}"${t.id === head.team_id ? ' selected' : ''}>${escHtml(t.name)}</option>`)
    .join('');

  document.getElementById('resEditDate').value     = head.date;
  document.getElementById('resEditDuration').value = total;
  document.getElementById('resEditBooker').value   =
    RES_KIND[head.kind] ? (head.team_name || '') : (head.booker_name || '');
  document.getElementById('resEditPhone').value    = formatPhone(head.booker_phone);
  document.getElementById('resEditMembers').value  = head.members || '';
  document.getElementById('resEditNote').value     = head.note || '';
  document.getElementById('resEditRange').textContent =
    `지금: ${fmtDateKo(head.date)} ${fmtTime(head.start_time)} ~ ${fmtEndTime(pair[pair.length - 1].end_time)}`;

  syncResEditMode();
  openOverlay('resEditOverlay');
}

/* 공간 종류에 따라 팀을 고르거나 이용자 이름을 적는다 (예약 페이지와 같은 규칙). */
function syncResEditMode() {
  const r = allReservations.find(x => x.id === editResId);
  // 대관·정모는 팀도 이용자도 없다 — 이름 한 칸만 고친다.
  if (r && RES_KIND[r.kind]) {
    document.getElementById('resEditTeamRow').style.display     = 'none';
    document.getElementById('resEditPersonalRow').style.display = '';
    document.getElementById('resEditPhoneLabel').textContent    = '담당 연락처';
    document.getElementById('resEditBookerLabel').textContent   = '이름';
    return;
  }
  const roomId = Number(document.getElementById('resEditRoom').value);
  const personal = roomsById[roomId]?.booking_mode === 'personal';
  document.getElementById('resEditTeamRow').style.display     = personal ? 'none' : '';
  document.getElementById('resEditPersonalRow').style.display = personal ? '' : 'none';
  document.getElementById('resEditPhoneLabel').textContent    = '연락처';
  document.getElementById('resEditBookerLabel').textContent   = '이용자 이름';
}

function closeResEditModal() {
  closeOverlay('resEditOverlay');
  editResId = null;
}

bindOverlayClose('resEditOverlay', closeResEditModal);

document.getElementById('resEditForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!editResId) return;

  const roomId = Number(document.getElementById('resEditRoom').value);
  const personal = roomsById[roomId]?.booking_mode === 'personal';
  const duration = Number(document.getElementById('resEditDuration').value);
  if (!duration || duration < 1 || duration > 24) {
    showToast('이용 시간은 1~24 사이여야 합니다.', 'error');
    return;
  }

  const body = {
    room_id:    roomId,
    date:       document.getElementById('resEditDate').value,
    start_time: document.getElementById('resEditStart').value + ':00',
    duration,
    members:    document.getElementById('resEditMembers').value.trim() || null,
    note:       document.getElementById('resEditNote').value.trim() || null,
  };
  const editing = allReservations.find(x => x.id === editResId);
  if (editing && RES_KIND[editing.kind]) {
    body.title        = document.getElementById('resEditBooker').value.trim();
    body.booker_phone = document.getElementById('resEditPhone').value.trim() || null;
    if (!body.title) { showToast('이름을 입력해주세요.', 'error'); return; }
  } else if (personal) {
    body.booker_name  = document.getElementById('resEditBooker').value.trim();
    body.booker_phone = document.getElementById('resEditPhone').value.trim() || null;
    if (!body.booker_name) { showToast('이용자 이름을 입력해주세요.', 'error'); return; }
  } else {
    body.team_id = Number(document.getElementById('resEditTeam').value) || null;
    if (!body.team_id) { showToast('예약 팀을 선택해주세요.', 'error'); return; }
  }

  const btn = document.getElementById('resEditSaveBtn');
  btn.disabled = true; btn.textContent = '저장 중...';
  try {
    await apiJson(`/api/admin/reservations/${editResId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    closeResEditModal();
    await loadAllReservations();
    showToast('예약이 수정되었습니다.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '변경 저장';
  }
});

attachPhoneMask(document.getElementById('resEditPhone'));

/* ============================================================
   장소 대관 · 도어즈 정모 — 관리자가 직접 잡는 예약
   ============================================================ */
let adminResKind = 'meetup';

function setAdminResKind(kind) {
  adminResKind = kind;
  document.querySelectorAll('#adminResKind .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.kind === kind);
  });
  const title = document.getElementById('adminResTitle');
  title.placeholder = kind === 'rental' ? '예: ○○교회 대관' : '예: 도어즈 8월 정모';
}

function openAdminResModal() {
  document.getElementById('adminResRoom').innerHTML = Object.values(roomsById)
    .sort((a, b) => a.id - b.id)
    .map(r => `<option value="${r.id}">${escHtml(r.name)}</option>`).join('');
  document.getElementById('adminResStart').innerHTML = Array.from({ length: 24 }, (_, h) => {
    const v = `${String(h).padStart(2, '0')}:00`;
    return `<option value="${v}"${h === 19 ? ' selected' : ''}>${v}</option>`;
  }).join('');
  document.getElementById('adminResTitle').value = '';
  document.getElementById('adminResDate').value  = toDateStr(new Date());
  document.getElementById('adminResDuration').value = 3;
  document.getElementById('adminResPhone').value = '';
  document.getElementById('adminResNote').value  = '';
  setAdminResKind('meetup');
  openOverlay('adminResOverlay');
}

function closeAdminResModal() { closeOverlay('adminResOverlay'); }
bindOverlayClose('adminResOverlay', closeAdminResModal);

document.getElementById('adminResForm').addEventListener('submit', async e => {
  e.preventDefault();
  const title = document.getElementById('adminResTitle').value.trim();
  if (!title) { showToast('이름을 입력해주세요.', 'error'); return; }
  const duration = Number(document.getElementById('adminResDuration').value);
  if (!duration || duration < 1 || duration > 24) {
    showToast('이용 시간은 1~24 사이여야 합니다.', 'error');
    return;
  }

  const btn = document.getElementById('adminResSaveBtn');
  btn.disabled = true; btn.textContent = '추가 중...';
  try {
    await apiJson('/api/admin/reservations', {
      method: 'POST',
      body: JSON.stringify({
        kind: adminResKind,
        room_id: Number(document.getElementById('adminResRoom').value),
        title,
        date: document.getElementById('adminResDate').value,
        start_time: document.getElementById('adminResStart').value + ':00',
        duration,
        contact_phone: document.getElementById('adminResPhone').value.trim() || null,
        note: document.getElementById('adminResNote').value.trim() || null,
      }),
    });
    closeAdminResModal();
    await loadAllReservations();
    showToast(`${title} 추가됨`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '예약 추가';
  }
});

attachPhoneMask(document.getElementById('adminResPhone'));

/* ============================================================
   Reservation Delete Modal
   ============================================================ */
function openDeleteModal(id) {
  const r = allReservations.find(x => x.id === id);
  if (!r) return;
  deleteTargetId = id;
  document.getElementById('deleteTarget').innerHTML = `
    <b>${escHtml(r.team_name || '(이름 없음)')}</b><br>
    ${escHtml(roomName(r.room_id))} · ${fmtTime(r.start_time)} ~ ${fmtEndTime(r.end_time)} (${r.duration}시간)<br>
    ${fmtDateKo(r.date)}
    ${r.members ? `<br>👥 ${escHtml(r.members)}` : ''}
    ${r.group_key ? '<br><span class="overnight-note">🌙 자정을 넘긴 예약입니다. 나뉜 두 건이 함께 처리됩니다.</span>' : ''}
  `;
  openOverlay('deleteOverlay');
}

function closeDeleteModal() {
  closeOverlay('deleteOverlay');
  deleteTargetId = null;
}

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  if (!deleteTargetId) return;
  const btn = document.getElementById('confirmDeleteBtn');
  btn.disabled = true; btn.textContent = '취소 중...';
  try {
    await apiJson(`/api/reservations/${deleteTargetId}`, { method: 'DELETE' });
    closeDeleteModal();
    await loadAllReservations();
    showToast('예약이 취소되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '예약 취소 확정';
  }
});

bindOverlayClose('deleteOverlay', closeDeleteModal);

/* ============================================================
   Reservation Confirm (deposit verified) Modal
   ============================================================ */
function openConfirmModal(id) {
  const r = allReservations.find(x => x.id === id);
  if (!r) return;
  confirmTargetId = id;
  document.getElementById('confirmTarget').innerHTML = `
    <b>${escHtml(r.team_name || '(이름 없음)')}</b><br>
    ${escHtml(roomName(r.room_id))} · ${fmtTime(r.start_time)} ~ ${fmtEndTime(r.end_time)} (${r.duration}시간)<br>
    ${fmtDateKo(r.date)}<br>
    💰 ${resFeeLabel(r)}
    ${r.members ? `<br>👥 ${escHtml(r.members)}` : ''}
    ${r.group_key ? '<br><span class="overnight-note">🌙 자정을 넘긴 예약입니다. 나뉜 두 건이 함께 처리됩니다.</span>' : ''}
  `;
  openOverlay('confirmOverlay');
}

function closeConfirmModal() {
  closeOverlay('confirmOverlay');
  confirmTargetId = null;
}

document.getElementById('confirmReservationBtn').addEventListener('click', async () => {
  if (!confirmTargetId) return;
  const btn = document.getElementById('confirmReservationBtn');
  btn.disabled = true; btn.textContent = '확정 중...';
  try {
    await apiJson(`/api/reservations/${confirmTargetId}/confirm`, { method: 'POST' });
    closeConfirmModal();
    await loadAllReservations();
    showToast('예약이 확정되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '예약 확정';
  }
});

bindOverlayClose('confirmOverlay', closeConfirmModal);

/* ============================================================
   Calendar
   ============================================================ */
async function loadCalendar() {
  document.getElementById('calendarGrid').innerHTML = '<div class="spinner"></div>';
  try {
    const [res, blk] = await Promise.all([
      apiJson('/api/admin/reservations'),
      apiJson('/api/blocked').catch(() => []),
    ]);
    allReservations = res;
    allBlocked      = blk;
  } catch (e) {
    showToast(e.message, 'error');
    allReservations = [];
    allBlocked = [];
  }
  renderCalendar();
}

function calPrevMonth() { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); }
function calNextMonth() { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); }
function calGoToday()   { calCursor = new Date(); calCursor.setDate(1); renderCalendar(); }

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

    const bars = [];
    roomList().forEach(room => {
      const items = dayRes.filter(r => r.room_id === room.id);
      if (!items.length) return;
      const hasPending = items.some(r => r.status === 'pending');
      bars.push(`<div class="cal-bar ${roomTagCls(room.id)}${hasPending ? ' has-pending' : ''}">${escHtml(room.name)} ${items.length}</div>`);
    });
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
  document.getElementById('dayDetailTitle').textContent = fmtDateKo(dateStr);
  const body = document.getElementById('dayDetailBody');

  const dayRes = allReservations.filter(r => r.date === dateStr)
    .sort((a, b) => a.start_time > b.start_time ? 1 : -1);
  const dayBlk = allBlocked.filter(b => b.date === dateStr);

  let html = '';

  if (dayBlk.length) {
    html += '<div class="cal-detail-section">';
    html += '<div class="cal-detail-label">🚫 차단</div>';
    dayBlk.forEach(b => {
      const allDay = !b.start_time || !b.end_time;
      const timeStr = allDay ? '하루 종일' : `${fmtTime(b.start_time)} ~ ${fmtEndTime(b.end_time)}`;
      html += `
        <div class="cal-detail-blocked">
          <span class="res-room-tag ${roomTagCls(b.room_id)}">${escHtml(roomName(b.room_id))}</span>
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
      const isPending = r.status === 'pending';
      const statusBadge = isPending
        ? `<span class="res-status-admin pending">🕐 대기</span>`
        : `<span class="res-status-admin confirmed">✅ 확정</span>`;
      html += `
        <div class="cal-detail-res">
          <div class="cal-detail-res-head">
            <span class="res-room-tag ${roomTagCls(r.room_id)}">${escHtml(roomName(r.room_id))}</span>
            ${statusBadge}
            <span class="cal-detail-time">${fmtTime(r.start_time)} ~ ${fmtEndTime(r.end_time)}</span>
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
  openOverlay('dayDetailOverlay');
}

function closeDayDetail() { closeOverlay('dayDetailOverlay'); }
bindOverlayClose('dayDetailOverlay', closeDayDetail);

/* ============================================================
   Stats
   ============================================================ */
async function loadStats() {
  try {
    allReservations = await apiJson('/api/admin/reservations');
  } catch (e) {
    allReservations = [];
    showToast(e.message, 'error');
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
  return { startStr: toDateStr(start), endStr: toDateStr(today), startDate: start };
}

function renderStats() {
  const { startStr, endStr, startDate } = statsRangeBounds();

  const scoped = allReservations.filter(r => r.date >= startStr && r.date <= endStr);
  const confirmed = scoped.filter(r => r.status === 'confirmed');
  const pending   = scoped.filter(r => r.status === 'pending');

  const totalHours = confirmed.reduce((n, r) => n + (r.duration || 0), 0);
  const avg = confirmed.length ? (totalHours / confirmed.length) : 0;
  const rate = scoped.length ? Math.round(confirmed.length / scoped.length * 100) : 0;

  setText('statsCount', confirmed.length);
  setText('statsRev', usageSub(confirmed));
  document.getElementById('statsRate').textContent  = rate;
  document.getElementById('statsPendingCnt').textContent = pending.length;
  document.getElementById('statsAvg').textContent = confirmed.length ? avg.toFixed(1) : '—';

  renderMonthChart(confirmed, startDate);
  renderWeekdayChart(confirmed);
  renderHourChart(confirmed);
  renderRoomBreakdown('statsRoomBreakdown', confirmed, { emptyMsg: '기간 내 확정된 예약이 없습니다.' });
}

/* 두 계열 이상이면 범례가 항상 있어야 한다 — 색만으로 구분하면 안 된다. */
function chartLegendHtml() {
  return '<div class="chart-legend">' + roomList().map(r => `
    <span class="chart-legend-item">
      <span class="chart-legend-swatch" style="background:var(--${roomTagCls(r.id) === 'r1' ? 'room1' : 'room2'})"></span>
      ${escHtml(r.name)}
    </span>`).join('') + '</div>';
}

function renderMonthChart(confirmedRes, startDate) {
  const chart = document.getElementById('monthChart');
  const months = [];
  const cursor = new Date(startDate);
  for (let i = 0; i < statsRange; i++) {
    months.push({
      key: ymStr(cursor),
      label: `${cursor.getMonth()+1}월`,
      labelFull: cursor.getMonth() === 0 ? `${cursor.getFullYear()}년` : '',
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  // 매출이 아니라 확정 건수를 쌓는다 — 선불 팀 예약은 매출이 0이라 막대가 안 선다.
  const firstRoomId = roomList()[0]?.id;
  const byMonth = {};
  months.forEach(m => { byMonth[m.key] = { r1: 0, r2: 0 }; });
  confirmedRes.forEach(r => {
    const key = r.date.substring(0, 7);
    if (!byMonth[key]) return;
    if (r.room_id === firstRoomId) byMonth[key].r1 += 1;
    else byMonth[key].r2 += 1;
  });

  const grand = months.reduce((n, m) => n + byMonth[m.key].r1 + byMonth[m.key].r2, 0);
  if (!grand) {
    chart.innerHTML = '<div class="chart-empty">기간 내 확정된 예약이 없습니다.</div>';
    return;
  }
  const max = Math.max(1, ...months.map(m => byMonth[m.key].r1 + byMonth[m.key].r2));

  const rooms = roomList();
  chart.innerHTML = months.map(m => {
    const v = byMonth[m.key];
    const total = v.r1 + v.r2;
    const pct   = (total / max) * 100;
    const r1Pct = total > 0 ? (v.r1 / total) * 100 : 0;
    const peak  = total === max && total > 0;
    return `
      <div class="stack-col" title="${m.label} · ${rooms[0] ? rooms[0].name : ''} ${v.r1}건 · ${rooms[1] ? rooms[1].name : ''} ${v.r2}건">
        <div class="stack-value">${peak ? total + '건' : ''}</div>
        <div class="stack-track">
          <div class="stack-fill${total ? '' : ' is-zero'}" style="height:${pct}%;">
            <div class="stack-r1" style="height:${r1Pct}%"></div>
          </div>
        </div>
        <div class="stack-label">${m.label}${m.labelFull ? `<br><span>${m.labelFull}</span>` : ''}</div>
      </div>
    `;
  }).join('');
  const holder = document.getElementById('monthChartLegend');
  if (holder) holder.innerHTML = chartLegendHtml();
}

function renderWeekdayChart(confirmedRes) {
  const byDow = [0,0,0,0,0,0,0];
  confirmedRes.forEach(r => {
    byDow[new Date(r.date + 'T00:00:00').getDay()] += (r.duration || 0);
  });
  renderBarChart('weekdayChart', byDow.map((hrs, i) => ({
    value: hrs,
    label: DAY_KO[i],
    title: `${DAY_KO[i]}요일 ${hrs}시간`,
    peakLabel: `${hrs}h`,
    cls: i === 0 ? 'sunday' : (i === 6 ? 'saturday' : ''),
  })), '데이터가 없습니다.');
}

function renderHourChart(confirmedRes) {
  // 24시간 운영이다. 예전 09~23시 범위로 두면 새벽·심야 예약이 통째로 빠진다.
  const counts = new Array(24).fill(0);
  confirmedRes.forEach(r => {
    const startH = Number(String(r.start_time).substring(0, 2));
    for (let h = startH; h < startH + (r.duration || 0); h++) {
      if (h >= 0 && h < 24) counts[h]++;
    }
  });
  renderBarChart('hourChart', counts.map((c, h) => ({
    value: c,
    // 24칸에 두 자리 숫자를 다 쓰면 겹친다 — 짝수 시만 적고 나머지는 툴팁으로.
    label: h % 2 === 0 ? String(h) : '',
    title: `${h}시 ${c}건`,
  })), '데이터가 없습니다.');
}

