'use strict';

/* ============================================================
   Constants
   ============================================================ */
const HOURS_START = 0;
const HOURS_END   = 24;   // 24시간 운영 — 타임라인은 00:00 ~ 24:00
// 자정을 넘겨 다음날 몇 시까지 이어 예약할 수 있는지. 서버는 두 건으로 나눠 저장한다.
// ponytail: 새벽 6시면 실사용엔 충분. 더 길게 필요하면 숫자만 올리면 된다.
const OVERNIGHT_END = 6;
const SLOT_H      = 64;   // px per hour slot
const DAY_NAMES   = ['일', '월', '화', '수', '목', '금', '토'];

/* ============================================================
   State — 요금·계좌·팀 목록은 전부 API에서 받아온다 (하드코딩 없음)
   ============================================================ */
let currentDate    = new Date();
let currentRoomId  = null;
let reservations   = [];
let blockedPeriods = [];
// 자정을 넘기는 예약을 고를 때 다음날도 비어 있는지 봐야 한다.
let nextReservations = [];
let nextBlocked      = [];
let rooms          = [];
let teams          = [];
let settings       = { deposit_bank: '', deposit_account: '', deposit_holder: '' };

function roomById(id)  { return rooms.find(r => r.id === id) || null; }
function roomPrice(id) { return roomById(id)?.hourly_price || 0; }
/* CSS는 room1 / room2 두 벌만 있으므로 목록 순서로 매핑한다. */
function roomCls(id) {
  const idx = rooms.findIndex(r => r.id === id);
  return `room${Math.min(2, Math.max(1, idx + 1))}`;
}
function roomTagCls(id) { return roomCls(id).replace('room', 'r'); }
function isPersonalRoom(id) { return roomById(id)?.booking_mode === 'personal'; }

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

/* 종료 시각 00:00 은 '다음날 0시'가 아니라 '그날 24시'다.
   서버 _end_mins 와 같은 규칙. 시작 시각에는 적용하지 않는다. */
function endMinutes(t) {
  const m = timeToMinutes(t);
  return m === 0 ? 24 * 60 : m;
}
function fmtEndTime(t) {
  const s = fmtTime(t);
  return s === '00:00' ? '24:00' : s;
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
    slot.className = `timeline-slot ${roomCls(currentRoomId)}`;
    slot.dataset.hour = h;
    slot.addEventListener('click', () => openModal(h));
    grid.insertBefore(slot, grid.querySelector('.reservations-layer'));
  }
}

/* ============================================================
   Render: blocked periods overlay
   ============================================================ */
function activeBlockedForRoom(list = blockedPeriods) {
  return list.filter(b => b.room_id === null || b.room_id === undefined || b.room_id === currentRoomId);
}

function renderBlockedLayer() {
  const layer = document.getElementById('reservationsLayer');
  const blocks = activeBlockedForRoom();
  blocks.forEach(b => {
    const allDay = !b.start_time || !b.end_time;
    const startH = allDay ? HOURS_START : timeToMinutes(b.start_time) / 60;
    const endH   = allDay ? HOURS_END   : endMinutes(b.end_time)   / 60;
    const clampedStart = Math.max(HOURS_START, startH);
    const clampedEnd   = Math.min(HOURS_END,   endH);
    if (clampedEnd <= clampedStart) return;

    const top    = (clampedStart - HOURS_START) * SLOT_H;
    const height = (clampedEnd - clampedStart) * SLOT_H;

    const block = document.createElement('div');
    block.className = 'blocked-block';
    block.style.top    = `${top}px`;
    block.style.height = `${height}px`;
    block.innerHTML = `
      <span class="blocked-icon">🚫</span>
      <span class="blocked-text">${escHtml(b.reason || '예약 불가')}</span>
    `;
    layer.appendChild(block);
  });
}

/* ============================================================
   Render: reservations on timeline
   ============================================================ */
