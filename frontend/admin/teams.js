'use strict';

/* ============================================================
   팀 관리 — 예약할 수 있는 팀 명부 + 월회비 납부 현황
   ============================================================ */
let allTeams = [];
let teamSearch = '';
let editTeamId = null;          // null = 신규 등록
let detailTeamId = null;        // 상세 보고 있는 팀
let detailCursor = new Date();  // 상세에서 보고 있는 달
let detailMembers = [];         // 팀에 붙일 수 있는 후보 (활동 중인 전체 멤버)

PAGE_LOADERS.teams = loadTeams;

async function loadTeams() {
  const list = document.getElementById('teamList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    allTeams = await apiJson('/api/admin/teams');
    cacheTeams(allTeams);          // 같은 응답을 캐시로도 쓴다
  } catch (e) {
    allTeams = [];
    list.innerHTML = `<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
    return;
  }
  renderTeams();
}

function filterTeams() {
  teamSearch = document.getElementById('teamSearch').value.trim().toLowerCase();
  renderTeams();
}

/* 금액을 따로 안 정했으면 환경 설정의 기본값을 보여준다. */
/* 이 팀의 1인 회비와 그 출처.
   dues_fee 는 입력칸이 없어 값이 있어도 화면에서 안 보이던 값이라
   배지와 팀 상세에서 같은 함수로 꺼내 쓴다. */
function teamDuesFee(t) {
  return t.dues_fee != null
    ? { fee: t.dues_fee, own: true }
    : { fee: settingNum('default_monthly_fee'), own: false };
}

function teamBillingBadge(t) {
  const meta = BILLING[t.billing_type] || BILLING.hourly;
  let amount = '';
  if (t.billing_type === 'monthly') {
    const fee = t.monthly_fee ?? settingNum('default_team_fee');
    if (fee) amount = ` ${fee.toLocaleString()}원`;
  }
  if (t.billing_type === 'dues') {
    const { fee } = teamDuesFee(t);
    if (fee) amount = ` 1인 ${fee.toLocaleString()}원`;
  }
  return `<span class="fee-badge ${meta.cls}">${meta.label}${amount}</span>`;
}

function renderTeams() {
  const list = document.getElementById('teamList');
  const items = allTeams.filter(t => {
    if (!teamSearch) return true;
    return `${t.name} ${t.leader_name || ''} ${t.phone || ''}`.toLowerCase().includes(teamSearch);
  });

  document.getElementById('teamCount').textContent =
    `${allTeams.filter(t => t.is_active).length}팀 활성 · 전체 ${allTeams.length}팀`;

  if (items.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">🎸</span><div class="admin-empty-text">등록된 팀이 없습니다.</div></div>';
    return;
  }

  // 멤버 목록과 같은 카드. 카드를 누르면 상세, 오른쪽 아래 버튼은 수정.
  list.innerHTML = '<div class="entity-cards">' + items.map(t => {
    const contact = [
      t.leader_name ? escHtml(t.leader_name) : '',
      t.phone ? escHtml(formatPhone(t.phone)) : '',
    ].filter(Boolean).join(' · ') || '담당자 미지정';
    const counts = [
      t.billing_type === 'dues' ? `멤버 ${t.member_count}명` : '',
      `예약 ${t.reservation_count}건`,
    ].filter(Boolean).join(' · ');

    return `
      <div class="ecard${t.is_active ? '' : ' inactive'}" onclick="openTeamDetail(${t.id})">
        <div class="ecard-top">
          <span class="ecard-name">${escHtml(t.name)}</span>
          ${t.is_active ? '' : '<span class="mt-badge off">비활성</span>'}
          <span class="ecard-fee">${teamBillingBadge(t)}</span>
        </div>
        <div class="ecard-sub">${contact}
          <span class="ecard-parts">${escHtml(splitParts(t.parts).join(' · ') || '포지션 미지정')}</span>
        </div>
        <div class="ecard-meta">
          <span>${counts}</span>
          <button class="ecard-edit" onclick="event.stopPropagation(); openTeamModal(${t.id})">수정</button>
        </div>
      </div>`;
  }).join('') + '</div>';
}

/* ============================================================
   팀 등록 / 수정
   ============================================================ */
function openTeamModal(teamId = null) {
  editTeamId = teamId;
  const t = teamId ? allTeams.find(x => x.id === teamId) : null;

  document.getElementById('teamModalTitle').textContent = t ? '팀 수정' : '팀 등록';
  document.getElementById('teamName').value       = t?.name || '';
  document.getElementById('teamLeader').value     = t?.leader_name || '';
  document.getElementById('teamPhone').value      = formatPhone(t?.phone);
  document.getElementById('teamMemo').value       = t?.memo || '';
  renderPartPicker('teamParts', 'teamPartsOther', t?.parts);
  document.getElementById('teamActive').checked   = t ? t.is_active : true;

  const billing = t?.billing_type || 'hourly';
  document.querySelectorAll('input[name="teamBilling"]').forEach(r => {
    r.checked = r.value === billing;
  });
  // 새 팀이면 환경 설정의 기본 금액을 미리 채워둔다.
  document.getElementById('teamFee').value =
    t ? (t.monthly_fee ?? '') : (settingNum('default_team_fee') || '');
  syncTeamBilling();

  document.getElementById('teamDeleteBtn').style.display = t ? '' : 'none';
  document.getElementById('teamSaveBtn').textContent = t ? '변경 저장' : '팀 등록';
  // 팀 단위 입금은 월 이용료 팀만 있다. 나머지는 멤버별로 낸다.
  renderDuesHistory('teamHistory',
    t && t.billing_type === 'monthly' ? `/api/admin/dues/history/team/${t.id}` : null);

  openOverlay('teamOverlay');
}

function closeTeamModal() {
  closeOverlay('teamOverlay');
  editTeamId = null;
}

bindOverlayClose('teamOverlay', closeTeamModal);

function selectedBilling() {
  return document.querySelector('input[name="teamBilling"]:checked')?.value || 'hourly';
}

/* 고른 과금 방식에 해당하는 금액 칸만 보여준다. */
function syncTeamBilling() {
  const billing = selectedBilling();
  document.getElementById('teamMonthlyFeeRow').style.display = billing === 'monthly' ? '' : 'none';
  document.getElementById('teamDuesFeeRow').style.display    = billing === 'dues'    ? '' : 'none';
  document.querySelectorAll('input[name="teamBilling"]').forEach(input => {
    input.closest('.role-option').classList.toggle('active', input.checked);
  });
}

document.querySelectorAll('input[name="teamBilling"]').forEach(input => {
  input.addEventListener('change', syncTeamBilling);
});

document.getElementById('teamForm').addEventListener('submit', async e => {
  e.preventDefault();
  const billing = selectedBilling();
  const feeRaw  = document.getElementById('teamFee').value.trim();

  const body = {
    name:         document.getElementById('teamName').value.trim(),
    leader_name:  document.getElementById('teamLeader').value.trim(),
    phone:        document.getElementById('teamPhone').value.trim(),
    parts:        readPartPicker('teamParts', 'teamPartsOther'),
    memo:         document.getElementById('teamMemo').value.trim(),
    billing_type: billing,
    monthly_fee:  billing === 'monthly' ? Number(feeRaw || 0)  : null,
    dues_fee:     null,   // 팀별 회비는 쓰지 않는다 — 환경 설정 기본값 + 멤버별 금액으로 충분
    is_active:    document.getElementById('teamActive').checked,
  };
  if (!body.name) { showToast('팀 이름을 입력해주세요.', 'error'); return; }
  if (body.monthly_fee !== null && (isNaN(body.monthly_fee) || body.monthly_fee < 0)) {
    showToast('월 이용료는 0 이상의 숫자여야 합니다.', 'error');
    return;
  }

  const btn = document.getElementById('teamSaveBtn');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = '저장 중...';
  try {
    if (editTeamId) {
      await apiJson(`/api/admin/teams/${editTeamId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiJson('/api/admin/teams', { method: 'POST', body: JSON.stringify(body) });
    }
    closeTeamModal();
    await loadTeams();
    showToast('저장되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
});

async function deleteCurrentTeam() {
  if (!editTeamId) return;
  const t = allTeams.find(x => x.id === editTeamId);
  if (!t) return;
  if (!confirm(`[${t.name}] 팀을 삭제하시겠습니까?`)) return;
  try {
    await apiJson(`/api/admin/teams/${editTeamId}`, { method: 'DELETE' });
    closeTeamModal();
    await loadTeams();
    showToast('삭제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

attachPhoneMask(document.getElementById('teamPhone'));

/* ============================================================
   팀 상세 — 소속 멤버 + 이번 달 납부 현황
   ============================================================ */
function openTeamDetail(teamId) {
  detailTeamId = teamId;
  detailCursor = new Date();
  openOverlay('teamDetailOverlay');
  renderTeamDetail();
}

function closeTeamDetail() {
  closeOverlay('teamDetailOverlay');
  detailTeamId = null;
}

bindOverlayClose('teamDetailOverlay', closeTeamDetail);

function teamDetailPrevMonth() { detailCursor.setMonth(detailCursor.getMonth() - 1); renderTeamDetail(); }
function teamDetailNextMonth() { detailCursor.setMonth(detailCursor.getMonth() + 1); renderTeamDetail(); }

/* 월회비 팀의 1인 회비를 읽기 전용으로 보여준다.
   팀에만 지정된 금액은 어디서도 볼 수 없던 값이라 출처를 함께 적는다. */
function teamDuesNote(team) {
  if (team.billing_type !== 'dues') return '';
  const { fee, own } = teamDuesFee(team);
  const base = settingNum('default_monthly_fee');
  return `
    <div class="team-fee-note${own ? ' own' : ''}">
      <div class="team-fee-line">
        <span>1인 회비</span>
        <b>${fee.toLocaleString()}원</b>
        <span class="team-fee-src">${own ? '이 팀에 지정됨' : '환경 설정 기본값'}</span>
      </div>
      ${own ? `<div class="team-fee-hint">
        기본값 ${base.toLocaleString()}원 대신 이 팀에만 적용됩니다.
        화면에서 바꿀 수 없고, 과금 방식을 다른 것으로 바꾸면 사라집니다.
        멤버별로 다르게 받으려면 멤버 수정에서 금액을 지정하세요.
      </div>` : ''}
    </div>`;
}

async function renderTeamDetail() {
  const team = allTeams.find(t => t.id === detailTeamId);
  const body = document.getElementById('teamDetailBody');
  if (!team) { body.innerHTML = ''; return; }

  document.getElementById('teamDetailTitle').textContent = team.name;

  const head = `
    ${team.parts ? `<div class="part-tags" style="margin-bottom:10px;">${partTagsHtml(team.parts)}</div>` : ''}
    <div class="team-detail-head">
      ${teamBillingBadge(team)}
      ${team.leader_name ? `<span>👤 ${escHtml(team.leader_name)}</span>` : ''}
      ${team.phone ? `<span>📞 ${escHtml(formatPhone(team.phone))}</span>` : ''}
      <span>📋 예약 ${team.reservation_count}건</span>
    </div>
    ${teamDuesNote(team)}
    ${team.memo ? `<div class="team-detail-memo">${escHtml(team.memo)}</div>` : ''}
  `;
  body.innerHTML = head + '<div class="spinner"></div>';

  const isDues = team.billing_type === 'dues';
  const ym = ymStr(detailCursor);

  let roster, dues = null;
  try {
    // 전체 명단 하나만 받아 이 팀 소속을 걸러 쓴다 (같은 데이터를 두 번 받지 않게)
    [detailMembers, dues] = await Promise.all([
      apiJson('/api/admin/members?active=true'),
      isDues ? apiJson(`/api/admin/dues?year_month=${ym}&team_id=${team.id}`) : Promise.resolve(null),
    ]);
    roster = detailMembers.filter(m => m.team_id === team.id);
  } catch (e) {
    body.innerHTML = head + `<div class="admin-empty"><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
    return;
  }

  // 월회비 팀만 달을 넘겨가며 납부를 본다.
  const monthNav = isDues ? `
    <div class="team-month-nav">
      <button class="btn-nav" onclick="teamDetailPrevMonth()" aria-label="이전 달">&#8249;</button>
      <span class="team-month-label">${detailCursor.getFullYear()}년 ${detailCursor.getMonth() + 1}월</span>
      <button class="btn-nav" onclick="teamDetailNextMonth()" aria-label="다음 달">&#8250;</button>
    </div>` : '';

  let summary = '';
  if (isDues && roster.length) {
    const done = dues.unpaid_count === 0 && dues.pending_count === 0;
    summary = `
      <div class="team-dues-summary${done ? ' done' : ''}">
        ${done
          ? `✅ ${dues.rows.length}명 전원 납부 완료`
          : `미납 ${dues.unpaid_count}명${dues.pending_count ? ` · 확인중 ${dues.pending_count}명` : ''} / 전체 ${dues.rows.length}명`}
        <span class="team-dues-amount">${dues.total_paid.toLocaleString()} / ${dues.total_expected.toLocaleString()}원</span>
      </div>`;
  }

  const duesByMember = {};
  (dues?.rows || []).forEach(r => { duesByMember[r.member_id] = r; });

  const rows = roster.length ? roster.map(m => {
    const d = duesByMember[m.id];
    const chips = isDues && d && !d.covered_by_team ? `
      <div class="dues-chips">
        ${Object.entries(DUES_STATUS).map(([key, meta]) => `
          <button class="dues-chip ${meta.cls}${d.status === key ? ' active' : ''}"
                  onclick="setTeamDuesStatus(${m.id}, '${key}')">${meta.label}</button>
        `).join('')}
      </div>` : '';
    return `
      <div class="dues-row${isDues && d ? ` status-${d.covered_by_team ? 'covered' : d.status}` : ''}">
        <div class="dues-member">
          <div class="dues-name">
            ${escHtml(m.name)}
            ${m.is_doors ? '<span class="doors-badge">도어즈</span>' : ''}
          </div>
          <div class="dues-sub">
            ${m.parts ? escHtml(splitParts(m.parts).join(' · ')) : '포지션 미지정'}
            ${m.phone ? ` · <a href="tel:${escHtml(String(m.phone).replace(/[^\d+]/g, ''))}">${escHtml(formatPhone(m.phone))}</a>` : ' · 연락처 없음'}
          </div>
        </div>
        ${chips || `<button class="btn-edit-user" onclick="editTeamMember(${m.id})">수정</button>`}
      </div>`;
  }).join('') : `<div class="admin-empty"><span class="admin-empty-icon">🥁</span><div class="admin-empty-text">등록된 멤버가 없습니다.<br>아래에서 추가할 수 있습니다.</div></div>`;

  body.innerHTML = head + monthNav + summary +
    `<div class="team-roster-label">멤버 ${roster.length}명</div>` +
    `<div class="dues-list">${rows}</div>` +
    renderAddMemberBox();
}

/* 팀 상세에서 바로 멤버 정보를 고친다. 저장하면 팀 상세로 돌아온다. */
async function editTeamMember(memberId) {
  const teamId = detailTeamId;
  try {
    allMembers = await apiJson('/api/admin/members');
  } catch (e) { showToast(e.message, 'error'); return; }
  closeTeamDetail();
  openMemberModal(memberId, teamId);
}

/* 이미 이 팀 소속인 사람은 후보에서 뺀다. */
function renderAddMemberBox() {
  const candidates = detailMembers.filter(m => m.team_id !== detailTeamId);
  const options = candidates.map(m =>
    `<option value="${m.id}">${escHtml(m.name)}${m.team_name ? ` (현재: ${escHtml(m.team_name)})` : ' (무소속)'}</option>`
  ).join('');

  return `
    <div class="team-add-member">
      <div class="team-add-title">멤버 추가</div>
      ${candidates.length ? `
        <div class="team-add-row">
          <select class="form-select" id="teamAddMemberSelect">
            <option value="">기존 멤버 선택…</option>
            ${options}
          </select>
          <button type="button" class="btn-primary" onclick="addMemberToTeam()">추가</button>
        </div>
      ` : '<div class="team-add-empty">추가할 수 있는 다른 멤버가 없습니다.</div>'}
      <button type="button" class="link-inline" onclick="newMemberForTeam()">+ 새 멤버로 등록 →</button>
    </div>
  `;
}

async function addMemberToTeam() {
  const select = document.getElementById('teamAddMemberSelect');
  const memberId = Number(select.value);
  if (!memberId) { showToast('추가할 멤버를 선택해주세요.', 'error'); return; }

  const member = detailMembers.find(m => m.id === memberId);
  if (member?.team_name && !confirm(
    `${member.name} 님은 현재 [${member.team_name}] 소속입니다.\n이 팀으로 옮기시겠습니까?`
  )) return;

  try {
    await apiJson(`/api/admin/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify({ team_id: detailTeamId }),
    });
    await loadTeams();
    await renderTeamDetail();
    showToast(`${member?.name || '멤버'} 추가됨`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* 새 멤버를 만들면서 이 팀으로 바로 넣는다. 저장 후 팀 상세로 돌아온다. */
function newMemberForTeam() {
  const teamId = detailTeamId;
  closeTeamDetail();
  openMemberModal(null, teamId);
}

async function setTeamDuesStatus(memberId, status) {
  try {
    await apiJson(`/api/admin/dues/${memberId}/${ymStr(detailCursor)}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    await renderTeamDetail();
  } catch (e) {
    showToast(e.message, 'error');
  }
}
