'use strict';

/* ============================================================
   계정 관리 (system admin only)
   ============================================================ */
let editTargetUserId = null;

PAGE_LOADERS.users = loadUsers;

async function loadUsers() {
  const list = document.getElementById('usersList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    allUsers = await apiJson('/api/admin/users');
  } catch {
    allUsers = [];
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">목록을 불러오지 못했습니다.</div></div>';
    return;
  }
  renderUsers();
}

function renderUsers() {
  const list = document.getElementById('usersList');
  if (allUsers.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">👤</span><div class="admin-empty-text">계정이 없습니다.</div></div>';
    return;
  }

  let html = '<div class="user-list">';
  allUsers.forEach(u => {
    const isMe = u.id === currentUser.id;
    const roleClass = u.role === 'system' ? 'system' : 'reservation';
    const roleName  = u.role === 'system' ? '시스템 관리자' : '예약 관리자';
    const roleIcon  = u.role === 'system' ? '⚙️' : '📋';

    html += `
      <div class="user-item ${u.is_active ? '' : 'inactive'}">
        <div class="user-avatar ${roleClass}">${escHtml(u.username.charAt(0).toUpperCase())}</div>
        <div class="user-meta">
          <div class="user-meta-top">
            <span class="user-meta-name">${escHtml(u.username)}</span>
            ${isMe ? '<span class="user-self-tag">나</span>' : ''}
            ${u.is_active ? '' : '<span class="user-inactive-tag">비활성</span>'}
          </div>
          <div class="user-meta-bottom">
            <span class="user-role-badge ${roleClass}">${roleIcon} ${roleName}</span>
            <span class="user-created">가입: ${fmtDateTime(u.created_at)}</span>
          </div>
        </div>
        <button class="btn-edit-user" onclick="openEditUserModal(${u.id})">수정</button>
      </div>`;
  });
  html += '</div>';
  list.innerHTML = html;
}

/* ========== Create User ========== */
function openCreateUserModal() {
  document.getElementById('newUsername').value = '';
  document.querySelectorAll('input[name="newRole"]').forEach((r, i) => { r.checked = i === 0; });
  syncRoleOptionStyles('newRole');
  openOverlay('createUserOverlay');
}

function closeCreateUserModal() { closeOverlay('createUserOverlay'); }
bindOverlayClose('createUserOverlay', closeCreateUserModal);

document.getElementById('createUserForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('newUsername').value.trim();
  const role = document.querySelector('input[name="newRole"]:checked').value;

  const btn = document.getElementById('createUserBtn');
  btn.disabled = true; btn.textContent = '생성 중...';

  try {
    const data = await apiJson('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, role }),
    });
    closeCreateUserModal();
    await loadUsers();
    openTempPasswordModal(data.user.username, data.temp_password);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '계정 생성';
  }
});

/* ========== Temp Password ========== */
function openTempPasswordModal(username, password) {
  document.getElementById('tempPwUsername').textContent = username;
  document.getElementById('tempPwValue').textContent = password;
  document.getElementById('copyTempPwBtn').textContent = '복사';
  openOverlay('tempPasswordOverlay');
}

function closeTempPasswordModal() {
  closeOverlay('tempPasswordOverlay');
  document.getElementById('tempPwValue').textContent = '';
}

async function copyTempPassword() {
  const pw = document.getElementById('tempPwValue').textContent;
  const btn = document.getElementById('copyTempPwBtn');
  try {
    await navigator.clipboard.writeText(pw);
    btn.textContent = '복사됨 ✓';
    setTimeout(() => { btn.textContent = '복사'; }, 1500);
  } catch {
    showToast('클립보드 복사에 실패했습니다.', 'error');
  }
}

bindOverlayClose('tempPasswordOverlay', closeTempPasswordModal);

/* ========== Edit User ========== */
function openEditUserModal(userId) {
  const u = allUsers.find(x => x.id === userId);
  if (!u) return;
  editTargetUserId = userId;

  const isMe = u.id === currentUser.id;
  document.getElementById('editUserTarget').innerHTML = `
    <b>${escHtml(u.username)}</b>${isMe ? ' (나)' : ''}<br>
    <span class="modal-target-sub">
      ${u.role === 'system' ? '⚙️ 시스템 관리자' : '📋 예약 관리자'}
       · ${u.is_active ? '활성' : '비활성'}
    </span>
  `;

  document.getElementById('editPassword').value = '';
  document.querySelectorAll('input[name="editRole"]').forEach(r => { r.checked = (r.value === u.role); });
  document.getElementById('editActive').checked = u.is_active;
  syncRoleOptionStyles('editRole');

  openOverlay('editUserOverlay');
}

function closeEditUserModal() {
  closeOverlay('editUserOverlay');
  editTargetUserId = null;
}

bindOverlayClose('editUserOverlay', closeEditUserModal);

document.getElementById('editUserForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!editTargetUserId) return;

  const password = document.getElementById('editPassword').value;
  const role     = document.querySelector('input[name="editRole"]:checked').value;
  const isActive = document.getElementById('editActive').checked;

  const body = { role, is_active: isActive };
  if (password) body.password = password;

  const btn = document.getElementById('editUserBtn');
  btn.disabled = true; btn.textContent = '저장 중...';

  try {
    await apiJson(`/api/admin/users/${editTargetUserId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    closeEditUserModal();
    await loadUsers();
    showToast('계정이 수정되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '변경 저장';
  }
});

async function deleteCurrentUser() {
  if (!editTargetUserId) return;
  const u = allUsers.find(x => x.id === editTargetUserId);
  if (!u) return;

  if (!confirm(`정말 [${u.username}] 계정을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;

  try {
    await apiJson(`/api/admin/users/${editTargetUserId}`, { method: 'DELETE' });
    closeEditUserModal();
    await loadUsers();
    showToast(`계정 [${u.username}] 이(가) 삭제되었습니다.`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* ========== Role radio look ========== */
function syncRoleOptionStyles(name) {
  document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
    input.closest('.role-option').classList.toggle('active', input.checked);
  });
}

document.querySelectorAll('input[name="newRole"]').forEach(input => {
  input.addEventListener('change', () => syncRoleOptionStyles('newRole'));
});
document.querySelectorAll('input[name="editRole"]').forEach(input => {
  input.addEventListener('change', () => syncRoleOptionStyles('editRole'));
});
