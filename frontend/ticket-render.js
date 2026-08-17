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

/* ============================================================
   배경 이미지에서 강조색 뽑기
   업로드 이미지는 같은 오리진이라 canvas 가 오염되지 않는다.
   ============================================================ */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else                h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1/3), hue(p, q, h), hue(p, q, h - 1/3)]
    .map(v => Math.round(v * 255));
}

/* 평균색만 쓰면 탁한 갈색이 나오기 쉽다.
   색상(hue)은 채도가 높은 픽셀 위주로 고르고, 채도·밝기는 버튼에 쓸 만한 값으로 보정한다. */
function accentFromImage(img) {
  const SIZE = 28;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  let data;
  try { data = ctx.getImageData(0, 0, SIZE, SIZE).data; }
  catch { return null; }   // 오염된 canvas — 기본색 유지

  // 색상환을 12칸으로 나눠 채도 가중치를 모은다.
  const BINS = 12;
  const weightSum = new Array(BINS).fill(0);
  const hueSum    = new Array(BINS).fill(0);
  const satSum    = new Array(BINS).fill(0);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;                 // 투명 픽셀 제외
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (l < 0.08 || l > 0.95) continue;              // 거의 검정/흰색 제외
    const idx = Math.min(BINS - 1, Math.floor(h * BINS));
    const weight = s * s;                            // 선명한 색일수록 크게 반영
    weightSum[idx] += weight;
    hueSum[idx]    += h * weight;
    satSum[idx]    += s * weight;
  }

  let best = 0;
  for (let i = 1; i < BINS; i++) if (weightSum[i] > weightSum[best]) best = i;
  if (weightSum[best] <= 0.001) return null;         // 무채색 포스터 — 기본색 유지

  // 칸 중앙이 아니라 칸 안의 가중 평균 색상을 쓴다 (빨강이 분홍으로 밀리지 않게).
  const hue = hueSum[best] / weightSum[best];
  const sat = Math.min(0.85, Math.max(0.5, satSum[best] / weightSum[best]));
  return hslToRgb(hue, sat, 0.6);
}

/* target 에 CSS 변수를 심는다 — 공개 페이지는 :root, 에디터 미리보기는 미리보기 요소. */
function tkApplyAccent(rgb, target) {
  const el = target || document.documentElement;
  if (!rgb) {
    el.style.removeProperty('--tkp-accent');
    el.style.removeProperty('--tkp-bg');
    return;
  }
  el.style.setProperty('--tkp-accent', rgb.join(' '));
  // 배경도 같은 색을 아주 어둡게 깔아 포스터와 톤을 맞춘다.
  const [h, s] = rgbToHsl(...rgb);
  el.style.setProperty('--tkp-bg', hslToRgb(h, Math.min(s, 0.35), 0.06).join(' '));
}

function tkTintFrom(url, target) {
  if (!url) { tkApplyAccent(null, target); return; }
  const img = new Image();
  img.onload  = () => tkApplyAccent(accentFromImage(img), target);
  img.onerror = () => tkApplyAccent(null, target);
  img.src = url;
}

