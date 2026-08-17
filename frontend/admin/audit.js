'use strict';

/* ============================================================
   감사 로그 — 관리자가 무엇을 바꿨는지 (system 전용)
   ============================================================ */
const AUDIT_META = {
  team:        { icon: '🎸', label: '팀' },
  member:      { icon: '🥁', label: '멤버' },
  dues:        { icon: '💰', label: '회비' },
  reservation: { icon: '📋', label: '예약' },
  ticket:      { icon: '🎫', label: '티켓' },
  blocked:     { icon: '🚫', label: '차단' },
  inquiry:     { icon: '📩', label: '문의' },
  account:     { icon: '👥', label: '계정' },
  settings:    { icon: '⚙️', label: '설정' },
  room:        { icon: '🏠', label: '공간' },
  auth:        { icon: '🔑', label: '인증' },
  audit:       { icon: '🧾', label: '감사' },
};

const AUDIT_VERB = {
  create: '등록', update: '수정', delete: '삭제',
  confirm: '확정', resolve: '처리', cleanup: '정리',
  login: '로그인', password_change: '비밀번호 변경',
};

let auditDays = 30;
let auditAction = '';

PAGE_LOADERS.audit = loadAudit;

async function loadAudit() {
  const list = document.getElementById('auditList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    const [rows, actions] = await Promise.all([
      apiJson(`/api/admin/audit?days=${auditDays}${auditAction ? `&action=${auditAction}` : ''}`),
      apiJson('/api/admin/audit/actions'),
    ]);
    renderAuditFilters(actions);
    renderAudit(rows);
  } catch (e) {
    list.innerHTML = `<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
  }
}

function setAuditDays(days) {
  auditDays = days;
  document.querySelectorAll('#auditPage .chip[data-adays]').forEach(c => {
    c.classList.toggle('active', Number(c.dataset.adays) === days);
  });
  loadAudit();
}

function setAuditAction(action) {
  auditAction = action;
  loadAudit();
}

function renderAuditFilters(actions) {
  document.getElementById('auditActions').innerHTML =
    `<button class="chip${auditAction ? '' : ' active'}" onclick="setAuditAction('')">전체</button>` +
    actions.map(a => {
      const meta = AUDIT_META[a] || { icon: '•', label: a };
      return `<button class="chip${auditAction === a ? ' active' : ''}"
                      onclick="setAuditAction('${a}')">${meta.icon} ${meta.label}</button>`;
    }).join('');
}

/* 'team.create' → { icon, label: '팀', verb: '등록' } */
function auditParts(action) {
  const [group, verb] = String(action).split('.');
  const meta = AUDIT_META[group] || { icon: '•', label: group };
  return { ...meta, verb: AUDIT_VERB[verb] || verb || '' };
}

function fmtAuditTime(iso) {
  // 서버는 UTC 로 기록한다. 표시할 때 로컬 시각으로 돌린다.
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderAudit(rows) {
  const list = document.getElementById('auditList');
  document.getElementById('auditCount').textContent =
    `최근 ${auditDays}일 · ${rows.length}건 (조회는 기록하지 않습니다)`;

  if (rows.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">🧾</span><div class="admin-empty-text">기록된 변경이 없습니다.</div></div>';
    return;
  }

  let html = '<div class="audit-list">';
  let lastDay = '';
  rows.forEach(r => {
    const d = new Date(r.at.endsWith('Z') ? r.at : r.at + 'Z');
    const day = toDateStr(d);
    if (day !== lastDay) {
      lastDay = day;
      html += `<div class="date-group-header">📅 ${fmtDateKo(day)}</div>`;
    }
    const p = auditParts(r.action);
    html += `
      <div class="audit-item">
        <span class="audit-icon">${p.icon}</span>
        <div class="audit-body">
          <div class="audit-head">
            <span class="audit-action">${escHtml(p.label)} ${escHtml(p.verb)}</span>
            ${r.target ? `<span class="audit-target">${escHtml(r.target)}</span>` : ''}
          </div>
          ${r.detail ? `<div class="audit-detail">${escHtml(r.detail)}</div>` : ''}
        </div>
        <div class="audit-meta">
          <div class="audit-time">${fmtAuditTime(r.at)}</div>
          <div class="audit-user">${escHtml(r.username || '—')}</div>
        </div>
      </div>`;
  });
  html += '</div>';
  list.innerHTML = html;
}
