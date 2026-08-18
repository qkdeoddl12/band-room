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
/* 포스터에서 대표 색과 전체 밝기를 뽑는다.
   애플 뮤직처럼 배경이 아트웍을 따라가야 하므로 색만이 아니라 밝기도 필요하다. */
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
  let lightSum = 0, seen = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;                 // 투명 픽셀 제외
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    // 밝기는 흰 여백까지 포함해야 "밝은 포스터"를 알아본다.
    lightSum += l; seen++;
    if (l < 0.08 || l > 0.95) continue;              // 색 뽑기에서만 거의 검정/흰색 제외
    const idx = Math.min(BINS - 1, Math.floor(h * BINS));
    const weight = s * s;                            // 선명한 색일수록 크게 반영
    weightSum[idx] += weight;
    hueSum[idx]    += h * weight;
    satSum[idx]    += s * weight;
  }
  if (!seen) return null;

  let best = 0;
  for (let i = 1; i < BINS; i++) if (weightSum[i] > weightSum[best]) best = i;

  const light = lightSum / seen;
  if (weightSum[best] <= 0.001) {
    // 무채색 포스터(흑백·흰 바탕). 색은 없지만 밝기는 따라간다.
    return { hue: 0, sat: 0, light };
  }
  // 칸 중앙이 아니라 칸 안의 가중 평균 색상을 쓴다 (빨강이 분홍으로 밀리지 않게).
  return {
    hue: hueSum[best] / weightSum[best],
    sat: Math.min(0.85, Math.max(0.35, satSum[best] / weightSum[best])),
    light,
  };
}

/* 상대 휘도 (WCAG). 채워진 버튼 위 글자색을 고르는 데 쓴다. */
function tkLuminance([r, g, b]) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/* 흰 글자와 검은 글자 중 대비가 더 큰 쪽. 임의의 밝기 기준으로 자르면
   주황처럼 중간 밝기 색에서 읽기 힘든 조합이 나온다. */
const TKP_DARK_INK = [17, 18, 24];
function tkInkFor(bg) {
  const L = tkLuminance(bg);
  const onWhite = 1.05 / (L + 0.05);
  const onDark  = (L + 0.05) / (tkLuminance(TKP_DARK_INK) + 0.05);
  return onWhite >= onDark ? [255, 255, 255] : TKP_DARK_INK;
}

/* target 에 CSS 변수를 심는다 — 공개 페이지는 body(.tkp-page), 에디터는 미리보기 요소. */
function tkApplyAccent(info, target) {
  const el = target || document.body;
  const props = ['--tkp-accent', '--tkp-bg', '--tkp-ink', '--tkp-on-accent'];
  if (!info) {
    props.forEach(k => el.style.removeProperty(k));
    el.classList.remove('light');
    return;
  }

  const { hue, sat, light } = info;
  // 포스터가 밝으면 페이지도 밝게. 애플 뮤직에서 앨범 커버가 흰색이면
  // 배경도 흰 톤으로 가는 것과 같은 규칙.
  const isLight = light > 0.62;

  const bg     = hslToRgb(hue, Math.min(sat, 0.30), isLight ? 0.94 : 0.07);
  // 버튼은 배경과 충분히 갈라져야 한다 — 밝은 페이지에선 진하게, 어두우면 밝게.
  const accent = hslToRgb(hue, sat, isLight ? 0.42 : 0.62);
  const ink      = isLight ? TKP_DARK_INK : [255, 255, 255];
  const onAccent = tkInkFor(accent);

  el.style.setProperty('--tkp-accent', accent.join(' '));
  el.style.setProperty('--tkp-bg', bg.join(' '));
  el.style.setProperty('--tkp-ink', ink.join(' '));
  el.style.setProperty('--tkp-on-accent', onAccent.join(' '));
  el.classList.toggle('light', isLight);
}

function tkTintFrom(url, target) {
  if (!url) { tkApplyAccent(null, target); return; }
  const img = new Image();
  img.onload  = () => tkApplyAccent(accentFromImage(img), target);
  img.onerror = () => tkApplyAccent(null, target);
  img.src = url;
}

