'use strict';

/* ============================================================
   멤버 관리 — 도어즈 멤버 명부
   ============================================================ */
let allMembers    = [];
let memberSearch  = '';
let memberTeamFil = '';
let memberStatus  = 'doors';   // 도어즈 명부가 주 화면이다 — 기본으로 걸어둔다
let editMemberId  = null;
let returnToTeamId = null;   // 팀 상세에서 넘어온 경우 저장 후 그리로 돌아간다
let memberExemptIds = [];    // 팀별 회비 제외 — 모달 여는 동안만 들고 있는다

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

const GENDER_KO = { male: '남성', female: '여성' };

/* 이 팀에서 이 사람이 내는 금액. 서버의 resolve_member_fee 와 같은 순서다. */
function memberTeamFee(m, team) {
  if (m.monthly_fee != null) return m.monthly_fee;
  if (team && team.dues_fee != null) return team.dues_fee;
  return settingNum('default_monthly_fee');
}

/* 회비는 금액 그대로 보여준다 — 줄여 쓰면 얼마인지 다시 열어봐야 한다.
   소속이 여럿이면 팀마다 각각 청구되므로 합계를 보여준다. */
function memberFee(m) {
  if (m.dues_exempt) return { text: '회비 면제', cls: 'exempt' };

  const teams = m.teams || [];
  if (!teams.length) {
    const fee = memberTeamFee(m, null);
    return fee
      ? { text: `${fee.toLocaleString()}원`, cls: m.monthly_fee != null ? '' : 'default' }
      : { text: '회비 미설정', cls: 'default' };
  }

  let total = 0, charged = 0, cls = '';
  teams.forEach(ref => {
    const team = teamsById[ref.id] || ref;
    // 팀이 월 이용료를 통째로 내거나 이 팀만 제외했으면 개인이 낼 것이 없다.
    if (team.billing_type === 'monthly' || ref.dues_exempt) return;
    charged++;
    total += memberTeamFee(m, team);
    if (m.monthly_fee == null && team.dues_fee != null) cls = 'dues';
  });
  if (!charged) return { text: '팀 이용료 납부', cls: 'monthly' };
  return {
    text: `${total.toLocaleString()}원${charged > 1 ? ` (${charged}팀)` : ''}`,
    cls,
  };
}