function renderReservations() {
  const layer = document.getElementById('reservationsLayer');
  layer.innerHTML = '';

  renderBlockedLayer();

  const dayRes = reservations.filter(r => r.room_id === currentRoomId);

  if (dayRes.length === 0) return;

  dayRes.forEach(r => {
    const startMin = timeToMinutes(r.start_time);
    const endMin   = endMinutes(r.end_time);
    const startH   = startMin / 60;
    const durH     = (endMin - startMin) / 60;

    const top    = (startH - HOURS_START) * SLOT_H;
    const height = durH * SLOT_H;

    if (top < 0 || top >= (HOURS_END - HOURS_START) * SLOT_H) return;

    const block = document.createElement('div');
    const isPending = r.status === 'pending';
    block.className = `reservation-block ${roomCls(currentRoomId)}${isPending ? ' pending' : ''}`;
    block.style.top    = `${top + 4}px`;
    block.style.height = `${height - 8}px`;

    block.innerHTML = `
      <div class="res-team">
        ${escHtml(r.team_name || '(이름 없음)')}
        ${isPending
          ? '<span class="res-status-badge pending">입금 대기</span>'
          : '<span class="res-status-badge confirmed">확정</span>'}
      </div>
      <div class="res-time">${fmtTime(r.start_time)} ~ ${fmtEndTime(r.end_time)}</div>
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
  const dateStr = toDateStr(currentDate);
  const next = new Date(currentDate);
  next.setDate(currentDate.getDate() + 1);
  const nextStr = toDateStr(next);
  try {
    const [resRes, blkRes, nResRes, nBlkRes] = await Promise.all([
      fetch(`/api/reservations?date=${dateStr}`),
      fetch(`/api/blocked?date=${dateStr}`),
      fetch(`/api/reservations?date=${nextStr}`),
      fetch(`/api/blocked?date=${nextStr}`),
    ]);
    if (!resRes.ok) throw new Error();
    reservations   = await resRes.json();
    blockedPeriods = blkRes.ok ? await blkRes.json() : [];
    nextReservations = nResRes.ok ? await nResRes.json() : [];
    nextBlocked      = nBlkRes.ok ? await nBlkRes.json() : [];
  } catch {
    reservations   = [];
    blockedPeriods = [];
    nextReservations = [];
    nextBlocked      = [];
    showToast('예약 정보를 불러오지 못했습니다.', 'error');
  }
  renderReservations();
  updateCurrentTimeLine();
}

/* ============================================================
   Room tab switching
   ============================================================ */
function renderRoomTabs() {
  const wrap = document.getElementById('roomTabs');
  wrap.innerHTML = rooms.map(r => `
    <button class="room-tab${r.id === currentRoomId ? ' active' : ''}"
            id="tab-${r.id}" onclick="switchRoom(${r.id})">
      <span class="tab-dot"></span>${escHtml(r.name)}
    </button>
  `).join('');
}

function switchRoom(roomId) {
  currentRoomId = roomId;
  document.querySelectorAll('.room-tab').forEach(tab => {
    tab.classList.toggle('active', tab.id === `tab-${roomId}`);
  });
  document.querySelectorAll('.timeline-slot').forEach(slot => {
    slot.className = `timeline-slot ${roomCls(roomId)}`;
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

  badge.className = `room-badge ${roomTagCls(currentRoomId)}`;
  badgeName.textContent = roomById(currentRoomId)?.name || '';

  populateStartTimes(defaultHour);
  populateEndTimes();

  document.getElementById('teamSelect').value = '';
  document.getElementById('bookerName').value = '';
  document.getElementById('bookerPhone').value = '';
  document.getElementById('bookerStatus').className = 'booker-status';
  document.getElementById('bookerStatus').textContent = '';
  memberCheck = null;
  applyBookingMode();
  document.getElementById('members').value  = '';
  document.getElementById('note').value     = '';

  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

/* hour 는 24 이상일 수 있다 — 그때는 다음날 (hour-24) 시를 뜻한다. */
function hourBlocked(hour) {
  const overnight = hour >= HOURS_END;
  if (overnight) hour -= HOURS_END;
  const blocks = activeBlockedForRoom(overnight ? nextBlocked : blockedPeriods);
  for (const b of blocks) {
    if (!b.start_time || !b.end_time) return true;
    const bStart = timeToMinutes(b.start_time) / 60;
    const bEnd   = endMinutes(b.end_time)   / 60;
    if (!(hour + 1 <= bStart || hour >= bEnd)) return true;
  }
  return false;
}

/* 이미 예약된 시간대. 서버도 막지만, 고르기 전에 알려주는 편이 낫다. */
function hourTaken(hour) {
  const overnight = hour >= HOURS_END;
  if (overnight) hour -= HOURS_END;
  return (overnight ? nextReservations : reservations).some(r => {
    if (r.room_id !== currentRoomId) return false;
    const s = timeToMinutes(r.start_time) / 60;
    const e = endMinutes(r.end_time)   / 60;
    return !(hour + 1 <= s || hour >= e);
  });
}

function hourUnavailable(hour) { return hourBlocked(hour) || hourTaken(hour); }

/* 시작 시각에서 끊기지 않고 이어 잡을 수 있는 마지막 시각. 24를 넘으면 다음날. */
function maxEndHour(startH) {
  const limit = HOURS_END + OVERNIGHT_END;
  for (let h = startH; h < limit; h++) {
    if (hourUnavailable(h)) return h;
  }
  return limit;
}

/* 25 -> '다음날 01:00'. 24:00 은 그날 자정이므로 그대로 둔다. */
function endHourLabel(h) {
  const label = `${String(h % HOURS_END).padStart(2, '0')}:00`;
  return h > HOURS_END ? `다음날 ${label}` : `${String(h).padStart(2, '0')}:00`;
}

function populateStartTimes(defaultHour) {
  const select = document.getElementById('startTime');
  select.innerHTML = '';

  let firstAvailable = null;
  for (let h = HOURS_START; h < HOURS_END; h++) {
    const val    = `${String(h).padStart(2, '0')}:00`;
    const option = document.createElement('option');
    option.value = val;
    option.textContent = val;
    if (hourBlocked(h)) {
      option.disabled = true;
      option.textContent = `${val} (차단됨)`;
    } else if (hourTaken(h)) {
      option.disabled = true;
      option.textContent = `${val} (예약됨)`;
    } else if (firstAvailable === null) {
      firstAvailable = h;
    }
    if (defaultHour !== null && h === defaultHour && !option.disabled) option.selected = true;
    select.appendChild(option);
  }
  if (select.selectedIndex === -1 || select.options[select.selectedIndex]?.disabled) {
    if (firstAvailable !== null) {
      select.value = `${String(firstAvailable).padStart(2,'0')}:00`;
    }
  }
}

function populateEndTimes(preferredHour = null) {
  const select = document.getElementById('endTime');
  const startH = Number(document.getElementById('startTime').value.split(':')[0]);

  select.innerHTML = '';
  const maxEnd = maxEndHour(startH);
  for (let h = startH + 1; h <= maxEnd; h++) {
    const option = document.createElement('option');
    option.value = `${String(h).padStart(2, '0')}:00`;
    option.textContent = endHourLabel(h);
    select.appendChild(option);
  }

  const desired = preferredHour !== null && preferredHour > startH && preferredHour <= maxEnd
    ? preferredHour
    : startH + 1;
  if (desired <= maxEnd) {
    select.value = `${String(desired).padStart(2, '0')}:00`;
  }

  updateTimeSummary();
}

function updateTimeSummary() {
  const start = document.getElementById('startTime').value;
  const end   = document.getElementById('endTime').value;
  if (!start || !end) return;
  const startH = Number(start.split(':')[0]);
  const endH   = Number(end.split(':')[0]);
  const dur    = endH - startH;
  document.getElementById('timeSummaryText').textContent =
    `${displayDate(currentDate)} · ${start} ~ ${endHourLabel(endH)} (${dur}시간)`;

  // 이 시작 시각에서 연속으로 몇 시간까지 잡을 수 있는지 미리 알려준다
  const maxEnd = maxEndHour(startH);
  const maxHint = document.getElementById('timeMaxHint');
  if (maxHint) {
    const maxHours = Math.max(0, maxEnd - startH);
    maxHint.textContent = maxHours > 0 ? `이 시간부터 최대 ${maxHours}시간 예약 가능` : '';
  }

  updateFeeBox(dur);
}

function selectedTeam() {
  const id = Number(document.getElementById('teamSelect').value);
  return teams.find(t => t.id === id) || null;
}

/* 개인 단위 공간이면 팀 선택 대신 이름·연락처를 받는다. */
function applyBookingMode() {
  const personal = isPersonalRoom(currentRoomId);
  document.getElementById('teamField').style.display = personal ? 'none' : '';
  document.getElementById('personalFields').style.display = personal ? '' : 'none';
  syncBookerPhoneField();
  updateTimeSummary();
}

/* 멤버로 확인되면 연락처는 안 받아도 된다. */
function syncBookerPhoneField() {
  const known = memberCheck?.is_member;
  const field = document.getElementById('bookerPhoneField');
  field.style.display = known ? 'none' : '';
}

/* 시간당이 아닌 팀(월 이용료 · 월회비)은 건별로 낼 게 없다. */
const PREPAID_LABEL = { monthly: '월 이용료 팀', dues: '월회비 팀' };

function isPrepaidTeam(team) {
  return !!team && team.billing_type && team.billing_type !== 'hourly';
}

/* 요금이 붙지 않는 예약인지 — 선불 팀이거나, 회비를 낸 멤버 */
function isFreeBooking() {
  if (isPersonalRoom(currentRoomId)) return !!(memberCheck?.is_member && memberCheck?.dues_ok);
  return isPrepaidTeam(selectedTeam());
}

/* 선불 팀이면 요금·입금 계좌를 통째로 감춘다. */
function updateFeeBox(dur) {
  const team    = selectedTeam();
  const feeBox  = document.getElementById('feeBox');
  const prepaid = document.getElementById('prepaidNote');

  if (isFreeBooking()) {
    feeBox.style.display = 'none';
    prepaid.style.display = '';
    const label = isPersonalRoom(currentRoomId)
      ? '회비 납부 멤버'
      : (PREPAID_LABEL[team?.billing_type] || '선불 팀');
    prepaid.innerHTML = `<b>${escHtml(label)}</b>` +
      '<span>이용 요금이 따로 청구되지 않습니다. 신청 즉시 예약이 확정됩니다.</span>';
    return;
  }

  feeBox.style.display = '';
  prepaid.style.display = 'none';

  const perHour = roomPrice(currentRoomId);
  document.getElementById('feeAmount').textContent = `${(perHour * dur).toLocaleString()}원`;
  document.getElementById('feeBreakdown').textContent =
    `시간당 ${perHour.toLocaleString()}원 × ${dur}시간`;
  document.getElementById('feeDepositBox').style.display = '';
  document.getElementById('feeNotice').textContent = '입금 확인 후 예약이 확정됩니다.';
}

/* Start/End time changes */
document.getElementById('startTime').addEventListener('change', () => {
  const prevEnd = Number(document.getElementById('endTime').value?.split(':')[0] || 0);
  populateEndTimes(prevEnd);
});
document.getElementById('endTime').addEventListener('change', updateTimeSummary);
document.getElementById('teamSelect').addEventListener('change', updateTimeSummary);

/* ============================================================
   개인연습실 — 이름으로 멤버·회비 확인
   ============================================================ */
let memberCheck = null;
let memberCheckTimer = null;

document.getElementById('bookerName').addEventListener('input', () => {
  clearTimeout(memberCheckTimer);
  memberCheck = null;
  const status = document.getElementById('bookerStatus');
  status.className = 'booker-status';
  status.textContent = '';
  syncBookerPhoneField();
  updateTimeSummary();
  // 타자 칠 때마다 부르지 않도록 잠깐 기다린다.
  memberCheckTimer = setTimeout(runMemberCheck, 450);
});

async function runMemberCheck() {
  const name = document.getElementById('bookerName').value.trim();
  const status = document.getElementById('bookerStatus');
  if (name.length < 2) return;

  try {
    const res = await fetch('/api/members/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 회비는 달마다 다르므로 보고 있는 날짜를 함께 보낸다.
      body: JSON.stringify({ name, date: toDateStr(currentDate) }),
    });
    if (!res.ok) return;
    memberCheck = await res.json();
  } catch { return; }

  // 응답이 늦게 온 사이 이름이 바뀌었으면 버린다.
  if (document.getElementById('bookerName').value.trim() !== name) return;

  const cls = memberCheck.ambiguous ? 'warn'
            : (memberCheck.is_member ? (memberCheck.dues_ok ? 'ok' : 'warn') : '');
  status.className = `booker-status ${cls}`;
  status.textContent = memberCheck.message;
  syncBookerPhoneField();
  updateTimeSummary();
}

/* Close on overlay backdrop click */
document.getElementById('modalOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

/* Copy deposit account number */
document.getElementById('copyAccountBtn').addEventListener('click', async () => {
  const btn = document.getElementById('copyAccountBtn');
  try {
    await navigator.clipboard.writeText(settings.deposit_account || '');
    const original = btn.textContent;
    btn.textContent = '복사됨 ✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch {
    showToast('클립보드 복사에 실패했습니다.', 'error');
  }
});

/* Form submit */
document.getElementById('reservationForm').addEventListener('submit', async e => {
  e.preventDefault();

  const personal = isPersonalRoom(currentRoomId);
  const teamId = Number(document.getElementById('teamSelect').value);
  const bookerName = document.getElementById('bookerName').value.trim();
  const bookerPhone = document.getElementById('bookerPhone').value.trim();

  if (personal) {
    if (!bookerName) { showToast('이용자 이름을 입력해주세요.', 'error'); return; }
    if (memberCheck?.ambiguous) { showToast(memberCheck.message, 'error'); return; }
    if (!memberCheck?.is_member && !bookerPhone) {
      showToast('게스트 예약은 연락처가 필요합니다.', 'error');
      return;
    }
  } else if (!teamId) {
    showToast('예약할 팀을 선택해주세요.', 'error');
    return;
  }

  const startTime = document.getElementById('startTime').value;
  const endTime   = document.getElementById('endTime').value;
  const startHour = Number(startTime.split(':')[0]);
  const endHour   = Number(endTime.split(':')[0]);
  const duration  = endHour - startHour;
  if (duration < 1) {
    showToast('종료 시간은 시작 시간 이후여야 합니다.', 'error');
    return;
  }
  if (endHour > HOURS_END + OVERNIGHT_END) {
    showToast(`예약 종료 시간은 다음날 ${OVERNIGHT_END}:00을 넘을 수 없습니다.`, 'error');
    return;
  }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = '신청 중...';

  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id:   currentRoomId,
        team_id:   personal ? null : teamId,
        booker_name:  personal ? bookerName : null,
        booker_phone: personal ? (bookerPhone || null) : null,
        date:      toDateStr(currentDate),
        start_time: startTime + ':00',
        duration:  duration,
        members:   document.getElementById('members').value.trim() || null,
        note:      document.getElementById('note').value.trim()     || null,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || '예약에 실패했습니다.');
    }

    const created = await res.json();
    closeModal();
    await loadReservations();
    showToast(
      created.status === 'confirmed'
        ? '예약이 확정되었습니다 🎸'
        : '예약 신청 완료! 입금 확인 후 확정됩니다 🎸',
      'success',
    );
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '예약 신청';
  }
});

/* ============================================================
   Inquiry Modal
   ============================================================ */
function openInquiryModal() {
  document.getElementById('inqContent').value = '';
  document.getElementById('inqName').value = '';
  document.getElementById('inqPhone').value = '';
  document.querySelectorAll('input[name="inqCat"]').forEach((r, i) => {
    r.checked = i === 0;
  });
  syncInquiryCatStyles();
  document.getElementById('inquiryOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeInquiryModal() {
  document.getElementById('inquiryOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function syncInquiryCatStyles() {
  document.querySelectorAll('input[name="inqCat"]').forEach(input => {
    input.closest('.inquiry-cat').classList.toggle('active', input.checked);
  });
}

document.querySelectorAll('input[name="inqCat"]').forEach(input => {
  input.addEventListener('change', syncInquiryCatStyles);
});

document.getElementById('inquiryOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeInquiryModal();
});

document.getElementById('inquiryForm').addEventListener('submit', async e => {
  e.preventDefault();
  const category = document.querySelector('input[name="inqCat"]:checked').value;
  const content  = document.getElementById('inqContent').value.trim();
  if (!content) { showToast('내용을 입력해주세요.', 'error'); return; }

  const btn = document.getElementById('inqSubmitBtn');
  btn.disabled = true; btn.textContent = '접수 중...';
  try {
    const res = await fetch('/api/inquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category,
        content,
        contact_name:  document.getElementById('inqName').value.trim()  || null,
        contact_phone: document.getElementById('inqPhone').value.trim() || null,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || '접수 실패');
    }
    closeInquiryModal();
    showToast('접수되었습니다. 빠르게 확인하겠습니다 🙏', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '접수하기';
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
  runMemberCheck();
});

document.getElementById('nextDay').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() + 1);
  updateDateDisplay();
  renderWeekStrip();
  loadReservations();
  runMemberCheck();
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

/* 입력하는 동안 전화번호에 하이픈을 넣어준다. 서버는 숫자만 저장한다. */
function formatPhone(value) {
  const raw = String(value || '').trim();
  if (!raw || !/^[\d\s\-()+.]+$/.test(raw)) return raw;
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+') || d.length < 8) return raw;
  if (d.startsWith('02')) {
    if (d.length === 9)  return `${d.slice(0,2)}-${d.slice(2,5)}-${d.slice(5)}`;
    if (d.length === 10) return `${d.slice(0,2)}-${d.slice(2,6)}-${d.slice(6)}`;
  }
  if (/^1[5-9]\d{2}/.test(d) && d.length === 8) return `${d.slice(0,4)}-${d.slice(4)}`;
  if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
  return raw;
}

document.getElementById('inqPhone').addEventListener('input', e => {
  const atEnd = e.target.selectionStart === e.target.value.length;
  const formatted = formatPhone(e.target.value);
  if (formatted !== e.target.value) {
    e.target.value = formatted;
    if (atEnd) e.target.setSelectionRange(formatted.length, formatted.length);
  }
});

/* ============================================================
   Realtime updates (SSE)
   ============================================================ */
function connectRealtime() {
  const es = new EventSource('/api/reservations/stream');

  es.onmessage = (e) => {
    if (!e.data) return;
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    const { event, data } = payload;
    if (!event || !data) return;

    const onCurrentDate = data.date === toDateStr(currentDate);

    if (event === 'reservation_created') {
      if (onCurrentDate) loadReservations();
      if (onCurrentDate && data.room_id === currentRoomId) {
        const s = fmtTime(data.start_time);
        const eTime = fmtEndTime(data.end_time);
        showToast(`새 예약 신청: ${data.team_name || ''} ${s}~${eTime}`, 'info');
      }
    } else if (event === 'reservation_deleted') {
      if (onCurrentDate) loadReservations();
    } else if (event === 'reservation_confirmed') {
      if (onCurrentDate) loadReservations();
      if (onCurrentDate && data.room_id === currentRoomId) {
        showToast(`예약 확정: ${data.team_name || ''}`, 'success');
      }
    }
  };

  es.onerror = () => {
    // Browser auto-reconnects on transient errors; nothing to do.
  };
}

/* ============================================================
   Bootstrap: rooms · teams · deposit account
   ============================================================ */
async function loadTeams() {
  const select = document.getElementById('teamSelect');
  try {
    const res = await fetch('/api/teams');
    teams = res.ok ? await res.json() : [];
  } catch { teams = []; }

  if (teams.length === 0) {
    select.innerHTML = '<option value="">등록된 팀이 없습니다</option>';
    return;
  }
  select.innerHTML = '<option value="">팀을 선택하세요</option>' +
    teams.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
}

function renderDepositInfo() {
  document.getElementById('depositBank').innerHTML =
    `${escHtml(settings.deposit_bank || '')} <b>${escHtml(settings.deposit_account || '')}</b>`;
  document.getElementById('depositHolder').textContent =
    settings.deposit_holder ? `예금주: ${settings.deposit_holder}` : '';
}

async function bootstrap() {
  const [roomRes, setRes] = await Promise.all([
    fetch('/api/rooms').catch(() => null),
    fetch('/api/settings').catch(() => null),
  ]);
  rooms = roomRes?.ok ? await roomRes.json() : [];
  if (setRes?.ok) settings = await setRes.json();

  if (rooms.length === 0) {
    showToast('공간 정보를 불러오지 못했습니다.', 'error');
    return false;
  }
  currentRoomId = rooms[0].id;
  renderRoomTabs();
  renderDepositInfo();
  await loadTeams();
  return true;
}

/* ============================================================
   Init
   ============================================================ */
async function init() {
  updateDateDisplay();
  renderWeekStrip();
  if (!await bootstrap()) return;
  buildTimeline();
  loadReservations();
  connectRealtime();
  setInterval(updateCurrentTimeLine, 60_000);

  // Scroll timeline to current hour on load
  const now = new Date();
  const scrollH = Math.max(0, now.getHours() - HOURS_START - 1);
  document.getElementById('timelineSection').scrollTop = scrollH * SLOT_H;
}

init();
