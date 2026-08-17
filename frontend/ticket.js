'use strict';

/* 공개 티켓 페이지 — /t/{slug}
   에디터와 같은 tkRender()를 쓰므로 좌표·크기가 정확히 같게 보인다. */
const slug = location.pathname.split('/').filter(Boolean).pop();
let ticket = null;

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

function applyAccent(rgb) {
  if (!rgb) return;
  document.documentElement.style.setProperty('--tkp-accent', rgb.join(' '));
  // 배경도 같은 색을 아주 어둡게 깔아 포스터와 톤을 맞춘다.
  const [h, s] = rgbToHsl(...rgb);
  document.documentElement.style.setProperty(
    '--tkp-bg', hslToRgb(h, Math.min(s, 0.35), 0.06).join(' '),
  );
}

function tintFromBackground(url) {
  const img = new Image();
  img.onload = () => applyAccent(accentFromImage(img));
  img.onerror = () => {};
  img.src = url;
}

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
    document.getElementById('tkpBrand').style.display = 'none';
    return;
  }

  document.title = `${ticket.title} — Band Room`;
  tkRender(canvas, ticket);

  if (ticket.bg_url) tintFromBackground(ticket.bg_url);

  // 서버가 http/https 만 통과시키지만, href 로 넣기 전에 한 번 더 확인한다.
  const map = document.getElementById('tkpMap');
  if (ticket.map_url && /^https?:\/\//i.test(ticket.map_url)) {
    map.href = ticket.map_url;
    map.style.display = '';
  }

  document.getElementById('tkpActions').style.display = '';
  document.getElementById('tkpNote').textContent = '스크린샷으로 저장해 입장 시 보여주세요.';
}

async function shareTicket() {
  const data = { title: ticket?.title || 'Band Room 티켓', url: location.href };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch { /* 사용자가 취소 */ }
  }
  copyLink();
}

async function copyLink() {
  const btn = document.getElementById('tkpCopyBtn');
  const original = btn.innerHTML;
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = '복사됨 ✓';
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  } catch {
    btn.textContent = '복사 실패';
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  }
}

loadTicket();
