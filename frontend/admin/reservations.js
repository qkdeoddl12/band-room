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
    allReservations = await apiJson('/api/reservations');
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
    allReservations = await apiJson('/api/reservations');
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

  document.getElementById('kpiRevToday').textContent = sumFee(confToday).toLocaleString();
  document.getElementById('kpiRevWeek').textContent  = sumFee(confWeek).toLocaleString();
  document.getElementById('kpiRevMonth').textContent = sumFee(confMonth).toLocaleString();
  document.getElementById('kpiCntToday').textContent = confToday.length;
  document.getElementById('kpiCntWeek').textContent  = confWeek.length;
  document.getElementById('kpiCntMonth').textContent = confMonth.length;

  const pendingFee = sumFee(pending);
  document.getElementById('pendingSub').textContent =
    pending.length === 0 ? '대기 중인 예약이 없습니다.' : `${pending.length}건 · 입금 확인이 필요합니다`;
  document.getElementById('pendingAmount').textContent =
    pending.length === 0 ? '—' : `${pendingFee.toLocaleString()}원`;
  document.getElementById('pendingHighlight').classList.toggle('empty', pending.length === 0);

  renderWeekChart(confirmed);
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

function roomList() {
  return Object.values(roomsById).sort((a, b) => a.id - b.id);
}

function renderRoomBreakdown(confMonth) {
  const total = confMonth.reduce((n, r) => n + resFee(r), 0) || 1;

  const html = roomList().map(room => {
    const items = confMonth.filter(r => r.room_id === room.id);
    const rev = items.reduce((n, r) => n + resFee(r), 0);
    const pct = Math.round((rev / total) * 100);
    return `
      <div class="room-row">
        <div class="room-row-head">
          <span class="res-room-tag ${roomTagCls(room.id)}">${escHtml(room.name)}</span>
          <span class="room-row-count">${items.length}건</span>
        </div>
        <div class="room-row-meter">
          <div class="room-row-meter-fill ${roomTagCls(room.id)}" style="width:${pct}%"></div>
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
            <div class="res-name">${escHtml(r.team_name || '(이름 없음)')}</div>
            ${det ? `<div class="res-detail">👥 ${escHtml(det)}</div>` : ''}
            <div class="res-fee">💰 ${resFeeLabel(r)}</div>
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
  document.getElementById('deleteTarget').innerHTML = `
    <b>${escHtml(r.team_name || '(이름 없음)')}</b><br>
    ${escHtml(roomName(r.room_id))} · ${fmtTime(r.start_time)} ~ ${fmtTime(r.end_time)} (${r.duration}시간)<br>
    ${fmtDateKo(r.date)}
    ${r.members ? `<br>👥 ${escHtml(r.members)}` : ''}
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
    ${escHtml(roomName(r.room_id))} · ${fmtTime(r.start_time)} ~ ${fmtTime(r.end_time)} (${r.duration}시간)<br>
    ${fmtDateKo(r.date)}<br>
    💰 ${resFeeLabel(r)}
    ${r.members ? `<br>👥 ${escHtml(r.members)}` : ''}
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
      apiJson('/api/reservations'),
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
      const timeStr = allDay ? '하루 종일' : `${fmtTime(b.start_time)} ~ ${fmtTime(b.end_time)}`;
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
  openOverlay('dayDetailOverlay');
}

function closeDayDetail() { closeOverlay('dayDetailOverlay'); }
bindOverlayClose('dayDetailOverlay', closeDayDetail);

/* ============================================================
   Stats
   ============================================================ */
async function loadStats() {
  try {
    allReservations = await apiJson('/api/reservations');
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
      key: ymStr(cursor),
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
    else byMonth[key].r2 += fee;
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
    return `
      <div class="bar-col">
        <div class="bar-value">${c > 0 ? c : ''}</div>
        <div class="bar-track">
          <div class="bar-fill" style="height:${pct}%"></div>
        </div>
        <div class="bar-label">${HOUR_START + i}</div>
      </div>
    `;
  }).join('');
}

function renderStatsRoomBreakdown(confirmedRes, total) {
  const sum = total || 1;

  const html = roomList().map(room => {
    const items = confirmedRes.filter(r => r.room_id === room.id);
    const rev = items.reduce((n, r) => n + resFee(r), 0);
    const hours = items.reduce((n, r) => n + (r.duration||0), 0);
    const pct = Math.round((rev / sum) * 100);
    return `
      <div class="room-row">
        <div class="room-row-head">
          <span class="res-room-tag ${roomTagCls(room.id)}">${escHtml(room.name)}</span>
          <span class="room-row-count">${items.length}건 · ${hours}시간</span>
        </div>
        <div class="room-row-meter">
          <div class="room-row-meter-fill ${roomTagCls(room.id)}" style="width:${pct}%"></div>
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
