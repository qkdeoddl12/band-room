'use strict';

/* ============================================================
   정모 기록 — 참석자 · 그날 한 곡 · 사진

   기록은 정모 예약 한 건에 붙는다. 날짜·장소는 예약이 갖고 있어서 다시 안 적는다.
   저장은 통째로 한 번에 보낸다 (참석자·곡을 같은 화면에서 고치므로).
   ============================================================ */
let allMeetups = [];
let meetupSlots = [];        // 아직 기록이 없는 정모 예약
let editMeetup = null;       // 지금 편집 중인 기록
let meetupPhotos = [];       // 편집 중 사진 주소
let meetupMembers = [];      // 참석자 체크용 활동 멤버

PAGE_LOADERS.meetups = loadMeetups;

/* 참석 구분. 라벨을 여기 한 곳에만 둔다. */
const PAY_TYPE = {
  dues:    { label: '월회비',   cls: 'paid'    },
  walk_in: { label: '당일 참가비', cls: 'pending' },
  free:    { label: '무료 참관', cls: 'exempt'  },
};

async function loadMeetups() {
  const list = document.getElementById('meetupList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    // 멤버 목록은 참석자 체크에 쓴다 — 멤버 화면을 안 거치고 바로 들어와도 되게 여기서 받는다.
    [allMeetups, meetupSlots, meetupMembers] = await Promise.all([
      apiJson('/api/admin/meetups'),
      apiJson('/api/admin/meetups/slots'),
      apiJson('/api/admin/members?active=true'),
    ]);
  } catch (e) {
    allMeetups = []; meetupSlots = []; meetupMembers = [];
    list.innerHTML = `<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
    return;
  }
  renderMeetups();
}

function renderMeetups() {
  const list = document.getElementById('meetupList');
  const walkTotal = allMeetups.reduce((s, m) => s + m.walk_in_total, 0);
  setText('meetupCount',
    `기록 ${allMeetups.length}건 · 참가비 합계 ${walkTotal.toLocaleString()}원`
    + (meetupSlots.length ? ` · 기록 안 한 정모 ${meetupSlots.length}건` : ''));

  // 기록이 없는 정모 예약부터 보여준다 — 이게 할 일이다.
  const todo = meetupSlots.length ? `
    <div class="meetup-todo">
      <div class="team-add-title">기록 안 한 정모</div>
      ${meetupSlots.map(s => `
        <div class="meetup-todo-row">
          <span><b>${escHtml(s.title || '정모')}</b> · ${fmtDateKo(s.date)}
            ${fmtTime(s.start_time)}~${fmtEndTime(s.end_time)}
            ${s.room_name ? ` · ${escHtml(s.room_name)}` : ''}</span>
          <button class="btn-primary btn-page-action" onclick="createMeetupRecord(${s.reservation_id})">기록 만들기</button>
        </div>`).join('')}
    </div>` : '';

  if (!allMeetups.length) {
    list.innerHTML = todo + '<div class="admin-empty"><span class="admin-empty-icon">📸</span><div class="admin-empty-text">아직 정모 기록이 없습니다.<br>정모 예약을 잡으면 여기서 기록할 수 있습니다.</div></div>';
    return;
  }

  list.innerHTML = todo + '<div class="entity-cards">' + allMeetups.map(m => `
    <div class="ecard" onclick="openMeetupModal(${m.id})">
      <div class="ecard-top">
        <span class="ecard-name">${escHtml(m.title || '정모')}</span>
        ${m.walk_in_total ? `<span class="fee-badge pending ecard-fee">참가비 ${m.walk_in_total.toLocaleString()}원</span>` : ''}
      </div>
      <div class="ecard-sub">
        ${fmtDateKo(m.date)} ${fmtTime(m.start_time)}~${fmtEndTime(m.end_time)}
        ${m.room_name ? `<span class="ecard-parts">${escHtml(m.room_name)}</span>` : ''}
      </div>
      <div class="ecard-meta">
        <span>참석 ${m.attend_count}명${m.walk_in_count ? ` · 참가비 ${m.walk_in_count}` : ''}${m.free_count ? ` · 무료 ${m.free_count}` : ''}</span>
        <span>곡 ${m.songs.length}개${m.photos.length ? ` · 사진 ${m.photos.length}장` : ''}</span>
      </div>
      ${m.photos.length ? `<div class="meetup-thumbs">${
        m.photos.slice(0, 6).map(p => `<img src="${escHtml(p)}" alt="" loading="lazy">`).join('')
      }</div>` : ''}
    </div>`).join('') + '</div>';
}

async function createMeetupRecord(reservationId) {
  try {
    const made = await apiJson(`/api/admin/meetups/${reservationId}`, { method: 'POST' });
    await loadMeetups();
    openMeetupModal(made.id);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* ============================================================
   편집 모달
   ============================================================ */
function openMeetupModal(recordId) {
  editMeetup = allMeetups.find(m => m.id === recordId);
  if (!editMeetup) return;
  meetupPhotos = [...editMeetup.photos];

  setText('meetupModalTitle', editMeetup.title || '정모 기록');
  setText('meetupModalWhen',
    `${fmtDateKo(editMeetup.date)} ${fmtTime(editMeetup.start_time)}~${fmtEndTime(editMeetup.end_time)}`
    + (editMeetup.room_name ? ` · ${editMeetup.room_name}` : ''));
  document.getElementById('meetupMemo').value = editMeetup.memo || '';

  renderAttendeePicker();
  renderMeetupSongs();
  renderMeetupPhotos();
  openOverlay('meetupOverlay');
}

function closeMeetupModal() {
  closeOverlay('meetupOverlay');
  editMeetup = null;
}

/* 멤버는 체크로 고르고(기본 월회비), 외부 게스트는 이름을 직접 넣는다. */
function renderAttendeePicker() {
  const picked = {};
  editMeetup.attendees.forEach(a => {
    if (a.member_id) picked[a.member_id] = a;
  });

  document.getElementById('meetupMembers').innerHTML = meetupMembers
    .map(m => {
      const on = !!picked[m.id];
      return `
        <label class="part-check${on ? ' active' : ''}">
          <input type="checkbox" value="${m.id}" data-name="${escHtml(m.name)}"${on ? ' checked' : ''}
                 onchange="this.closest('.part-check').classList.toggle('active', this.checked); syncAttendeeRows()">
          <span>${escHtml(m.name)}</span>
        </label>`;
    }).join('');

  // 기존 참석자를 줄로 펼친다 (게스트 포함)
  const box = document.getElementById('meetupAttendees');
  box.innerHTML = editMeetup.attendees.map(a => attendeeRow(a)).join('');
}

function attendeeRow(a) {
  const isGuest = !a.member_id;
  return `
    <div class="meetup-att-row" data-member="${a.member_id || ''}" data-name="${escHtml(a.name)}">
      <span class="meetup-att-name">${escHtml(a.name)}${isGuest ? ' <span class="mt-badge out">게스트</span>' : ''}</span>
      <select class="form-select meetup-att-pay" onchange="syncAttendeeFee(this)">
        ${Object.entries(PAY_TYPE).map(([k, v]) =>
          `<option value="${k}"${a.pay_type === k ? ' selected' : ''}>${v.label}</option>`).join('')}
      </select>
      <input type="number" class="form-input meetup-att-fee" min="0" step="1000"
             value="${a.fee || ''}" placeholder="금액"
             ${a.pay_type === 'walk_in' ? '' : 'disabled'}>
      <button type="button" class="jam-slot-btn cancel" onclick="removeAttendeeRow(this)">빼기</button>
    </div>`;
}

function removeAttendeeRow(btn) {
  const row = btn.closest('.meetup-att-row');
  // 명부에서 체크를 켜둔 채 줄만 지우면 다음 동기화 때 되살아난다 — 체크도 같이 끈다.
  const box = document.querySelector(`#meetupMembers input[value="${row.dataset.member}"]`);
  if (box) { box.checked = false; box.closest('.part-check').classList.remove('active'); }
  row.remove();
  refreshSongWho();
}

/* 참가비일 때만 금액칸이 열린다 — 나머지는 서버에서도 0 으로 눌러 정산이 안 섞인다. */
function syncAttendeeFee(select) {
  const fee = select.closest('.meetup-att-row').querySelector('.meetup-att-fee');
  fee.disabled = select.value !== 'walk_in';
  if (fee.disabled) fee.value = '';
}

/* 체크한 멤버를 참석자 줄에 더하고, 뺀 멤버는 지운다. */
function syncAttendeeRows() {
  const box = document.getElementById('meetupAttendees');
  const checked = [...document.querySelectorAll('#meetupMembers input:checked')]
    .map(i => ({ id: Number(i.value), name: i.dataset.name }));
  const have = new Set([...box.querySelectorAll('.meetup-att-row')]
    .map(r => r.dataset.member).filter(Boolean).map(Number));

  checked.filter(m => !have.has(m.id)).forEach(m => {
    box.insertAdjacentHTML('beforeend',
      attendeeRow({ member_id: m.id, name: m.name, pay_type: 'dues', fee: 0 }));
  });
  const keep = new Set(checked.map(m => m.id));
  box.querySelectorAll('.meetup-att-row').forEach(row => {
    const id = row.dataset.member;
    if (id && !keep.has(Number(id))) row.remove();
  });
  refreshSongWho();
}

function addMeetupGuest() {
  const input = document.getElementById('meetupGuestName');
  const name = input.value.trim();
  if (!name) { showToast('이름을 입력해주세요.', 'error'); return; }
  // 명부에 없는 사람이라 기본은 당일 참가비다.
  document.getElementById('meetupAttendees').insertAdjacentHTML('beforeend',
    attendeeRow({ member_id: null, name, pay_type: 'walk_in', fee: 0 }));
  input.value = '';
  refreshSongWho();
}

/* ---- 곡 ---- */
function renderMeetupSongs() {
  document.getElementById('meetupSongs').innerHTML =
    editMeetup.songs.map(s => meetupSongRow(s)).join('');
}

function meetupSongRow(s) {
  const parts = (s.parts || []);
  return `
    <div class="meetup-song-row">
      <input type="text" class="form-input meetup-song-title" maxlength="200"
             value="${escHtml(s.title || '')}" placeholder="곡 제목">
      <button type="button" class="jam-slot-btn cancel" onclick="this.closest('.meetup-song-row').remove()">빼기</button>
      <div class="meetup-song-parts">${parts.map(p => songPartRow(p)).join('')}</div>
      <button type="button" class="meetup-part-add" onclick="addSongPart(this)">＋ 포지션</button>
    </div>`;
}

/* 곡 한 줄 = 포지션 + 그 자리를 맡은 사람. 사람은 참석 명단에서 고른다. */
function songPartRow(p) {
  return `
    <div class="meetup-part-row">
      ${songPartSelect(p.part || '')}
      ${songWhoSelect(partKey(p), p.name)}
      <button type="button" class="jam-slot-btn cancel"
              onclick="this.closest('.meetup-part-row').remove()">✕</button>
    </div>`;
}

/* 저장된 값과 드롭다운 값을 잇는 열쇠. 멤버는 id, 게스트는 이름이 신원이다. */
function partKey(p) {
  if (!p || !p.name) return '';
  return p.member_id ? `m:${p.member_id}` : `g:${p.name}`;
}

function songPartSelect(part) {
  // 옛 기록에 명단에 없는 포지션이 있으면 그것도 남긴다 (조용히 바뀌지 않게)
  const list = part && !FIXED_PARTS.includes(part) ? [...FIXED_PARTS, part] : FIXED_PARTS;
  return `<select class="form-select meetup-part-pos">
      <option value="">포지션</option>
      ${list.map(p => `<option value="${escHtml(p)}"${p === part ? ' selected' : ''}>${escHtml(p)}</option>`).join('')}
    </select>`;
}

/* 고를 수 있는 사람 = 지금 참석 명단(멤버 + 게스트). */
function attendeeOptions() {
  return [...document.querySelectorAll('#meetupAttendees .meetup-att-row')].map(r => ({
    key: r.dataset.member ? `m:${r.dataset.member}` : `g:${r.dataset.name}`,
    name: r.dataset.name,
  }));
}

function songWhoSelect(key, name) {
  const opts = attendeeOptions();
  // 명단에서 빠진 사람이라도 이미 고른 값은 남긴다 — 기록을 조용히 지우지 않는다.
  if (key && !opts.some(o => o.key === key)) {
    opts.push({ key, name: name || key.replace(/^[mg]:/, '') });
  }
  return `<select class="form-select meetup-part-who">
      <option value="">사람</option>
      ${opts.map(o => `<option value="${escHtml(o.key)}"${o.key === key ? ' selected' : ''}>${escHtml(o.name)}</option>`).join('')}
    </select>`;
}

/* 참석 명단이 바뀌면 곡의 사람 드롭다운을 다시 그린다 (고른 값은 유지). */
function refreshSongWho() {
  document.querySelectorAll('.meetup-part-who').forEach(sel => {
    const key = sel.value;
    const name = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : '';
    sel.outerHTML = songWhoSelect(key, name);
  });
}

function addSongPart(btn) {
  btn.closest('.meetup-song-row').querySelector('.meetup-song-parts')
     .insertAdjacentHTML('beforeend', songPartRow({}));
}

function addMeetupSong() {
  document.getElementById('meetupSongs').insertAdjacentHTML('beforeend',
    meetupSongRow({ title: '', parts: [] }));
}

/* ---- 사진 ---- */
function renderMeetupPhotos() {
  document.getElementById('meetupPhotos').innerHTML = meetupPhotos.map((p, i) => `
    <div class="meetup-photo">
      <img src="${escHtml(p)}" alt="" loading="lazy">
      <button type="button" class="meetup-photo-x" onclick="removeMeetupPhoto(${i})">✕</button>
    </div>`).join('');
}

function removeMeetupPhoto(index) {
  meetupPhotos.splice(index, 1);
  renderMeetupPhotos();
}

async function uploadMeetupPhotos(input) {
  const files = [...input.files];
  if (!files.length) return;
  const status = document.getElementById('meetupPhotoStatus');
  status.textContent = `올리는 중... (0/${files.length})`;
  let done = 0;
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    try {
      // api() 는 FormData 에 Content-Type 을 붙이지 않는다 (multipart boundary 보존)
      const res = await apiJson('/api/admin/meetups/upload', { method: 'POST', body: form });
      meetupPhotos.push(res.url);
    } catch (e) {
      showToast(`${file.name}: ${e.message}`, 'error');
    }
    status.textContent = `올리는 중... (${++done}/${files.length})`;
  }
  status.textContent = '';
  input.value = '';
  renderMeetupPhotos();
}

