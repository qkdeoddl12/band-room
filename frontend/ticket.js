'use strict';

/* 공개 티켓 페이지 — /t/{slug}
   에디터와 같은 tkRender()를 쓰므로 좌표·크기가 정확히 같게 보인다. */
const slug = location.pathname.split('/').filter(Boolean).pop();
let ticket = null;

/* ============================================================
   로드
   ============================================================ */
async function loadTicket() {
  const canvas = document.getElementById('tkpCanvas');
  try {
    const res = await fetch(`/api/tickets/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error();
    ticket = await res.json();
  } catch {
    canvas.outerHTML = '<div class="tkp-error">티켓을 찾을 수 없습니다.<br>링크를 다시 확인해주세요.</div>';
    return;
  }

  document.title = `${ticket.title} — Band Room`;
  tkRender(canvas, ticket);

  if (ticket.bg_url) tkTintFrom(ticket.bg_url, document.body);

  // 서버가 http/https 만 통과시키지만, href 로 넣기 전에 한 번 더 확인한다.
  const map = document.getElementById('tkpMap');
  if (ticket.map_url && /^https?:\/\//i.test(ticket.map_url)) {
    map.href = ticket.map_url;
    map.style.display = '';
  }

  document.getElementById('tkpActions').style.display = '';
  document.getElementById('tkpNote').textContent = '스크린샷으로 저장해 입장 시 보여주세요.';
}

/* 집계는 부가 기능이라 실패해도 사용자 동작을 막지 않는다. */
function recordEvent(type) {
  fetch(`/api/tickets/${encodeURIComponent(slug)}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
    keepalive: true,
  }).catch(() => {});
}

async function shareTicket() {
  const data = { title: ticket?.title || 'Band Room 티켓', url: location.href };
  if (navigator.share) {
    try {
      await navigator.share(data);
      recordEvent('share');
      return;
    } catch { /* 사용자가 취소 */ }
  }
  copyLink();
}

async function copyLink() {
  const btn = document.getElementById('tkpCopyBtn');
  const original = btn.innerHTML;
  try {
    await navigator.clipboard.writeText(location.href);
    recordEvent('copy');
    btn.textContent = '복사됨 ✓';
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  } catch {
    btn.textContent = '복사 실패';
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  }
}

loadTicket();
