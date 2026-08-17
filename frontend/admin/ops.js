'use strict';

/* ============================================================
   문의/민원 · 차단 설정
   ============================================================ */
let currentInqStatus = 'new';
let currentInqCat    = 'all';
let deleteBlockedTargetId = null;

PAGE_LOADERS.inquiries = loadInquiries;
PAGE_LOADERS.blocked   = loadBlocked;

const INQ_META = {
  question:  { icon: '💬', label: '문의',       cls: 'cat-question'  },
  complaint: { icon: '🛠', label: '불편사항',    cls: 'cat-complaint' },
  incident:  { icon: '⚠️', label: '사고 접수',   cls: 'cat-incident'  },
};

/* ============================================================
   Inquiries
   ============================================================ */
async function loadInquiries() {
  document.getElementById('inquiryList').innerHTML = '<div class="spinner"></div>';
  try {
    allInquiries = await apiJson('/api/admin/inquiries');
  } catch (e) {
    allInquiries = [];
    showToast(e.message, 'error');
  }
  renderInquiries();
  refreshInquiryBadge();
}

async function refreshInquiryBadge() {
  if (allInquiries.length === 0) {
    try { allInquiries = await apiJson('/api/admin/inquiries?status=new'); } catch {}
  }
  const newCount = allInquiries.filter(i => i.status === 'new').length;
  ['navInquiryBadge', 'mobileInquiryBadge', 'moreInquiryBadge'].forEach(id => {
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
        ${(i.contact_name || i.contact_phone) ? `<div class="inquiry-contact">👤 ${escHtml(i.contact_name || '')} ${escHtml(formatPhone(i.contact_phone))}</div>` : ''}
      </div>
    `;
  });
  html += '</div>';
  list.innerHTML = html;
}

function openInquiryDetail(id) {
  const i = allInquiries.find(x => x.id === id);
  if (!i) return;
  const meta = INQ_META[i.category] || { icon: '📩', label: i.category, cls: '' };
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
        ${i.contact_phone ? `<div>📞 <a href="tel:${escHtml(i.contact_phone)}">${escHtml(formatPhone(i.contact_phone))}</a></div>` : ''}
      </div>
    ` : '<div class="inquiry-detail-contact muted">연락처 정보 없음</div>'}

    ${!isNew ? `
      <div class="inquiry-detail-resolved">
        ✅ ${escHtml(i.resolved_by || '관리자')} · ${fmtDateTime(i.resolved_at)}
      </div>
    ` : ''}

    <div class="modal-actions">
      <button onclick="deleteInquiry(${i.id})" class="btn-danger" style="flex:1;">삭제</button>
      ${isNew
        ? `<button onclick="resolveInquiry(${i.id})" class="btn-submit" style="flex:2;margin-top:0;">처리 완료</button>`
        : `<button onclick="closeInquiryDetail()" class="btn-submit" style="flex:2;margin-top:0;">닫기</button>`}
    </div>
  `;
  openOverlay('inquiryDetailOverlay');
}

function closeInquiryDetail() { closeOverlay('inquiryDetailOverlay'); }
bindOverlayClose('inquiryDetailOverlay', closeInquiryDetail);

async function resolveInquiry(id) {
  try {
    await apiJson(`/api/admin/inquiries/${id}/resolve`, { method: 'POST' });
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
    await apiJson(`/api/admin/inquiries/${id}`, { method: 'DELETE' });
    closeInquiryDetail();
    await loadInquiries();
    showToast('삭제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* ============================================================
   Blocked Periods
   ============================================================ */
async function loadBlocked() {
  const list = document.getElementById('blockedList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    allBlocked = await apiJson('/api/blocked');
  } catch {
    allBlocked = [];
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">목록을 불러오지 못했습니다.</div></div>';
    return;
  }
  renderBlocked();
}

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
          <span class="res-room-tag ${roomTagCls(b.room_id)}">${escHtml(roomName(b.room_id))}</span>
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
  document.getElementById('blockReason').value = '';

  const roomSel = document.getElementById('blockRoom');
  roomSel.innerHTML = '<option value="">전체 공간</option>' +
    roomList().map(r => `<option value="${r.id}">${escHtml(r.name)}</option>`).join('');
  roomSel.value = '';

  populateBlockTimes();
  openOverlay('createBlockedOverlay');
}

function closeCreateBlockedModal() { closeOverlay('createBlockedOverlay'); }

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
    await apiJson('/api/admin/blocked', { method: 'POST', body: JSON.stringify(body) });
    closeCreateBlockedModal();
    await loadBlocked();
    showToast('차단이 등록되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '차단 등록';
  }
});

bindOverlayClose('createBlockedOverlay', closeCreateBlockedModal);

function openDeleteBlockedModal(id) {
  const b = allBlocked.find(x => x.id === id);
  if (!b) return;
  deleteBlockedTargetId = id;
  const allDay = !b.start_time || !b.end_time;
  const timeStr = allDay ? '하루 종일' : `${fmtTime(b.start_time)} ~ ${fmtTime(b.end_time)}`;
  document.getElementById('deleteBlockedTarget').innerHTML = `
    <b>${fmtDateKo(b.date)}</b><br>
    ${escHtml(roomName(b.room_id))} · ${timeStr}
    ${b.reason ? `<br>📝 ${escHtml(b.reason)}` : ''}
  `;
  openOverlay('deleteBlockedOverlay');
}

function closeDeleteBlockedModal() {
  closeOverlay('deleteBlockedOverlay');
  deleteBlockedTargetId = null;
}

document.getElementById('confirmDeleteBlockedBtn').addEventListener('click', async () => {
  if (!deleteBlockedTargetId) return;
  const btn = document.getElementById('confirmDeleteBlockedBtn');
  btn.disabled = true; btn.textContent = '해제 중...';
  try {
    await apiJson(`/api/admin/blocked/${deleteBlockedTargetId}`, { method: 'DELETE' });
    closeDeleteBlockedModal();
    await loadBlocked();
    showToast('차단이 해제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '해제';
  }
});

bindOverlayClose('deleteBlockedOverlay', closeDeleteBlockedModal);
