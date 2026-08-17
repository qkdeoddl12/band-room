'use strict';

/* ============================================================
   티켓 — 목록 + 드래그 배치 에디터
   ============================================================ */
const TK_PRESETS = [
  { key: 'title',  label: '공연명', text: 'DOORS LIVE', y: 22, size: 9,   weight: 800 },
  { key: 'date',   label: '일자',   text: '2026.09.13 (일) 18:00', y: 62, size: 4.5, weight: 600 },
  { key: 'place',  label: '장소',   text: '홍대 밴드룸', y: 70, size: 4.5, weight: 600 },
  { key: 'lineup', label: '참여팀', text: 'THE DOORS · 밴드A · 밴드B', y: 80, size: 3.6, weight: 500 },
];

const TK_ASPECTS = ['3:4', '9:16', '1:1', '4:3'];

let allTickets    = [];
let currentTicket = null;   // 편집 중인 티켓
let tkSelectedId  = null;
let tkDirty       = false;

PAGE_LOADERS.tickets = loadTickets;

/* ============================================================
   목록
   ============================================================ */
async function loadTickets() {
  showTicketList();
  const list = document.getElementById('ticketList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    allTickets = await apiJson('/api/admin/tickets');
  } catch (e) {
    allTickets = [];
    list.innerHTML = `<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
    return;
  }
  renderTicketList();
}

function renderTicketList() {
  const list = document.getElementById('ticketList');
  if (allTickets.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">🎫</span><div class="admin-empty-text">만든 티켓이 없습니다. 새 티켓을 만들어보세요.</div></div>';
    return;
  }

  list.innerHTML = '<div class="ticket-cards">' + allTickets.map(t => `
    <div class="ticket-card" onclick="openTicketEditor(${t.id})">
      <div class="ticket-thumb${t.bg_url ? '' : ' no-bg'}"
           style="${t.bg_url ? `background-image:url('${encodeURI(t.bg_url)}')` : ''}">
        ${t.bg_url ? '' : '🎫'}
      </div>
      <div class="ticket-card-body">
        <div class="ticket-card-title">${escHtml(t.title)}</div>
        <div class="ticket-card-sub">
          ${t.is_published
            ? '<span class="ticket-pub published">공개중</span>'
            : '<span class="ticket-pub draft">비공개</span>'}
          <span>👁 ${t.view_count ?? 0}</span>
          <span>↗ ${t.share_count ?? 0}</span>
          <span>🔗 ${t.copy_count ?? 0}</span>
          <span>${fmtDateTime(t.created_at)}</span>
        </div>
      </div>
    </div>
  `).join('') + '</div>';
}

async function createTicket() {
  const title = prompt('티켓 이름 (공연 제목)');
  if (!title || !title.trim()) return;
  try {
    const t = await apiJson('/api/admin/tickets', {
      method: 'POST',
      body: JSON.stringify({ title: title.trim() }),
    });
    await loadTickets();
    openTicketEditor(t.id);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* ============================================================
   에디터 열기/닫기
   ============================================================ */
function showTicketList() {
  document.getElementById('ticketListView').style.display = '';
  document.getElementById('ticketEditView').style.display = 'none';
  document.getElementById('ticketStatsView').style.display = 'none';
  currentTicket = null;
  tkSelectedId  = null;
  tkDirty       = false;
}

async function openTicketEditor(id) {
  try {
    currentTicket = await apiJson(`/api/admin/tickets/${id}`);
  } catch (e) {
    showToast(e.message, 'error');
    return;
  }
  currentTicket.elements = currentTicket.elements || [];
  tkSelectedId = null;
  tkDirty = false;

  document.getElementById('ticketListView').style.display = 'none';
  document.getElementById('ticketEditView').style.display = '';
  document.getElementById('tkTitle').value = currentTicket.title;
  document.getElementById('tkMapUrl').value = currentTicket.map_url || '';
  document.getElementById('tkPublished').checked = currentTicket.is_published;

  document.getElementById('tkAspect').innerHTML = TK_ASPECTS.map(a =>
    `<option value="${a}"${a === currentTicket.aspect ? ' selected' : ''}>${a}</option>`).join('');

  document.getElementById('tkSlug').value = currentTicket.slug;
  renderTicketStats();
  syncShareLink();
  syncShareState();
  tkDraw();
}

function backToTicketList() {
  if (tkDirty && !confirm('저장하지 않은 변경사항이 있습니다. 목록으로 돌아갈까요?')) return;
  loadTickets();
}

/* ============================================================
   캔버스 렌더 + 속성 패널
   ============================================================ */
function tkDraw() {
  const canvas = document.getElementById('tkCanvas');
  tkRender(canvas, currentTicket, { editable: true, selectedId: tkSelectedId });
  renderTkPanel();
}

function tkSelected() {
  return currentTicket?.elements.find(e => e.id === tkSelectedId) || null;
}

function renderTkPanel() {
  const panel = document.getElementById('tkPanel');
  const el = tkSelected();
  if (!el) {
    panel.innerHTML = '<div class="tk-panel-empty">요소를 선택하면 여기서 편집할 수 있습니다.<br>드래그해서 위치를 옮기세요.</div>';
    return;
  }

  panel.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="tkText">내용</label>
      <textarea class="form-textarea" id="tkText" rows="2"
                oninput="tkUpdate('text', this.value)">${escHtml(el.text)}</textarea>
    </div>
    <div class="tk-panel-row">
      <div class="form-group">
        <label class="form-label" for="tkSize">크기 <span id="tkSizeVal">${el.size}</span></label>
        <input type="range" id="tkSize" min="1.5" max="20" step="0.5" value="${el.size}"
               oninput="document.getElementById('tkSizeVal').textContent=this.value; tkUpdate('size', Number(this.value))">
      </div>
      <div class="form-group tk-color">
        <label class="form-label" for="tkColor">색상</label>
        <input type="color" id="tkColor" value="${el.color}"
               oninput="tkUpdate('color', this.value.toUpperCase())">
      </div>
    </div>
    <div class="tk-panel-row">
      <div class="form-group">
        <label class="form-label" for="tkWeight">굵기</label>
        <select class="form-select" id="tkWeight" onchange="tkUpdate('weight', Number(this.value))">
          ${[400,500,600,700,800,900].map(w => `<option value="${w}"${w === el.weight ? ' selected' : ''}>${w}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="tkAlign">정렬</label>
        <select class="form-select" id="tkAlign" onchange="tkUpdate('align', this.value)">
          ${[['left','왼쪽'],['center','가운데'],['right','오른쪽']].map(([v,l]) =>
            `<option value="${v}"${v === el.align ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
    </div>
    <label class="toggle-row">
      <span class="toggle-title">그림자</span>
      <input type="checkbox" class="toggle-switch" id="tkShadow" ${el.shadow ? 'checked' : ''}
             onchange="tkUpdate('shadow', this.checked)">
    </label>
    <button type="button" class="btn-danger tk-del" onclick="tkDeleteElement()">요소 삭제</button>
  `;
}

/* 속성 변경은 캔버스만 다시 그린다 — 패널을 다시 그리면 입력 포커스가 날아간다. */
function tkUpdate(key, value) {
  const el = tkSelected();
  if (!el) return;
  el[key] = value;
  tkDirty = true;
  tkRender(document.getElementById('tkCanvas'), currentTicket, {
    editable: true, selectedId: tkSelectedId,
  });
}

function tkDeleteElement() {
  if (!tkSelectedId) return;
  currentTicket.elements = currentTicket.elements.filter(e => e.id !== tkSelectedId);
  tkSelectedId = null;
  tkDirty = true;
  tkDraw();
}

/* ============================================================
   요소 추가
   ============================================================ */
function tkNextId() {
  const used = new Set(currentTicket.elements.map(e => e.id));
  for (let i = 1; i < 999; i++) {
    if (!used.has('e' + i)) return 'e' + i;
  }
  return 'e' + Date.now();
}

function tkAddElement(presetKey) {
  if (!currentTicket) return;
  if (currentTicket.elements.length >= 40) {
    showToast('요소는 최대 40개까지 넣을 수 있습니다.', 'error');
    return;
  }
  const p = TK_PRESETS.find(x => x.key === presetKey);
  const el = {
    id: tkNextId(),
    text: p ? p.text : '텍스트',
    x: 50,
    y: p ? p.y : 50,
    size: p ? p.size : 5,
    color: '#FFFFFF',
    weight: p ? p.weight : 700,
    align: 'center',
    shadow: true,
  };
  currentTicket.elements.push(el);
  tkSelectedId = el.id;
  tkDirty = true;
  tkDraw();
}

/* ============================================================
   드래그 (마우스 · 터치 공용)
   ============================================================ */
let tkDrag = null;

document.getElementById('tkCanvas').addEventListener('pointerdown', e => {
  const target = e.target.closest('.tk-el');
  if (!target) { tkSelectedId = null; tkDraw(); return; }

  tkSelectedId = target.dataset.id;
  const el = tkSelected();
  if (!el) return;

  const rect = document.getElementById('tkCanvas').getBoundingClientRect();
  tkDrag = {
    startX: e.clientX, startY: e.clientY,
    baseX: el.x, baseY: el.y,
    rect, moved: false,
  };
  target.setPointerCapture(e.pointerId);
  tkDraw();
  e.preventDefault();
});

document.getElementById('tkCanvas').addEventListener('pointermove', e => {
  if (!tkDrag) return;
  const el = tkSelected();
  if (!el) return;

  const dx = (e.clientX - tkDrag.startX) / tkDrag.rect.width  * 100;
  const dy = (e.clientY - tkDrag.startY) / tkDrag.rect.height * 100;
  if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) tkDrag.moved = true;

  el.x = Math.min(100, Math.max(0, Math.round((tkDrag.baseX + dx) * 10) / 10));
  el.y = Math.min(100, Math.max(0, Math.round((tkDrag.baseY + dy) * 10) / 10));

  const node = document.querySelector(`.tk-el[data-id="${el.id}"]`);
  if (node) node.style.cssText = tkElementStyle(el);
  e.preventDefault();
});

function tkEndDrag() {
  if (!tkDrag) return;
  if (tkDrag.moved) { tkDirty = true; renderTkPanel(); }
  tkDrag = null;
}

document.getElementById('tkCanvas').addEventListener('pointerup', tkEndDrag);
document.getElementById('tkCanvas').addEventListener('pointercancel', tkEndDrag);

/* ============================================================
   배경 이미지 · 비율
   ============================================================ */
document.getElementById('tkBgInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || !currentTicket) return;

  const form = new FormData();
  form.append('file', file);
  const btn = document.getElementById('tkBgBtn');
  btn.disabled = true; btn.textContent = '업로드 중...';
  try {
    // FormData sets its own multipart boundary — do not force Content-Type here.
    const res = await api('/api/admin/tickets/upload', { method: 'POST', body: form });
    if (!res.ok) {
      let detail = '업로드에 실패했습니다.';
      try { detail = (await res.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    const data = await res.json();
    currentTicket.bg_url = data.url;
    tkDirty = true;
    tkDraw();
    showToast('배경이 적용되었습니다. 저장을 눌러주세요.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '🖼 배경 이미지';
    e.target.value = '';
  }
});

function tkClearBg() {
  if (!currentTicket) return;
  currentTicket.bg_url = null;
  tkDirty = true;
  tkDraw();
}

function tkSetAspect(value) {
  if (!currentTicket) return;
  currentTicket.aspect = value;
  tkDirty = true;
  tkDraw();
}

/* ============================================================
   저장 · 공유
   ============================================================ */
function syncShareLink() {
  document.getElementById('tkShareLink').value =
    `${location.origin}/t/${currentTicket?.slug || ''}`;
}

function syncShareState() {
  const on = document.getElementById('tkPublished').checked;
  document.getElementById('tkShareBox').classList.toggle('disabled', !on);
  document.getElementById('tkShareHint').textContent = on
    ? '이 링크를 아는 사람은 누구나 티켓을 볼 수 있습니다.'
    : '공개로 바꾸고 저장하면 링크가 열립니다.';
}

document.getElementById('tkPublished').addEventListener('change', () => {
  tkDirty = true;
  syncShareState();
});

document.getElementById('tkTitle').addEventListener('input', () => { tkDirty = true; });
document.getElementById('tkMapUrl').addEventListener('input', () => { tkDirty = true; });

/* 입력하는 동안 소문자·하이픈으로 정리해준다 (서버 규칙과 동일). */
document.getElementById('tkSlug').addEventListener('input', e => {
  const cleaned = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-');
  if (cleaned !== e.target.value) e.target.value = cleaned;
  tkDirty = true;
});

async function saveTicket() {
  if (!currentTicket) return;
  const btn = document.getElementById('tkSaveBtn');
  btn.disabled = true; btn.textContent = '저장 중...';
  try {
    const saved = await apiJson(`/api/admin/tickets/${currentTicket.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        title: document.getElementById('tkTitle').value.trim() || currentTicket.title,
        slug: document.getElementById('tkSlug').value.trim() || currentTicket.slug,
        bg_url: currentTicket.bg_url,
        map_url: document.getElementById('tkMapUrl').value.trim() || null,
        aspect: currentTicket.aspect,
        elements: currentTicket.elements,
        is_published: document.getElementById('tkPublished').checked,
      }),
    });
    currentTicket = saved;
    currentTicket.elements = currentTicket.elements || [];
    document.getElementById('tkSlug').value = currentTicket.slug;
    tkDirty = false;
    syncShareLink();
    syncShareState();
    showToast('저장되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '저장';
  }
}

async function copyTicketLink() {
  const link = document.getElementById('tkShareLink').value;
  const btn = document.getElementById('tkCopyBtn');
  try {
    await navigator.clipboard.writeText(link);
    btn.textContent = '복사됨 ✓';
    setTimeout(() => { btn.textContent = '링크 복사'; }, 1500);
  } catch {
    showToast('클립보드 복사에 실패했습니다.', 'error');
  }
}

async function deleteTicket() {
  if (!currentTicket) return;
  if (!confirm(`[${currentTicket.title}] 티켓을 삭제하시겠습니까?`)) return;
  try {
    await apiJson(`/api/admin/tickets/${currentTicket.id}`, { method: 'DELETE' });
    showToast('삭제되었습니다.', 'success');
    loadTickets();
  } catch (e) {
    showToast(e.message, 'error');
  }
}


/* 열람·공유 집계 (참고용 — 봇 접속도 함께 잡힌다) */
function renderTicketStats() {
  const box = document.getElementById('tkStats');
  if (!box || !currentTicket) return;
  const rows = [
    ['👁', '열람', currentTicket.view_count ?? 0],
    ['↗', '공유', currentTicket.share_count ?? 0],
    ['🔗', '링크 복사', currentTicket.copy_count ?? 0],
  ];
  box.innerHTML = rows.map(([icon, label, n]) => `
    <div class="tk-stat">
      <div class="tk-stat-value">${icon} ${n.toLocaleString()}</div>
      <div class="tk-stat-label">${label}</div>
    </div>
  `).join('');
}

/* ============================================================
   스마트폰 미리보기
   저장하지 않은 편집 내용을 공개 페이지와 같은 CSS·같은 tkRender 로 그린다.
   따로 발행하지 않아도 실제 화면을 그대로 확인할 수 있다.
   ============================================================ */
const TK_DEVICES = [
  { w: 360, label: '작은 폰 (360px · 갤럭시 S 미니급)' },
  { w: 390, label: '기본 (390px · 아이폰 14/15)' },
  { w: 430, label: '큰 폰 (430px · 프로 맥스)' },
];
let tkPreviewWidth = 390;

function openTicketPreview() {
  if (!currentTicket) return;
  openOverlay('ticketPreviewOverlay');
  renderTicketPreview();
}

function closeTicketPreview() { closeOverlay('ticketPreviewOverlay'); }
bindOverlayClose('ticketPreviewOverlay', closeTicketPreview);

function setPreviewWidth(w) {
  tkPreviewWidth = w;
  renderTicketPreview();
}

function renderTicketPreview() {
  if (!currentTicket) return;

  document.getElementById('tkPreviewSizes').innerHTML = TK_DEVICES.map(d => `
    <button type="button" class="chip${d.w === tkPreviewWidth ? ' active' : ''}"
            onclick="setPreviewWidth(${d.w})">${d.w}px</button>
  `).join('');

  const phone = document.getElementById('tkPreviewPhone');
  phone.style.setProperty('--tkp-phone-w', `${tkPreviewWidth}px`);
  document.getElementById('tkPreviewLabel').textContent =
    TK_DEVICES.find(d => d.w === tkPreviewWidth)?.label || '';

  tkRender(document.getElementById('tkPreviewCanvas'), currentTicket);

  // 버튼 색도 실제와 같게 — 배경 이미지에서 뽑아 미리보기 안에만 적용한다.
  tkTintFrom(currentTicket.bg_url, document.getElementById('tkPreviewPage'));

  const mapUrl = document.getElementById('tkMapUrl').value.trim();
  document.getElementById('tkPreviewMap').style.display =
    /^https?:\/\//i.test(mapUrl) ? '' : 'none';
}


/* ============================================================
   티켓별 통계
   목록 API 가 이미 집계를 내려주므로 추가 호출이 없다.
   ============================================================ */
let tkSort = 'view';

const TK_SORTS = {
  view:   t => t.view_count  ?? 0,
  share:  t => t.share_count ?? 0,
  copy:   t => t.copy_count  ?? 0,
  recent: t => new Date(t.created_at).getTime(),
};

function showTicketStats() {
  document.getElementById('ticketListView').style.display = 'none';
  document.getElementById('ticketEditView').style.display = 'none';
  document.getElementById('ticketStatsView').style.display = '';
  renderTicketStatsList();
}

function setTicketSort(key) {
  tkSort = key;
  document.querySelectorAll('#ticketStatsView .chip[data-tksort]').forEach(c => {
    c.classList.toggle('active', c.dataset.tksort === key);
  });
  renderTicketStatsList();
}

function renderTicketStatsList() {
  const list = document.getElementById('ticketStatsList');

  const sum = key => allTickets.reduce((n, t) => n + (t[key] ?? 0), 0);
  document.getElementById('tkTotalViews').textContent  = sum('view_count').toLocaleString();
  document.getElementById('tkTotalShares').textContent = sum('share_count').toLocaleString();
  document.getElementById('tkTotalCopies').textContent = sum('copy_count').toLocaleString();
  document.getElementById('tkPublishedCount').textContent =
    allTickets.filter(t => t.is_published).length;

  if (allTickets.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">📊</span><div class="admin-empty-text">아직 만든 티켓이 없습니다.</div></div>';
    return;
  }

  const pick = TK_SORTS[tkSort] || TK_SORTS.view;
  const rows = allTickets.slice().sort((a, b) => pick(b) - pick(a));
  const max = Math.max(1, ...rows.map(t => t.view_count ?? 0));

  list.innerHTML = '<div class="entity-list">' + rows.map(t => {
    const views = t.view_count ?? 0;
    return `
      <div class="entity-item tk-stat-row" onclick="openTicketEditor(${t.id})">
        <div class="ticket-thumb tk-stat-thumb${t.bg_url ? '' : ' no-bg'}"
             style="${t.bg_url ? `background-image:url('${encodeURI(t.bg_url)}')` : ''}">
          ${t.bg_url ? '' : '🎫'}
        </div>
        <div class="entity-meta">
          <div class="entity-meta-top">
            <span class="entity-name">${escHtml(t.title)}</span>
            ${t.is_published
              ? '<span class="ticket-pub published">공개중</span>'
              : '<span class="ticket-pub draft">비공개</span>'}
          </div>
          <div class="room-row-meter" style="margin:8px 0 6px;">
            <div class="room-row-meter-fill r1" style="width:${(views / max) * 100}%"></div>
          </div>
          <div class="entity-meta-bottom">
            <span>👁 열람 ${views.toLocaleString()}</span>
            <span>↗ 공유 ${(t.share_count ?? 0).toLocaleString()}</span>
            <span>🔗 복사 ${(t.copy_count ?? 0).toLocaleString()}</span>
            <span>${fmtDateTime(t.created_at)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('') + '</div>';
}
