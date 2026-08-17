'use strict';

/* ============================================================
   멤버 관리 — 도어즈 멤버 명부
   ============================================================ */
let allMembers    = [];
let memberSearch  = '';
let memberTeamFil = '';
let memberStatus  = 'all';
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

function setMemberStatus(s) {
  memberStatus = s;
  document.querySelectorAll('#membersPage .chip[data-mstat]').forEach(c => {
    c.classList.toggle('active', c.dataset.mstat === s);
  });
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

/* 회비 표시는 짧게 — 표 안에서 한 칸만 차지해야 한다. */
function feeShort(m) {
  const team = teamsById[m.team_id];
  if (team && team.billing_type === 'monthly') return { text: '팀 납부', cls: 'monthly' };
  if (m.dues_exempt) return { text: '면제', cls: 'exempt' };
  if (m.monthly_fee != null) return { text: `${Math.round(m.monthly_fee / 10000)}만`, cls: '' };
  if (team && team.dues_fee != null) return { text: `${Math.round(team.dues_fee / 10000)}만`, cls: 'dues' };
  const base = settingNum('default_monthly_fee');
  return { text: base ? `${Math.round(base / 10000)}만` : '기본', cls: 'default' };
}

function renderMembers() {
  const list = document.getElementById('memberList');
  const items = allMembers.filter(m => {
    if (memberStatus === 'check'    && !m.needs_check) return false;
    if (memberStatus === 'inactive' && m.is_active)    return false;
    if (memberTeamFil === 'none' && m.team_id) return false;
    if (memberTeamFil && memberTeamFil !== 'none' && String(m.team_id) !== memberTeamFil) return false;
    if (!memberSearch) return true;
    return `${m.name} ${m.parts || ''} ${m.phone || ''} ${m.memo || ''}`.toLowerCase().includes(memberSearch);
  });

  const active = allMembers.filter(m => m.is_active).length;
  const doors  = allMembers.filter(m => m.is_active && m.is_doors).length;
  const check  = allMembers.filter(m => m.needs_check).length;
  document.getElementById('memberCount').textContent =
    `활동 ${active} · 도어즈 ${doors} · 전체 ${allMembers.length}` +
    (check ? ` · ⚠️ 확인 필요 ${check}` : '');

  if (items.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">🥁</span><div class="admin-empty-text">해당되는 멤버가 없습니다.</div></div>';
    return;
  }

  list.innerHTML = '<table class="member-table"><tbody>' + items.map(m => {
    const fee = feeShort(m);
    const meta = [
      m.birth_year ? `${String(m.birth_year).slice(2)}년생` : '',
      m.gender ? GENDER_KO[m.gender] : '',
      m.joined_on ? `${m.joined_on.slice(2)} 가입` : '',
    ].filter(Boolean).join(' · ');

    return `
      <tr class="mt-row${m.is_active ? '' : ' inactive'}${m.needs_check ? ' needs-check' : ''}"
          onclick="openMemberModal(${m.id})">
        <td>
          <div class="mt-main">
            ${escHtml(m.name)}
            ${m.is_doors ? '<span class="mt-badge doors">D</span>' : ''}
            ${m.needs_check ? '<span class="mt-badge check">확인</span>' : ''}
            ${m.is_active ? '' : '<span class="mt-badge off">비활동</span>'}
          </div>
          <div class="mt-sub">${m.phone ? escHtml(formatPhone(m.phone)) : '연락처 없음'}</div>
        </td>
        <td>
          <div class="mt-main">${escHtml(m.team_name || '무소속')}</div>
          <div class="mt-sub">${escHtml((m.parts || '').split(',').join('·') || '포지션 미지정')}</div>
        </td>
        <td class="mt-right">
          <div class="mt-main"><span class="mt-fee ${fee.cls}">${escHtml(fee.text)}</span></div>
          <div class="mt-sub">${escHtml(meta || '—')}</div>
        </td>
      </tr>
      ${m.memo ? `<tr class="mt-memo-row${m.is_active ? '' : ' inactive'}"
                      onclick="openMemberModal(${m.id})">
                    <td colspan="3">📝 ${escHtml(m.memo)}</td>
                  </tr>` : ''}`;
  }).join('') + '</tbody></table>';
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
  document.getElementById('memberNeedsCheck').checked = m ? !!m.needs_check : false;
  document.getElementById('memberExempt').checked = m ? m.dues_exempt : false;
  document.getElementById('memberFee').value = (m && m.monthly_fee !== null && m.monthly_fee !== undefined)
    ? m.monthly_fee : '';
  renderPartPicker('memberParts', 'memberPartsOther', m?.parts);
  syncMemberFlags();

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

/* 상태 체크박스는 포지션 칩과 같은 모양이라 active 클래스를 직접 맞춰준다. */
function syncMemberFlags() {
  document.querySelectorAll('#memberFlags input').forEach(input => {
    input.closest('.part-check').classList.toggle('active', input.checked);
  });
  syncMemberFeeState();
}

/* 면제 회원은 금액 입력이 의미 없으므로 비활성화 */
function syncMemberFeeState() {
  const exempt = document.getElementById('memberExempt').checked;
  const fee = document.getElementById('memberFee');
  fee.disabled = exempt;
  document.getElementById('memberFeeRow').classList.toggle('disabled', exempt);
}

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
    needs_check: document.getElementById('memberNeedsCheck').checked,
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
    const backTo = returnToTeamId;
    closeMemberModal();
    if (backTo) {
      await Promise.all([loadTeams(), loadTeamsCache()]);
      openTeamDetail(backTo);
    } else {
      await loadMembers();
    }
    showToast('삭제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

attachPhoneMask(document.getElementById('memberPhone'));
