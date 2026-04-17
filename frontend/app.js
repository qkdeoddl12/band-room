'use strict';

/* ============================================================
   Constants
   ============================================================ */
const HOURS_START = 9;
const HOURS_END   = 23;   // timeline shows 09:00 ~ 23:00
const SLOT_H      = 64;   // px per hour slot
const DAY_NAMES   = ['일', '월', '화', '수', '목', '금', '토'];

/* ============================================================
   State
   ============================================================ */
let currentDate    = new Date();
let currentRoomId  = 1;
let selectedDuration = 1;
let reservations   = [];

/* ============================================================
   Date helpers
   ============================================================ */
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function displayDate(d) {
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function fmtTime(t) {
  // "HH:MM:SS" → "HH:MM"
  return String(t).substring(0, 5);
}

function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

/* ============================================================
   Render: date display + week strip
   ============================================================ */
function updateDateDisplay() {
  document.getElementById('weekday').textContent = DAY_NAMES[currentDate.getDay()] + '요일';
  document.getElementById('currentDate').textContent = displayDate(currentDate);
}

function renderWeekStrip() {
  const strip  = document.getElementById('weekStrip');
  const today  = toDateStr(new Date());
  const sel    = toDateStr(currentDate);

  strip.innerHTML = '';

  // 7 days centered on currentDate
  for (let i = -3; i <= 3; i++) {
    const d = new Date(currentDate);
    d.setDate(currentDate.getDate() + i);

    const dateStr  = toDateStr(d);
    const isToday  = dateStr === today;
    const isActive = dateStr === sel;

    const el = document.createElement('div');
    el.className = ['week-day', isToday ? 'is-today' : '', isActive ? 'active' : ''].filter(Boolean).join(' ');
    el.innerHTML = `
      <span class="week-day-name">${DAY_NAMES[d.getDay()]}</span>
      <span class="week-day-num">${d.getDate()}</span>
    `;
    el.addEventListener('click', () => {
      currentDate = new Date(d);
      updateDateDisplay();
      renderWeekStrip();
      loadReservations();
    });
    strip.appendChild(el);

    if (isActive) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }));
    }
  }
}

/* ============================================================
   Render: timeline grid (runs once on init)
   ============================================================ */
function buildTimeline() {
  const labels = document.getElementById('timeLabels');
  const grid   = document.getElementById('timelineGrid');

  // Remove old slots
  grid.querySelectorAll('.timeline-slot').forEach(s => s.remove());
  labels.innerHTML = '';

  for (let h = HOURS_START; h < HOURS_END; h++) {
    // Time label
    const label = document.createElement('div');
    label.className = 'time-label';
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    labels.appendChild(label);

    // Clickable slot
    const slot = document.createElement('div');
    slot.className = `timeline-slot room${currentRoomId}`;
    slot.dataset.hour = h;
    slot.addEventListener('click', () => openModal(h));
    grid.insertBefore(slot, grid.querySelector('.reservations-layer'));
  }
}

/* ============================================================
   Render: reservations on timeline
   ============================================================ */
function renderReservations() {
  const layer = document.getElementById('reservationsLayer');
  layer.innerHTML = '';

  const dayRes = reservations.filter(r => r.room_id === currentRoomId);

  if (dayRes.length === 0) return;

  dayRes.forEach(r => {
    const startMin = timeToMinutes(r.start_time);
    const endMin   = timeToMinutes(r.end_time);
    const startH   = startMin / 60;
    const durH     = (endMin - startMin) / 60;

    const top    = (startH - HOURS_START) * SLOT_H;
    const height = durH * SLOT_H;

    if (top < 0 || top >= (HOURS_END - HOURS_START) * SLOT_H) return;

    const block = document.createElement('div');
    block.className = `reservation-block room${currentRoomId}`;
    block.style.top    = `${top + 4}px`;
    block.style.height = `${height - 8}px`;

    block.innerHTML = `
      <div class="res-team">${escHtml(r.team_name || '(이름 없음)')}</div>
      <div class="res-time">${fmtTime(r.start_time)} ~ ${fmtTime(r.end_time)}</div>
      ${r.members ? `<div class="res-members">👥 ${escHtml(r.members)}</div>` : ''}
    `;
    layer.appendChild(block);
  });
}

/* ============================================================
   Current time indicator
   ============================================================ */
function updateCurrentTimeLine() {
  const line  = document.getElementById('currentTimeLine');
  const now   = new Date();
  const today = toDateStr(now);

  if (toDateStr(currentDate) !== today) { line.style.display = 'none'; return; }

  const h = now.getHours() + now.getMinutes() / 60;
  if (h < HOURS_START || h >= HOURS_END) { line.style.display = 'none'; return; }

  line.style.display = 'block';
  line.style.top = `${(h - HOURS_START) * SLOT_H}px`;
}

/* ============================================================
   API: load reservations
   ============================================================ */
