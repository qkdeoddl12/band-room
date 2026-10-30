'use strict';

/* ============================================================
   이용안내 — 요금과 계좌는 서버 설정에서 가져온다.
   화면에 금액을 박아두면 관리자가 환경 설정에서 바꿔도 안내문만 옛날 값으로 남는다.
   ============================================================ */

/* app.js 의 OVERNIGHT_END 와 같은 값이어야 한다. 한쪽만 고치면 안내가 거짓말이 된다. */
const OVERNIGHT_END = 6;
/* app.js · admin/core.js 의 LONG_HOURS 와 같은 값 — 이 시간 이상이면 장시간 요금. */
const LONG_HOURS = 3;

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MODE_KO = {
  team: '팀 단위로 예약합니다. 등록된 팀만 고를 수 있습니다.',
  personal: '개인이 예약합니다. 회원은 이름만, 회원이 아니면 연락처도 적습니다.',
};

async function loadGuide() {
  document.getElementById('guideOvernight').textContent = `다음날 새벽 ${OVERNIGHT_END}시`;

  const [rooms, settings] = await Promise.all([
    fetch('/api/rooms').then(r => r.json()).catch(() => []),
    fetch('/api/settings').then(r => r.json()).catch(() => null),
  ]);

  renderRooms(rooms);
  renderDeposit(settings);
}

function renderRooms(rooms) {
  const box = document.getElementById('guideRooms');
  if (!rooms.length) { box.innerHTML = ''; return; }

  box.innerHTML = '<h2>공간과 요금</h2><div class="guide-room-cards">' + rooms.map((room, i) => `
    <div class="guide-room r${Math.min(2, i + 1)}">
      <div class="guide-room-name">${escHtml(room.name)}</div>
      ${room.description ? `<div class="guide-room-desc">${escHtml(room.description)}</div>` : ''}
      <div class="guide-room-price">
        ${room.hourly_price
          ? `시간당 ${room.hourly_price.toLocaleString()}원`
          : '요금 문의'}
      </div>
      ${room.long_hourly_price
        ? `<div class="guide-room-desc">${LONG_HOURS}시간 이상 시간당 ${room.long_hourly_price.toLocaleString()}원</div>`
        : ''}
      <div class="guide-room-mode">${escHtml(MODE_KO[room.booking_mode] || '')}</div>
    </div>
  `).join('') + '</div>';
}

function renderDeposit(s) {
  const box = document.getElementById('guideDeposit');
  if (!s || !s.deposit_account) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <h2>입금 계좌</h2>
    <div class="guide-account">
      <div class="guide-account-num">${escHtml(s.deposit_bank)} ${escHtml(s.deposit_account)}</div>
      <div class="guide-account-holder">예금주 ${escHtml(s.deposit_holder)}</div>
    </div>
    <p class="guide-account-note">
      요금이 있는 예약만 입금하시면 됩니다. 입금자명은 <b>팀 이름</b> 또는 <b>예약하신 분 이름</b>으로 해주세요.
    </p>`;
}

loadGuide();
