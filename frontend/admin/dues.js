'use strict';

/* ============================================================
   정산 관리 — 월회비 수납 현황
   ============================================================ */
const DUES_STATUS = {
  paid:    { label: '납부',   cls: 'paid'    },
  unpaid:  { label: '미납',   cls: 'unpaid'  },
  pending: { label: '확인중', cls: 'pending' },
  exempt:  { label: '면제',   cls: 'exempt'  },
};

let duesCursor = new Date();   // 어느 달을 보고 있는지
let duesData   = null;

PAGE_LOADERS.dues = loadDues;

async function loadDues() {
  const list = document.getElementById('duesList');
  list.innerHTML = '<div class="spinner"></div>';
  const ym = ymStr(duesCursor);
  document.getElementById('duesTitle').textContent =
    `${duesCursor.getFullYear()}년 ${duesCursor.getMonth() + 1}월`;

  try {
    duesData = await apiJson(`/api/admin/dues?year_month=${ym}`);
  } catch (e) {
    duesData = null;
    list.innerHTML = `<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
    return;
  }
  renderDues();
  loadDuesSummary(duesCursor.getFullYear());
}

function duesPrevMonth() { duesCursor.setMonth(duesCursor.getMonth() - 1); loadDues(); }
function duesNextMonth() { duesCursor.setMonth(duesCursor.getMonth() + 1); loadDues(); }
function duesThisMonth() { duesCursor = new Date(); loadDues(); }

function renderDues() {
  const list = document.getElementById('duesList');
  const d = duesData;

  document.getElementById('duesPaid').textContent    = d.total_paid.toLocaleString();
  document.getElementById('duesExpected').textContent = d.total_expected.toLocaleString();
  document.getElementById('duesUnpaid').textContent  = d.unpaid_count;
  document.getElementById('duesPending').textContent = d.pending_count;

  const pct = d.total_expected ? Math.round(d.total_paid / d.total_expected * 100) : 0;
  document.getElementById('duesProgressFill').style.width = `${Math.min(100, pct)}%`;
  document.getElementById('duesProgressText').textContent = `수납률 ${pct}%`;

  if (d.rows.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">💸</span><div class="admin-empty-text">활동 중인 멤버가 없습니다. 멤버 관리에서 먼저 등록해주세요.</div></div>';
    return;
  }

  list.innerHTML = '<div class="dues-list">' + d.rows.map(r => `
    <div class="dues-row status-${r.covered_by_team ? 'covered' : r.status}">
      <div class="dues-member">
        <div class="dues-name">
          ${escHtml(r.name)}
          <span class="dues-team">${r.team_name ? escHtml(r.team_name) : '무소속'}</span>
        </div>
        <div class="dues-sub">
          ${r.parts ? escHtml(r.parts.split(',').join(' · ')) : '파트 미지정'}
          · ${r.covered_by_team ? '팀 월 이용료에 포함'
              : (r.status === 'exempt' ? '면제' : r.fee.toLocaleString() + '원')}
        </div>
      </div>
      ${r.covered_by_team
        ? '<span class="fee-badge monthly">팀 납부</span>'
        : `<div class="dues-chips">
            ${Object.entries(DUES_STATUS).map(([key, meta]) => `
              <button class="dues-chip ${meta.cls}${r.status === key ? ' active' : ''}"
                      onclick="setDuesStatus(${r.member_id}, '${key}')">${meta.label}</button>
            `).join('')}
          </div>`}
    </div>
  `).join('') + '</div>';
}

async function setDuesStatus(memberId, status) {
  const row = duesData?.rows.find(r => r.member_id === memberId);
  if (!row || row.status === status) return;

  try {
    await apiJson(`/api/admin/dues/${memberId}/${ymStr(duesCursor)}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    await loadDues();
    showToast(`${row.name} · ${DUES_STATUS[status].label} 처리`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function loadDuesSummary(year) {
  const chart = document.getElementById('duesYearChart');
  document.getElementById('duesYearLabel').textContent = `${year}년 월별 수납`;
  try {
    const rows = await apiJson(`/api/admin/dues/summary?year=${year}`);
    const max = Math.max(1, ...rows.map(r => r.paid));
    chart.innerHTML = rows.map((r, i) => {
      const pct = (r.paid / max) * 100;
      return `
        <div class="bar-col">
          <div class="bar-value">${r.paid > 0 ? (r.paid / 10000).toFixed(0) + '만' : ''}</div>
          <div class="bar-track">
            <div class="bar-fill" style="height:${pct}%"></div>
          </div>
          <div class="bar-label">${i + 1}</div>
        </div>
      `;
    }).join('');
  } catch {
    chart.innerHTML = '';
  }
}