async function loadReservations() {
  try {
    const res = await fetch(`/api/reservations?date=${toDateStr(currentDate)}`);
    if (!res.ok) throw new Error();
    reservations = await res.json();
  } catch {
    reservations = [];
    showToast('예약 정보를 불러오지 못했습니다.', 'error');
  }
  renderReservations();
  updateCurrentTimeLine();
}

/* ============================================================
   Room tab switching
   ============================================================ */
function switchRoom(roomId) {
  currentRoomId = roomId;
  document.querySelectorAll('.room-tab').forEach((tab, i) => {
    tab.classList.toggle('active', i + 1 === roomId);
  });
  document.querySelectorAll('.timeline-slot').forEach(slot => {
    slot.className = `timeline-slot room${roomId}`;
  });
  renderReservations();
}

/* ============================================================
   Modal
   ============================================================ */
function openModal(defaultHour = null) {
  const overlay   = document.getElementById('modalOverlay');
  const badge     = document.getElementById('roomBadge');
  const badgeName = document.getElementById('roomBadgeName');

  badge.className = `room-badge r${currentRoomId}`;
  badgeName.textContent = currentRoomId === 1 ? '합주실' : '개인연습실';

  selectedDuration = 1;
  refreshDurationButtons();
  populateStartTimes(defaultHour);

  document.getElementById('teamName').value = '';
  document.getElementById('members').value  = '';
  document.getElementById('note').value     = '';

  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function populateStartTimes(defaultHour) {
  const select = document.getElementById('startTime');
  select.innerHTML = '';

  const maxStart = HOURS_END - selectedDuration;

  for (let h = HOURS_START; h <= maxStart; h++) {
    const val    = `${String(h).padStart(2, '0')}:00`;
    const option = document.createElement('option');
    option.value = val;
    option.textContent = val;
    if (defaultHour !== null && h === defaultHour) option.selected = true;
    select.appendChild(option);
  }
  updateTimeSummary();
}

function refreshDurationButtons() {
  document.querySelectorAll('.duration-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.hours) === selectedDuration);
  });
}

function updateTimeSummary() {
  const start = document.getElementById('startTime').value;
  if (!start) return;
  const [h] = start.split(':').map(Number);
  const endH  = h + selectedDuration;
  const end   = `${String(endH).padStart(2, '0')}:00`;
  const room  = currentRoomId === 1 ? '합주실' : '개인연습실';
  document.getElementById('timeSummaryText').textContent =
    `${displayDate(currentDate)} · ${start} ~ ${end} (${selectedDuration}시간)`;
}

/* Duration buttons */
document.querySelectorAll('.duration-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedDuration = Number(btn.dataset.hours);
    refreshDurationButtons();
    const currentStart = Number(document.getElementById('startTime').value?.split(':')[0] || HOURS_START);
    populateStartTimes(currentStart <= HOURS_END - selectedDuration ? currentStart : null);
  });
});

/* Close on overlay backdrop click */
document.getElementById('modalOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

/* Form submit */
document.getElementById('reservationForm').addEventListener('submit', async e => {
  e.preventDefault();

  const teamName = document.getElementById('teamName').value.trim();
  if (!teamName) { showToast('팀명 또는 예약자 이름을 입력해주세요.', 'error'); return; }

  const startTime = document.getElementById('startTime').value;
  const endHour   = Number(startTime.split(':')[0]) + selectedDuration;
  if (endHour > HOURS_END) {
    showToast(`예약 종료 시간은 ${HOURS_END}:00을 넘을 수 없습니다.`, 'error');
    return;
  }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = '예약 중...';

  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id:   currentRoomId,
        date:      toDateStr(currentDate),
        start_time: startTime + ':00',
        duration:  selectedDuration,
        team_name: teamName,
        members:   document.getElementById('members').value.trim() || null,
        note:      document.getElementById('note').value.trim()     || null,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || '예약에 실패했습니다.');
    }

    closeModal();
    await loadReservations();
    showToast('예약이 완료됐습니다! 🎸', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '예약 확정';
  }
});

/* ============================================================
   Date navigation buttons
   ============================================================ */
document.getElementById('prevDay').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() - 1);
  updateDateDisplay();
  renderWeekStrip();
  loadReservations();
});

document.getElementById('nextDay').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() + 1);
  updateDateDisplay();
  renderWeekStrip();
  loadReservations();
});

/* ============================================================
   Toast
   ============================================================ */
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast ${type} show`;
  setTimeout(() => { el.className = 'toast'; }, 3000);
}

/* ============================================================
   Helpers
   ============================================================ */
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ============================================================
   Init
   ============================================================ */
function init() {
  updateDateDisplay();
  renderWeekStrip();
  buildTimeline();
  loadReservations();
  setInterval(updateCurrentTimeLine, 60_000);

  // Scroll timeline to current hour on load
  const now = new Date();
  const scrollH = Math.max(0, now.getHours() - HOURS_START - 1);
  document.getElementById('timelineSection').scrollTop = scrollH * SLOT_H;
}

init();
