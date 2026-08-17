'use strict';

/* ============================================================
   환경 설정 — 입금 계좌 · 기본 월회비 · 공간별 요금
   ============================================================ */
PAGE_LOADERS.settings = loadSettings;

async function loadSettings() {
  const body = document.getElementById('settingsRooms');
  body.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await apiJson('/api/admin/settings');
    document.getElementById('setBank').value    = data.values.deposit_bank || '';
    document.getElementById('setAccount').value = data.values.deposit_account || '';
    document.getElementById('setHolder').value  = data.values.deposit_holder || '';
    document.getElementById('setFee').value     = data.values.default_monthly_fee || '';
    document.getElementById('setTeamFee').value = data.values.default_team_fee || '';

    body.innerHTML = data.rooms.map(r => `
      <div class="form-group">
        <label class="form-label" for="roomPrice${r.id}">${escHtml(r.name)} 시간당 요금</label>
        <input type="number" min="0" step="1000" class="form-input"
               id="roomPrice${r.id}" data-room-id="${r.id}" value="${r.hourly_price}">
      </div>
    `).join('');
  } catch (e) {
    body.innerHTML = `<div class="admin-empty"><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
  }
}

document.getElementById('settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('settingsSaveBtn');
  btn.disabled = true; btn.textContent = '저장 중...';

  try {
    await apiJson('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        values: {
          deposit_bank:        document.getElementById('setBank').value.trim(),
          deposit_account:     document.getElementById('setAccount').value.trim(),
          deposit_holder:      document.getElementById('setHolder').value.trim(),
          default_monthly_fee: document.getElementById('setFee').value.trim() || '0',
          default_team_fee:    document.getElementById('setTeamFee').value.trim() || '0',
        },
      }),
    });

    for (const input of document.querySelectorAll('#settingsRooms input[data-room-id]')) {
      await apiJson(`/api/admin/rooms/${input.dataset.roomId}/price`, {
        method: 'PUT',
        body: JSON.stringify({ hourly_price: Number(input.value || 0) }),
      });
    }

    await Promise.all([loadRooms(), loadAppSettings()]);   // 요금 캐시 갱신
    showToast('설정이 저장되었습니다.', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '설정 저장';
  }
});
