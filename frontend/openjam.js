'use strict';

/* ============================================================
   오픈 잼 — 1곡 단위 자율 합주 매칭

   로그인이 없다. 신원은 이름으로 확인하고(서버가 멤버 명부와 대조),
   "내가 발제한 잼 / 내가 잡은 자리"는 브라우저에 토큰을 남겨 가린다.
   예약 페이지의 내 예약(app.js::loadMyRes)과 같은 방식이다.
   ============================================================ */
const JAM_KEY  = 'bandroom_my_jams';    // { jamId: manage_token }
const SLOT_KEY = 'bandroom_my_slots';   // { slotId: claim_token }

let jams = [];
let claimTarget = null;   // 지원하려고 고른 자리

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  setTimeout(() => { el.className = 'toast'; }, 3000);
}

function loadStore(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}
function saveStore(key, map) {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch {}
}
function remember(key, id, token) {
  const map = loadStore(key);
  map[id] = token;
  saveStore(key, map);
}
function forget(key, id) {
  const map = loadStore(key);
  delete map[id];
  saveStore(key, map);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    let detail = '요청에 실패했습니다.';
    try {
      const body = (await res.json()).detail;
      if (typeof body === 'string') detail = body;
      else if (Array.isArray(body) && body.length) {
        detail = body.map(e => `${(e.loc || []).slice(1).join('.')}: ${e.msg}`).join(', ');
      }
    } catch {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

/* ============================================================
   목록
   ============================================================ */
async function loadJams() {
  const list = document.getElementById('jamList');
  try {
    jams = await api('/api/openjams');
  } catch (e) {
    list.innerHTML = `<div class="jam-empty">${escHtml(e.message)}</div>`;
    return;
  }
  renderJams();
}

function renderJams() {
  const list = document.getElementById('jamList');
  if (!jams.length) {
    list.innerHTML = `
      <div class="jam-empty">
        <div class="jam-empty-icon">🎵</div>
        아직 올라온 곡이 없습니다.<br>
        하고 싶은 곡을 먼저 제안해보세요.
      </div>`;
    return;
  }

  const mine = loadStore(JAM_KEY);
  const mySlots = loadStore(SLOT_KEY);

  list.innerHTML = jams.map(jam => {
    const filled = jam.slots.filter(s => s.member_name).length;
    const total  = jam.slots.length;
    const isMine = !!mine[jam.id];
    const closed = jam.status !== 'recruiting';

    const slots = jam.slots.map(slot => {
      const taken = !!slot.member_name;
      const isMySlot = !!mySlots[slot.id];
      return `
        <div class="jam-slot${taken ? ' taken' : ''}${isMySlot ? ' mine' : ''}">
          <span class="jam-slot-part">${escHtml(slot.part)}</span>
          <span class="jam-slot-who">${taken ? escHtml(slot.member_name) : '비어 있음'}</span>
          ${isMySlot
            ? `<button class="jam-slot-btn cancel" onclick="releaseSlot(${slot.id})">취소</button>`
            : (!taken && !closed)
              ? `<button class="jam-slot-btn" onclick="openJamClaim(${jam.id}, ${slot.id})">지원</button>`
              : ''}
        </div>`;
    }).join('');

    return `
      <div class="jam-card${closed ? ' closed' : ''}">
        <div class="jam-card-top">
          <span class="jam-status ${closed ? 'closed' : 'recruiting'}">
            ${closed ? '모집 완료' : `모집중 ${filled}/${total}`}
          </span>
          ${isMine ? '<span class="jam-status mine">내 제안</span>' : ''}
        </div>
        <div class="jam-title">${escHtml(jam.title)}</div>
        <div class="jam-meta">
          발제 ${escHtml(jam.leader_name || '—')}
          ${jam.target_period ? ` · 🗓 ${escHtml(jam.target_period)}` : ''}
        </div>
        ${jam.memo ? `<div class="jam-memo">${escHtml(jam.memo)}</div>` : ''}
        <div class="jam-slots">${slots}</div>
        ${isMine ? `
          <div class="jam-owner-actions">
            ${closed ? '' : `<button class="jam-owner-btn" onclick="closeJam(${jam.id})">모집 마감</button>`}
            ${filled === 0 ? `<button class="jam-owner-btn danger" onclick="deleteJam(${jam.id})">삭제</button>` : ''}
          </div>
          ${closed ? '<div class="jam-hint">예약 페이지에서 이 오픈 잼으로 합주실을 잡을 수 있습니다.</div>' : ''}
        ` : ''}
      </div>`;
  }).join('');
}

/* ============================================================
   지원 / 취소
   ============================================================ */
function openJamClaim(jamId, slotId) {
  const jam = jams.find(j => j.id === jamId);
  const slot = jam && jam.slots.find(s => s.id === slotId);
  if (!slot) return;
  claimTarget = { jamId, slotId };
  document.getElementById('jamClaimTarget').innerHTML =
    `<b>${escHtml(jam.title)}</b><br>${escHtml(slot.part)} 자리`;
  document.getElementById('jamClaimName').value = '';
  openOverlay('jamClaimOverlay');
}

function closeJamClaim() {
  closeOverlay('jamClaimOverlay');
  claimTarget = null;
}

document.getElementById('jamClaimForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!claimTarget) return;
  const name = document.getElementById('jamClaimName').value.trim();
  if (!name) { showToast('이름을 입력해주세요.', 'error'); return; }

  const btn = document.getElementById('jamClaimBtn');
  btn.disabled = true; btn.textContent = '잡는 중...';
  try {
    const got = await api(`/api/openjam-slots/${claimTarget.slotId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    // 취소 열쇠는 이 응답에만 온다 — 여기서 안 챙기면 다시는 못 받는다.
    remember(SLOT_KEY, got.slot_id, got.claim_token);
    closeJamClaim();
    await loadJams();
    showToast(`${got.part} 자리를 잡았습니다 🎸`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    await loadJams();   // 경합에 밀렸으면 현황을 새로 보여준다
  } finally {
    btn.disabled = false; btn.textContent = '이 자리 잡기';
  }
});

async function releaseSlot(slotId) {
  const token = loadStore(SLOT_KEY)[slotId];
  if (!token) { showToast('취소 정보를 찾을 수 없습니다.', 'error'); return; }
  if (!confirm('이 자리를 취소할까요?')) return;
  try {
    await api(`/api/openjam-slots/${slotId}/release`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    forget(SLOT_KEY, slotId);
    await loadJams();
    showToast('지원을 취소했습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* ============================================================
   발제 / 마감 / 삭제
   ============================================================ */
function openJamCreate() {
  document.getElementById('jamTitle').value  = '';
  document.getElementById('jamLeader').value = '';
  document.getElementById('jamPeriod').value = '';
  document.getElementById('jamMemo').value   = '';
  document.getElementById('jamPartsOther').value = '';
  document.getElementById('jamParts').innerHTML = FIXED_PARTS.map(p => `
    <label class="part-check">
      <input type="checkbox" value="${escHtml(p)}" onchange="syncJamParts(this)">
      <span>${escHtml(p)}</span>
    </label>
  `).join('');
  document.getElementById('jamPartCounts').innerHTML = '';
  openOverlay('jamCreateOverlay');
}

function closeJamCreate() { closeOverlay('jamCreateOverlay'); }

/* 고른 포지션마다 인원 수를 조절할 줄을 만든다. 안 고르면 줄도 없다. */
function syncJamParts(input) {
  input.closest('.part-check').classList.toggle('active', input.checked);
  const chosen = [...document.querySelectorAll('#jamParts input:checked')].map(i => i.value);
  const box = document.getElementById('jamPartCounts');
  const prev = {};
  box.querySelectorAll('input').forEach(i => { prev[i.dataset.part] = i.value; });
  box.innerHTML = chosen.map(p => `
    <div class="jam-count-row">
      <span>${escHtml(p)}</span>
      <input type="number" min="1" max="10" step="1" class="form-input"
             data-part="${escHtml(p)}" value="${prev[p] || 1}">
      <span class="jam-count-unit">명</span>
    </div>
  `).join('');
}

function readJamSlots() {
  const rows = [...document.querySelectorAll('#jamPartCounts input')].map(i => ({
    part: i.dataset.part,
    count: Math.max(1, Math.min(10, Number(i.value) || 1)),
  }));
  // 자유 입력 포지션은 1명씩
  document.getElementById('jamPartsOther').value
    .split(',').map(s => s.trim()).filter(Boolean)
    .forEach(part => rows.push({ part, count: 1 }));
  return rows;
}

document.getElementById('jamCreateForm').addEventListener('submit', async e => {
  e.preventDefault();
  const title  = document.getElementById('jamTitle').value.trim();
  const leader = document.getElementById('jamLeader').value.trim();
  const slots  = readJamSlots();
  if (!title)  { showToast('곡을 입력해주세요.', 'error'); return; }
  if (!leader) { showToast('발제자 이름을 입력해주세요.', 'error'); return; }
  if (!slots.length) { showToast('모집할 포지션을 골라주세요.', 'error'); return; }

  const btn = document.getElementById('jamCreateBtn');
  btn.disabled = true; btn.textContent = '올리는 중...';
  try {
    const made = await api('/api/openjams', {
      method: 'POST',
      body: JSON.stringify({
        title,
        leader_name: leader,
        target_period: document.getElementById('jamPeriod').value.trim() || null,
        memo: document.getElementById('jamMemo').value.trim() || null,
        slots,
      }),
    });
    // 관리 열쇠는 이 응답에만 온다.
    remember(JAM_KEY, made.id, made.manage_token);
    closeJamCreate();
    await loadJams();
    showToast('곡을 올렸습니다 🎵', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '제안 올리기';
  }
});

async function closeJam(jamId) {
  const token = loadStore(JAM_KEY)[jamId];
  if (!token) return;
  if (!confirm('모집을 마감할까요? 마감하면 더 지원받지 않고 합주실을 예약할 수 있습니다.')) return;
  try {
    await api(`/api/openjams/${jamId}/close`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    await loadJams();
    showToast('모집을 마감했습니다. 예약 페이지에서 합주실을 잡으세요.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function deleteJam(jamId) {
  const token = loadStore(JAM_KEY)[jamId];
  if (!token) return;
  if (!confirm('이 제안을 지울까요?')) return;
  try {
    await api(`/api/openjams/${jamId}?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    forget(JAM_KEY, jamId);
    await loadJams();
    showToast('삭제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* ============================================================
   공용
   ============================================================ */
function openOverlay(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeOverlay(id) {
  document.getElementById(id).classList.remove('open');
  document.body.style.overflow = '';
}
['jamCreateOverlay', 'jamClaimOverlay'].forEach(id => {
  const ov = document.getElementById(id);
  ov.addEventListener('click', e => { if (e.target === ov) closeOverlay(id); });
});

loadJams();
