'use strict';

/* ============================================================
   티켓 렌더링 — 관리자 에디터와 공개 페이지가 함께 쓴다.
   좌표는 퍼센트, 글자 크기는 cqw(캔버스 폭의 %)라서
   화면 크기가 달라도 같은 비율로 보인다.
   ============================================================ */
function tkEsc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tkElementStyle(el) {
  const shift = el.align === 'left' ? '0' : (el.align === 'right' ? '-100%' : '-50%');
  return [
    `left:${el.x}%`,
    `top:${el.y}%`,
    `transform:translate(${shift}, -50%)`,
    `font-size:${el.size}cqw`,
    `color:${el.color}`,
    `font-weight:${el.weight}`,
    `text-align:${el.align}`,
    el.shadow ? 'text-shadow:0 2px 8px rgba(0,0,0,.55)' : 'text-shadow:none',
  ].join(';');
}

function tkApplyCanvas(canvas, ticket) {
  canvas.style.aspectRatio = String(ticket.aspect || '3:4').replace(':', ' / ');
  canvas.style.backgroundImage = ticket.bg_url ? `url("${encodeURI(ticket.bg_url)}")` : 'none';
  canvas.classList.toggle('no-bg', !ticket.bg_url);
}

function tkRender(canvas, ticket, opts = {}) {
  const { editable = false, selectedId = null } = opts;
  tkApplyCanvas(canvas, ticket);
  canvas.classList.toggle('editing', editable);
  canvas.innerHTML = (ticket.elements || []).map(el => `
    <div class="tk-el${editable ? ' editable' : ''}${selectedId === el.id ? ' selected' : ''}"
         data-id="${tkEsc(el.id)}" style="${tkElementStyle(el)}">${tkEsc(el.text)}</div>
  `).join('');
}
