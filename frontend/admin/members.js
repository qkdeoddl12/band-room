'use strict';

/* ============================================================
   멤버 관리 — 도어즈 멤버 명부
   ============================================================ */
let allMembers    = [];
let memberSearch  = '';
let memberTeamFil = '';
let editMemberId  = null;
let returnToTeamId = null;   // 팀 상세에서 넘어온 경우 저장 후 그리로 돌아간다

PAGE_LOADERS.members = loadMembers;

async function loadMembers() {
  const list = document.getElementById('memberList');
  list.innerHTML = '<div class="spinner"></div>';
  renderTeamOptions();
  try {
    allMembers = await apiJson('/api/admin/members');
  } catch (e) {
    allMembers = [];
    list.innerHTML = `<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
    return;
  }
  renderMembers();
}

function filterMembers() {
  memberSearch  = document.getElementById('memberSearch').value.trim().toLowerCase();
  memberTeamFil = document.getElementById('memberTeamFilter').value;
  renderMembers();
}

/* 팀 목록은 core 의 teamsById 캐시를 쓴다 (팀 관리에서 갱신됨). */
function teamOptionsHtml(selected, firstLabel) {
  const teams = Object.values(teamsById).sort((a, b) => a.name.localeCompare(b.name));
  return `<option value="">${firstLabel}</option>` + teams.map(t =>
    `<option value="${t.id}"${String(selected) === String(t.id) ? ' selected' : ''}>${escHtml(t.name)}</option>`
  ).join('');
}

function renderTeamOptions() {
  const filter = document.getElementById('memberTeamFilter');
  filter.innerHTML = teamOptionsHtml(memberTeamFil, '전체 팀') +
    `<option value="none"${memberTeamFil === 'none' ? ' selected' : ''}>무소속</option>`;
}

const GENDER_KO = { male: '남', female: '여' };

/* "1995년생 · 남" 형태. 둘 다 없으면 빈 문자열. */
function memberProfile(m) {
  const bits = [];
  if (m.birth_year) bits.push(`${m.birth_year}년생`);
  if (m.gender && GENDER_KO[m.gender]) bits.push(GENDER_KO[m.gender]);
  return bits.join(' · ');
}

function feeBadge(m) {
  const team = teamsById[m.team_id];
  if (team && team.billing_type === 'monthly') {
    return '<span class="fee-badge monthly">팀 납부</span>';
  }
  if (m.dues_exempt) return '<span class="fee-badge exempt">회비 면제</span>';
  if (m.monthly_fee !== null && m.monthly_fee !== undefined) {
    return `<span class="fee-badge">${m.monthly_fee.toLocaleString()}원</span>`;
  }
  // 개인 금액이 없으면 팀 기본 회비, 그것도 없으면 전체 기본값을 따른다.
  if (team && team.dues_fee != null) {
    return `<span class="fee-badge dues">팀 기본 ${team.dues_fee.toLocaleString()}원</span>`;
  }
  return '<span class="fee-badge default">기본 회비</span>';
}

function renderMembers() {
  const list = document.getElementById('memberList');
  const items = allMembers.filter(m => {
    if (memberTeamFil === 'none' && m.team_id) return false;
    if (memberTeamFil && memberTeamFil !== 'none' && String(m.team_id) !== memberTeamFil) return false;
    if (!memberSearch) return true;
    return `${m.name} ${m.parts || ''} ${m.phone || ''}`.toLowerCase().includes(memberSearch);
  });

  const active = allMembers.filter(m => m.is_active).length;
  const doors  = allMembers.filter(m => m.is_active && m.is_doors).length;
  document.getElementById('memberCount').textContent =
    `활동 ${active}명 (도어즈 ${doors}명) · 전체 ${allMembers.length}명`;

  if (items.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">🥁</span><div class="admin-empty-text">등록된 멤버가 없습니다.</div></div>';
    return;
  }

  list.innerHTML = '<div class="entity-list">' + items.map(m => `
    <div class="entity-item${m.is_active ? '' : ' inactive'}">
      <div class="entity-avatar member">${escHtml(m.name.charAt(0))}</div>
      <div class="entity-meta">
        <div class="entity-meta-top">
          <span class="entity-name">${escHtml(m.name)}</span>
          ${m.is_active ? '' : '<span class="user-inactive-tag">비활동</span>'}
          ${m.is_doors ? '<span class="doors-badge">도어즈</span>' : ''}
          ${feeBadge(m)}
        </div>
        <div class="part-tags">${partTagsHtml(m.parts)}</div>
        <div class="entity-meta-bottom">
          <span>🎸 ${m.team_name ? escHtml(m.team_name) : '무소속'}</span>
          ${memberProfile(m) ? `<span>🎂 ${escHtml(memberProfile(m))}</span>` : ''}
          ${m.phone ? `<span>📞 ${escHtml(formatPhone(m.phone))}</span>` : ''}
          ${m.joined_on ? `<span>📅 ${escHtml(m.joined_on)} 가입</span>` : ''}
        </div>
      </div>
      <button class="btn-edit-user" onclick="openMemberModal(${m.id})">수정</button>
    </div>
  `).join('') + '</div>';
}

function openMemberModal(memberId = null, presetTeamId = null) {
  editMemberId = memberId;
  returnToTeamId = presetTeamId;
  const m = memberId ? allMembers.find(x => x.id === memberId) : null;

  document.getElementById('memberModalTitle').textContent = m ? '멤버 수정' : '멤버 등록';
  document.getElementById('memberName').value    = m?.name || '';
  document.getElementById('memberTeam').innerHTML =
    teamOptionsHtml(m?.team_id ?? presetTeamId ?? '', '무소속');
  document.getElementById('memberDoors').checked  = m ? m.is_doors : true;
  document.getElementById('memberPhone').value   = formatPhone(m?.phone);
  document.getElementById('memberGender').value  = m?.gender || '';
  document.getElementById('memberBirthYear').value = m?.birth_year || '';
  document.getElementById('memberJoined').value  = m?.joined_on || '';
  document.getElementById('memberMemo').value    = m?.memo || '';
  document.getElementById('memberActive').checked = m ? m.is_active : true;
  document.getElementById('memberExempt').checked = m ? m.dues_exempt : false;
  document.getElementById('memberFee').value = (m && m.monthly_fee !== null && m.monthly_fee !== undefined)
    ? m.monthly_fee : '';
  renderPartPicker('memberParts', 'memberPartsOther', m?.parts);
  syncMemberFeeState();

  document.getElementById('memberDeleteBtn').style.display = m ? '' : 'none';
  document.getElementById('memberSaveBtn').textContent = m ? '변경 저장' : '멤버 등록';

  openOverlay('memberOverlay');
}

function closeMemberModal() {
  closeOverlay('memberOverlay');
  editMemberId = null;
  returnToTeamId = null;
}

bindOverlayClose('memberOverlay', closeMemberModal);

/* 면제 회원은 금액 입력이 의미 없으므로 비활성화 */
function syncMemberFeeState() {
  const exempt = document.getElementById('memberExempt').checked;
  const fee = document.getElementById('memberFee');
  fee.disabled = exempt;
  document.getElementById('memberFeeRow').classList.toggle('disabled', exempt);
}

document.getElementById('memberExempt').addEventListener('change', syncMemberFeeState);

document.getElementById('memberForm').addEventListener('submit', async e => {
  e.preventDefault();
  const feeRaw = document.getElementById('memberFee').value.trim();
  const yearRaw = document.getElementById('memberBirthYear').value.trim();
  const teamVal = document.getElementById('memberTeam').value;
  const body = {
    team_id:     teamVal ? Number(teamVal) : null,
    is_doors:    document.getElementById('memberDoors').checked,
    name:        document.getElementById('memberName').value.trim(),
    phone:       document.getElementById('memberPhone').value.trim(),
    parts:       readPartPicker('memberParts', 'memberPartsOther'),
    gender:      document.getElementById('memberGender').value || null,
    birth_year:  yearRaw === '' ? null : Number(yearRaw),
    joined_on:   document.getElementById('memberJoined').value || null,
    memo:        document.getElementById('memberMemo').value.trim(),
    is_active:   document.getElementById('memberActive').checked,
    dues_exempt: document.getElementById('memberExempt').checked,
    monthly_fee: feeRaw === '' ? null : Number(feeRaw),
  };
  if (!body.name) { showToast('이름을 입력해주세요.', 'error'); return; }
  if (body.monthly_fee !== null && (isNaN(body.monthly_fee) || body.monthly_fee < 0)) {
    showToast('월회비는 0 이상의 숫자여야 합니다.', 'error');
    return;
  }
  if (body.birth_year !== null && (isNaN(body.birth_year) || body.birth_year < 1900 || body.birth_year > 2100)) {
    showToast('출생년도는 1900~2100 사이 네 자리로 입력해주세요.', 'error');
    return;
  }

  const btn = document.getElementById('memberSaveBtn');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = '저장 중...';
  try {
    if (editMemberId) {
      await apiJson(`/api/admin/members/${editMemberId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiJson('/api/admin/members', { method: 'POST', body: JSON.stringify(body) });
    }
    const backTo = returnToTeamId;
    closeMemberModal();
    if (backTo) {
      await Promise.all([loadTeams(), loadTeamsCache()]);
      openTeamDetail(backTo);
    } else {
      await loadMembers();
    }
    showToast('저장되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
});

async function deleteCurrentMember() {
  if (!editMemberId) return;
  const m = allMembers.find(x => x.id === editMemberId);
  if (!m) return;
  if (!confirm(`[${m.name}] 멤버를 삭제하시겠습니까?`)) return;
  try {
    await apiJson(`/api/admin/members/${editMemberId}`, { method: 'DELETE' });
    closeMemberModal();
    await loadMembers();
    showToast('삭제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

attachPhoneMask(document.getElementById('memberPhone'));