/* ---- 저장 ---- */
document.getElementById('meetupForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!editMeetup) return;

  const attendees = [...document.querySelectorAll('#meetupAttendees .meetup-att-row')].map(row => {
    const pay = row.querySelector('.meetup-att-pay').value;
    return {
      member_id: row.dataset.member ? Number(row.dataset.member) : null,
      name: row.querySelector('.meetup-att-name').textContent.replace('게스트', '').trim(),
      pay_type: pay,
      fee: pay === 'walk_in' ? Number(row.querySelector('.meetup-att-fee').value) || 0 : 0,
    };
  });
  const songs = [...document.querySelectorAll('#meetupSongs .meetup-song-row')]
    .map(row => ({
      title: row.querySelector('.meetup-song-title').value.trim(),
      parts: [...row.querySelectorAll('.meetup-part-row')].map(pr => {
        const who = pr.querySelector('.meetup-part-who');
        const key = who.value;
        return {
          part: pr.querySelector('.meetup-part-pos').value,
          name: key ? who.selectedOptions[0].textContent.trim() : '',
          member_id: key.startsWith('m:') ? Number(key.slice(2)) : null,
        };
      }).filter(p => p.part && p.name),
    }))
    .filter(s => s.title);

  const btn = document.getElementById('meetupSaveBtn');
  btn.disabled = true; btn.textContent = '저장 중...';
  try {
    await apiJson(`/api/admin/meetups/${editMeetup.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        memo: document.getElementById('meetupMemo').value.trim() || null,
        photos: meetupPhotos,
        attendees,
        songs,
      }),
    });
    closeMeetupModal();
    await loadMeetups();
    showToast('저장되었습니다.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '저장';
  }
});

async function deleteMeetupRecord() {
  if (!editMeetup) return;
  if (!confirm(`[${editMeetup.title || '정모'}] 기록을 삭제하시겠습니까?\n참석자·곡·사진 목록이 함께 사라집니다.`)) return;
  try {
    await apiJson(`/api/admin/meetups/${editMeetup.id}`, { method: 'DELETE' });
    closeMeetupModal();
    await loadMeetups();
    showToast('삭제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

bindOverlayClose('meetupOverlay', closeMeetupModal);
