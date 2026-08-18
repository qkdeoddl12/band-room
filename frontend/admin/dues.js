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
let duesSummaryYear = null;    // 연간 차트는 해가 바뀔 때만 다시 받는다

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
  // 월을 넘겨도 연간 합계는 그대로다 — 해가 바뀔 때만 다시 받는다.
  const year = duesCursor.getFullYear();
  if (year !== duesSummaryYear) {
    duesSummaryYear = year;
    loadDuesSummary(year);
  }
}

function duesPrevMonth() { duesCursor.setMonth(duesCursor.getMonth() - 1); loadDues(); }
function duesNextMonth() { duesCursor.setMonth(duesCursor.getMonth() + 1); loadDues(); }
function duesThisMonth() { duesCursor = new Date(); loadDues(); }

function renderDues() {
  const list = document.getElementById('duesList');
  const d = duesData;

  // 도어즈 멤버 월회비와 팀 월 이용료는 성격이 다른 수입이다 — 합치지 않는다.
  const teamRows   = d.team_rows || [];
  const teamPaid   = d.team_total_paid || 0;
  const teamExpect = d.team_total_expected || 0;
  const teamUnpaid = teamRows.filter(r => r.status === 'unpaid').length;

  document.getElementById('duesPaid').textContent         = d.total_paid.toLocaleString();
  document.getElementById('duesExpected').textContent     = d.total_expected.toLocaleString();
  document.getElementById('duesTeamPaid').textContent     = teamPaid.toLocaleString();
  document.getElementById('duesTeamExpected').textContent = teamExpect.toLocaleString();
  document.getElementById('duesUnpaid').textContent       = d.unpaid_count;
  document.getElementById('duesPending').textContent      = d.pending_count;
  document.getElementById('duesUnpaidSub').textContent =
    teamUnpaid ? `+ 미납 ${teamUnpaid}팀` : '입금 확인 필요';

  if (d.rows.length === 0 && teamRows.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">💸</span><div class="admin-empty-text">활동 중인 멤버가 없습니다. 멤버 관리에서 먼저 등록해주세요.</div></div>';
    return;
  }

  list.innerHTML = duesSectionHead(
      '월회비 (도어즈 멤버)', `${d.rows.length}명`, d.total_paid, d.total_expected)
    + '<div class="dues-list">' + d.rows.map(r => `
    <div class="dues-row status-${r.covered_by_team ? 'covered' : r.status}">
      <div class="dues-member">
        <div class="dues-name">
          ${escHtml(r.name)}
          <span class="dues-team">${r.team_name ? escHtml(r.team_name) : '무소속'}</span>
        </div>
        <div class="dues-sub">
          ${r.parts ? escHtml(splitParts(r.parts).join(' · ')) : '포지션 미지정'}
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
  `).join('') + '</div>' + renderTeamDues(d);
}

/* 두 정산의 소제목 + 수납률 막대. 같은 모양을 두 번 쓰므로 하나로 뽑았다. */
function duesSectionHead(title, count, paid, expected, teal = false) {
  const pct = expected ? Math.round(paid / expected * 100) : 0;
  return `
    <div class="dues-section-head">${title}<span>${count}</span></div>
    <div class="dues-progress">
      <div class="dues-progress-track">
        <div class="dues-progress-fill${teal ? ' team' : ''}" style="width:${Math.min(100, pct)}%"></div>
      </div>
      <div class="dues-progress-text">
        ${paid.toLocaleString()}원 / 예상 ${expected.toLocaleString()}원 · 수납률 ${pct}%
      </div>
    </div>`;
}

/* 월 이용료 팀은 사람이 아니라 팀이 낸다 — 멤버 목록과 갈라 놓는다. */
function renderTeamDues(d) {
  const rows = d.team_rows || [];
  if (!rows.length) return '';
  return `
    <div class="dues-section">
      ${duesSectionHead('월 이용료 (팀)', `${rows.length}팀`,
                        d.team_total_paid, d.team_total_expected, true)}
      <div class="dues-list">
        ${rows.map(r => `
          <div class="dues-row status-${r.status}">
            <div class="dues-member">
              <div class="dues-name">${escHtml(r.name)}
                <span class="dues-team">멤버 ${r.member_count}명</span>
              </div>
              <div class="dues-sub">
                ${r.fee.toLocaleString()}원
                ${r.paid_on ? ` · ${r.paid_on} 입금` : ''}
              </div>
            </div>
            <div class="dues-chips">
              ${Object.entries(DUES_STATUS).map(([key, meta]) => `
                <button class="dues-chip ${meta.cls}${r.status === key ? ' active' : ''}"
                        onclick="setTeamDuesStatus(${r.team_id}, '${key}')">${meta.label}</button>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;
}

async function setTeamDuesStatus(teamId, status) {
  const row = duesData?.team_rows?.find(r => r.team_id === teamId);
  if (!row || row.status === status) return;
  try {
    await apiJson(`/api/admin/dues/team/${teamId}/${ymStr(duesCursor)}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    await loadDues();
    showToast(`${row.name} · ${DUES_STATUS[status].label} 처리`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
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
    const total = r => r.paid + (r.team_paid || 0);
    if (!rows.some(total)) {
      chart.innerHTML = '<div class="chart-empty">올해 수납 기록이 없습니다.</div>';
      return;
    }
    // 위 칸이 월회비, 아래 칸이 팀 이용료. 합계는 기둥 전체 높이.
    const max = Math.max(1, ...rows.map(total));
    chart.innerHTML = rows.map((r, i) => {
      const sum = total(r);
      const peak = sum === max && sum > 0;
      return `
        <div class="stack-col" title="${i + 1}월 · 월회비 ${r.paid.toLocaleString()}원 · 월 이용료 ${(r.team_paid || 0).toLocaleString()}원">
          <div class="stack-value">${peak ? (sum / 10000).toFixed(0) + '만' : ''}</div>
          <div class="stack-track">
            <div class="stack-fill" style="height:${(sum / max) * 100}%">
              <div class="stack-r1" style="height:${sum ? (r.paid / sum) * 100 : 0}%"></div>
            </div>
          </div>
          <div class="stack-label">${i + 1}</div>
        </div>
      `;
    }).join('');
  } catch {
    chart.innerHTML = '';
  }
}
