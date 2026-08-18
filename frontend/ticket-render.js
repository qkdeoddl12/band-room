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

/* ============================================================
   포스터 색 추출 — 애플 뮤직 방식을 따른다
   1) 배경색은 가장자리 픽셀에서 (가운데 로고가 아니라 판 전체 톤)
   2) 채도를 깎지 않는다 — 깎으면 회색빛으로 칙칙해진다
   3) 명도는 거의 검정/흰색이 아니라 진한 색 (0.22 / 0.90)
   4) 글자색은 대비를 만족할 때까지 조정
   ============================================================ */
const TKP_BINS = 12;

function tkHueBins(px) {
  const weight = new Array(TKP_BINS).fill(0);
  const hue    = new Array(TKP_BINS).fill(0);
  const sat    = new Array(TKP_BINS).fill(0);
  for (const [h, s, l] of px) {
    if (l < 0.06 || l > 0.96) continue;
    const i = Math.min(TKP_BINS - 1, Math.floor(h * TKP_BINS));
    const w = s * s;
    weight[i] += w; hue[i] += h * w; sat[i] += s * w;
  }
  return weight
    .map((w, i) => ({ w, h: w ? hue[i] / w : 0, s: w ? sat[i] / w : 0 }))
    .sort((a, b) => b.w - a.w);
}

function accentFromImage(img) {
  const SIZE = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  let data;
  try { data = ctx.getImageData(0, 0, SIZE, SIZE).data; }
  catch { return null; }   // 오염된 canvas — 기본색 유지

  const all = [], edge = [];
  let lightSum = 0, seen = 0;
  const EDGE = Math.max(2, Math.round(SIZE * 0.12));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (data[i + 3] < 128) continue;
      const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      all.push(hsl);
      lightSum += hsl[2]; seen++;
      if (x < EDGE || x >= SIZE - EDGE || y < EDGE || y >= SIZE - EDGE) edge.push(hsl);
    }
  }
  if (!seen) return null;

  // 배경 톤은 가장자리 기준. 가장자리가 무채색이면 전체로 물러선다.
  const edgeBins = tkHueBins(edge);
  const allBins  = tkHueBins(all);
  const base = edgeBins[0].w > 0.02 ? edgeBins : allBins;

  return {
    // 배경용 대표 색과, 그라디언트 두 번째 색 (없으면 같은 색)
    bgHue: base[0].h, bgSat: base[0].s,
    altHue: base[1] && base[1].w > base[0].w * 0.35 ? base[1].h : base[0].h,
    altSat: base[1] && base[1].w > base[0].w * 0.35 ? base[1].s : base[0].s,
    // 버튼은 판에서 가장 선명한 색을 쓴다 — 가장자리가 아니라 전체에서
    accHue: allBins[0].h, accSat: allBins[0].s,
    chroma: base[0].w,          // 0 에 가까우면 무채색 포스터
    light: lightSum / seen,
  };
}

/* 상대 휘도 (WCAG). */
function tkLuminance([r, g, b]) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function tkContrast(a, b) {
  const [x, y] = [tkLuminance(a), tkLuminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/* 흰 글자와 검은 글자 중 대비가 더 큰 쪽. 임의의 밝기 기준으로 자르면
   주황처럼 중간 밝기 색에서 읽기 힘든 조합이 나온다. */
const TKP_DARK_INK = [17, 18, 24];
function tkInkFor(bg) {
  return tkContrast(bg, [255, 255, 255]) >= tkContrast(bg, TKP_DARK_INK)
    ? [255, 255, 255] : TKP_DARK_INK;
}

/* 배경 대비 목표치를 넘을 때까지 명도만 조금씩 옮긴다.
   채도는 건드리지 않는다 — 그게 칙칙해지는 원인이다. */
function tkFitContrast(h, s, l, bg, target, towardLight) {
  let rgb = hslToRgb(h, s, l);
  for (let i = 0; i < 24 && tkContrast(rgb, bg) < target; i++) {
    l = towardLight ? Math.min(0.97, l + 0.02) : Math.max(0.05, l - 0.02);
    rgb = hslToRgb(h, s, l);
  }
  return rgb;
}

/* target 에 CSS 변수를 심는다 — 공개 페이지는 body(.tkp-page), 에디터는 미리보기 요소. */
const TKP_VARS = ['--tkp-accent', '--tkp-bg', '--tkp-bg2', '--tkp-ink', '--tkp-on-accent'];

function tkApplyAccent(info, target) {
  const el = target || document.body;
  if (!info) {
    TKP_VARS.forEach(k => el.style.removeProperty(k));
    el.classList.remove('light');
    return;
  }

  const { bgHue, bgSat, altHue, altSat, accHue, accSat, chroma, light } = info;
  const isLight = light > 0.62;

  // "색이 있는 포스터인가"는 가중치 총합이 아니라 **채도**로 판단한다.
  // 총합으로 재면 거의 흰 포스터의 미세한 색 얼룩도 '색 있음'이 돼서
  // 채도 7% 짜리 초록을 35% 로 부풀려 칠하게 된다 (실제로 그랬다).
  const NEUTRAL = 0.16;
  const colored = accSat >= NEUTRAL && chroma > 0.01;
  // 포스터에 있는 것보다 진하게 만들지 않는다. 없는 색은 지어내지 않는다.
  const bgSatOf = v => colored
    ? (isLight ? Math.min(0.5, v) * 0.5 : Math.min(0.75, v))
    : 0.02;
  const accSatOf = v => colored ? Math.min(0.85, v * 1.2) : 0;

  // 애플처럼 "진한 색". 거의 검정(0.07)이 아니라 0.22, 흰색이 아니라 0.92.
  const bgL  = isLight ? 0.92 : 0.22;
  const bg   = hslToRgb(colored ? bgHue : 0, bgSatOf(bgSat), bgL);
  const bg2  = hslToRgb(colored ? altHue : 0, bgSatOf(altSat), isLight ? 0.965 : 0.13);

  const ink = isLight ? TKP_DARK_INK : [255, 255, 255];
  // 버튼은 배경에서 확실히 떠야 한다. 어두운 배경에선 파스텔에 가깝게 밝혀
  // 애플 뮤직의 밝은 알약 버튼처럼 보이게 한다 (중간 톤이면 가라앉는다).
  const accent = tkFitContrast(
    colored ? accHue : 0, accSatOf(accSat), isLight ? 0.30 : 0.80, bg, 4.5, !isLight,
  );

  el.style.setProperty('--tkp-accent', accent.join(' '));
  el.style.setProperty('--tkp-bg', bg.join(' '));
  el.style.setProperty('--tkp-bg2', bg2.join(' '));
  el.style.setProperty('--tkp-ink', ink.join(' '));
  el.style.setProperty('--tkp-on-accent', tkInkFor(accent).join(' '));
  el.classList.toggle('light', isLight);
}

function tkTintFrom(url, target) {
  if (!url) { tkApplyAccent(null, target); return; }
  const img = new Image();
  img.onload  = () => tkApplyAccent(accentFromImage(img), target);
  img.onerror = () => tkApplyAccent(null, target);
  img.src = url;
}

