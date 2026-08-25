'use strict';

/* ============================================================
   오픈 잼 (관리자) — 회원이 올린 곡과 지원 현황.
   여기서는 연락처까지 보이고, 지저분한 발제를 치울 수 있다.
   ============================================================ */
let allJams = [];

PAGE_LOADERS.openjams = loadOpenjams;

const JAM_STATUS = {
  recruiting: { label: '모집중',   cls: 'pending' },
  closed:     { label: '모집완료', cls: 'paid'    },
  done:       { label: '종료',     cls: 'exempt'  },
};

async function loadOpenjams() {
  const list = document.getElementById('openjamList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    allJams = await apiJson('/api/admin/openjams');
  } catch (e) {
    allJams = [];
    list.innerHTML = `<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
    return;
  }
  renderOpenjams();
}

function renderOpenjams() {
  const list = document.getElementById('openjamList');
  const open = allJams.filter(j => j.status === 'recruiting').length;
  const stale = allJams.filter(j => j.is_stale).length;
  setText('openjamCount',
    `전체 ${allJams.length}건 · 모집중 ${open}건 — 회원이 직접 올립니다.`
    + (stale ? ` · ⚠️ 오래 방치 ${stale}건` : ''));

  if (!allJams.length) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">🎸</span><div class="admin-empty-text">아직 올라온 오픈 잼이 없습니다.</div></div>';
    return;
  }

  list.innerHTML = '<div class="entity-cards">' + allJams.map(jam => {
    const meta = JAM_STATUS[jam.status] || JAM_STATUS.recruiting;
    const filled = jam.slots.filter(s => s.member_name).length;
    const slots = jam.slots.map(s => `
      <span class="jam-adm-slot${s.member_name ? ' taken' : ''}">
        ${escHtml(s.part)}${s.member_name ? ` · ${escHtml(s.member_name)}` : ''}
      </span>`).join('');

    return `
      <div class="ecard">
        <div class="ecard-top">
          <span class="ecard-name">${escHtml(jam.title)}</span>
          ${jam.is_stale ? `<span class="mt-badge check">마감 ${jam.closed_days}일 지남</span>` : ''}
          <span class="fee-badge ${meta.cls} ecard-fee">${meta.label} ${filled}/${jam.slots.length}</span>
        </div>
        <div class="ecard-sub">
          ${escHtml(jam.leader_name || '발제자 없음')}
          ${jam.leader_phone ? `<span class="ecard-parts">${escHtml(formatPhone(jam.leader_phone))}</span>` : ''}
          ${jam.target_period ? `<span class="ecard-parts">${escHtml(jam.target_period)}</span>` : ''}
        </div>
        <div class="jam-adm-slots">${slots}</div>
        ${jam.memo ? `<div class="ecard-memo">${escHtml(jam.memo)}</div>` : ''}
        <div class="ecard-meta">
          <span>${escHtml(String(jam.created_at).slice(0, 10))} 올림</span>
          <span class="jam-adm-actions">
            ${jam.status !== 'done'
              ? `<button class="ecard-edit" onclick="setJamStatus(${jam.id}, 'done')">종료 처리</button>`
              : `<button class="ecard-edit" onclick="setJamStatus(${jam.id}, 'recruiting')">다시 모집</button>`}
            <button class="ecard-edit" onclick="deleteJamAdmin(${jam.id})">삭제</button>
          </span>
        </div>
      </div>`;
  }).join('') + '</div>';
}

async function setJamStatus(jamId, status) {
  try {
    await apiJson(`/api/admin/openjams/${jamId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadOpenjams();
    showToast('상태를 바꿨습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function deleteJamAdmin(jamId) {
  const jam = allJams.find(j => j.id === jamId);
  if (!confirm(`[${jam ? jam.title : '이 오픈 잼'}] 을 삭제하시겠습니까?\n지원한 자리도 함께 사라집니다.`)) return;
  try {
    await apiJson(`/api/admin/openjams/${jamId}`, { method: 'DELETE' });
    await loadOpenjams();
    showToast('삭제되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}