function renderMembers() {
  const list = document.getElementById('memberList');
  const items = allMembers.filter(m => {
    // 도어즈는 위 카운터('도어즈 N')와 같은 기준으로 센다 — 활동 중인 도어즈 멤버.
    // 두 숫자가 어긋나면 어느 쪽이 맞는지 매번 세어보게 된다.
    if (memberStatus === 'doors'    && !(m.is_doors && m.is_active)) return false;
    if (memberStatus === 'check'    && !m.needs_check) return false;
    if (memberStatus === 'inactive' && m.is_active)    return false;
    const teams = m.teams || [];
    if (memberTeamFil === 'none' && teams.length) return false;
    // 대표 팀이 아니라 '이 팀에 속해 있는가' 로 거른다.
    if (memberTeamFil && memberTeamFil !== 'none' &&
        !teams.some(t => String(t.id) === memberTeamFil)) return false;
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

  list.innerHTML = '<div class="entity-cards">' + items.map(m => {
    const fee = memberFee(m);
    const info = [
      m.birth_year ? `${m.birth_year}년생` : '',
      m.gender ? GENDER_KO[m.gender] : '',
      m.joined_on ? `${m.joined_on} 가입` : '',
    ].filter(Boolean).join(' · ');

    return `
      <div class="ecard${m.is_active ? '' : ' inactive'}${m.needs_check ? ' needs-check' : ''}"
           onclick="openMemberModal(${m.id})">
        <div class="ecard-top">
          <span class="ecard-name">${escHtml(m.name)}</span>
          ${m.is_doors ? '<span class="mt-badge doors">도어즈</span>' : ''}
          ${m.needs_check ? '<span class="mt-badge check">활동 확인 필요</span>' : ''}
          ${m.is_active ? '' : '<span class="mt-badge off">비활동</span>'}
          <span class="fee-badge ${fee.cls} ecard-fee">${escHtml(fee.text)}</span>
        </div>

        <div class="ecard-sub">
          ${escHtml((m.teams || []).map(t => t.name).join(' · ') || '무소속')}
          <span class="ecard-parts">${escHtml(splitParts(m.parts).join(' · ') || '포지션 미지정')}</span>
        </div>

        <div class="ecard-meta">
          <span>${m.phone ? escHtml(formatPhone(m.phone)) : '연락처 없음'}</span>
          ${info ? `<span>${escHtml(info)}</span>` : ''}
        </div>

        ${m.memo ? `<div class="ecard-memo">${escHtml(m.memo)}</div>` : ''}
      </div>`;
  }).join('') + '</div>';
}

function openMemberModal(memberId = null, presetTeamId = null) {
  editMemberId = memberId;
  returnToTeamId = presetTeamId;
  const m = memberId ? allMembers.find(x => x.id === memberId) : null;

  document.getElementById('memberModalTitle').textContent = m ? '멤버 수정' : '멤버 등록';
  document.getElementById('memberName').value    = m?.name || '';
  memberExemptIds = (m?.teams || []).filter(t => t.dues_exempt).map(t => t.id);
  renderTeamPicker(
    'memberTeams',
    m ? (m.teams || []).map(t => t.id) : (presetTeamId ? [Number(presetTeamId)] : []),
    syncMemberTeams,
  );
  syncMemberTeams();
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
  renderDuesHistory('memberHistory', m ? `/api/admin/dues/history/member/${m.id}` : null);

  openOverlay('memberOverlay');
}

function closeMemberModal() {
  closeOverlay('memberOverlay');
  editMemberId = null;
  returnToTeamId = null;
}

bindOverlayClose('memberOverlay', closeMemberModal);

/* 소속이 둘 이상일 때만 '회비 제외할 팀' 줄을 띄운다 — 한 팀이면 위의
   '회비 면제' 체크로 충분하고, 두 곳에 같은 뜻의 스위치가 있으면 헷갈린다. */
function syncMemberTeams() {
  const chosen = readTeamPicker('memberTeams');
  const box = document.getElementById('memberTeamExempt');
  // 이미 그려둔 게 있으면 화면 상태가 정본, 처음 열 때는 멤버 값이 정본.
  const prev = box.querySelector('input') ? readTeamPicker('memberTeamExempt') : memberExemptIds;
  memberExemptIds = chosen.length >= 2 ? prev.filter(id => chosen.includes(id)) : [];

  document.getElementById('memberTeamExemptRow').style.display =
    chosen.length >= 2 ? '' : 'none';
  box.innerHTML = chosen.map(id => {
    const team = teamsById[id];
    if (!team) return '';
    const on = memberExemptIds.includes(id);
    return `
      <label class="part-check${on ? ' active' : ''}">
        <input type="checkbox" value="${id}"${on ? ' checked' : ''}
               onchange="this.closest('.part-check').classList.toggle('active', this.checked)">
        <span>${escHtml(team.name)}</span>
      </label>`;
  }).join('');
}

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
  const teamIds = readTeamPicker('memberTeams');
  // 대표 팀은 목록의 첫 팀. 원래 대표였던 팀이 그대로 남아 있으면 자리를 지킨다 —
  // 팀을 하나 더 넣었다고 대표가 멋대로 바뀌지 않게.
  const wasPrimary = editMemberId
    ? allMembers.find(x => x.id === editMemberId)?.team_id : null;
  const at = teamIds.indexOf(wasPrimary);
  if (at > 0) teamIds.unshift(...teamIds.splice(at, 1));

  const body = {
    team_ids:        teamIds,
    team_exempt_ids: readTeamPicker('memberTeamExempt'),
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
      await loadTeams();
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
      await loadTeams();
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
