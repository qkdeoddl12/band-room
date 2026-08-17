'use strict';

/* ============================================================
   연락망 — 팀별로 묶어 한눈에 보고 바로 전화 거는 화면
   새 API 없이 멤버·팀 목록을 합쳐서 만든다.
   ============================================================ */
let contactSearch = '';
let contactData = { teams: [], members: [] };

PAGE_LOADERS.contacts = loadContacts;

async function loadContacts() {
  const list = document.getElementById('contactList');
  list.innerHTML = '<div class="spinner"></div>';
  try {
    const [teams, members] = await Promise.all([
      apiJson('/api/admin/teams'),
      apiJson('/api/admin/members?active=true'),
    ]);
    contactData = { teams, members };
  } catch (e) {
    list.innerHTML = `<div class="admin-empty"><span class="admin-empty-icon">⚠️</span><div class="admin-empty-text">${escHtml(e.message)}</div></div>`;
    return;
  }
  renderContacts();
}

function filterContacts() {
  contactSearch = document.getElementById('contactSearch').value.trim().toLowerCase();
  renderContacts();
}

function contactMatches(text) {
  if (!contactSearch) return true;
  // 검색어의 하이픈은 무시한다 — 저장은 숫자만, 화면은 하이픈이라 둘 다 걸리게.
  const q = contactSearch.replace(/-/g, '');
  return String(text).toLowerCase().replace(/-/g, '').includes(q);
}

/* 팀 하나 + 그 팀 멤버들. 검색어에 걸리는 것만 남긴다. */
function contactGroups() {
  const groups = [];
  const byTeam = {};
  contactData.members.forEach(m => { (byTeam[m.team_id] ||= []).push(m); });

  contactData.teams
    .filter(t => t.is_active)
    .forEach(t => {
      const haystack = `${t.name} ${t.leader_name || ''} ${t.phone || ''}`;
      const teamHit = contactMatches(haystack);
      const members = (byTeam[t.id] || []).filter(m =>
        teamHit || contactMatches(`${m.name} ${m.phone || ''} ${m.parts || ''}`)
      );
      // 리더 줄은 팀 자체가 걸렸을 때만 — 멤버 한 명 검색했는데
      // 팀 대표 번호가 따라 나오면 헷갈린다.
      if (teamHit || members.length) groups.push({ team: t, members, showLeader: teamHit });
    });

  const loose = (byTeam[null] || []).concat(byTeam[undefined] || [])
    .filter(m => contactMatches(`${m.name} ${m.phone || ''} ${m.parts || ''}`));
  if (loose.length) groups.push({ team: null, members: loose });

  return groups;
}

function contactRow(name, phone, sub, tag) {
  const tel = String(phone || '').replace(/[^\d+]/g, '');
  return `
    <div class="contact-row">
      <div class="contact-who">
        <div class="contact-name">
          ${escHtml(name)}
          ${tag ? `<span class="contact-tag">${escHtml(tag)}</span>` : ''}
        </div>
        ${sub ? `<div class="contact-sub">${sub}</div>` : ''}
      </div>
      ${phone
        ? `<a class="contact-call" href="tel:${escHtml(tel)}">${escHtml(formatPhone(phone))}</a>`
        : '<span class="contact-none">연락처 없음</span>'}
    </div>`;
}

function renderContacts() {
  const list = document.getElementById('contactList');
  const groups = contactGroups();

  const withPhone = contactData.members.filter(m => m.phone).length;
  document.getElementById('contactCount').textContent =
    `멤버 ${contactData.members.length}명 중 ${withPhone}명 연락처 등록 · 번호를 누르면 바로 전화가 걸립니다`;

  if (groups.length === 0) {
    list.innerHTML = '<div class="admin-empty"><span class="admin-empty-icon">📇</span><div class="admin-empty-text">표시할 연락처가 없습니다.</div></div>';
    return;
  }

  list.innerHTML = groups.map(g => {
    const title = g.team ? g.team.name : '무소속';
    const leader = g.showLeader && g.team && (g.team.leader_name || g.team.phone)
      ? contactRow(g.team.leader_name || '팀 대표', g.team.phone, '팀 연락처', '리더')
      : '';
    const rows = g.members.map(m =>
      contactRow(m.name, m.phone, partTagsHtml(m.parts), m.is_doors ? '도어즈' : null)
    ).join('');

    return `
      <div class="contact-group">
        <div class="contact-group-head">
          <span class="contact-group-name">${escHtml(title)}</span>
          <span class="contact-group-count">${g.members.length}명</span>
        </div>
        ${leader}${rows || '<div class="contact-empty">등록된 멤버가 없습니다.</div>'}
      </div>`;
  }).join('');
}

/* 카톡 등에 붙여넣기 좋은 평문. 복사 버튼과 검증이 같은 함수를 쓴다. */
function contactsAsText() {
  const lines = [];
  contactGroups().forEach(g => {
    lines.push(`[${g.team ? g.team.name : '무소속'}]`);
    if (g.team && (g.team.leader_name || g.team.phone)) {
      lines.push(`- ${g.team.leader_name || '팀 대표'} (리더) ${formatPhone(g.team.phone) || '연락처 없음'}`);
    }
    g.members.forEach(m => {
      const parts = m.parts ? ` · ${m.parts.split(',').join('/')}` : '';
      lines.push(`- ${m.name}${parts} ${formatPhone(m.phone) || '연락처 없음'}`);
    });
    lines.push('');
  });
  return lines.join('\n').trim();
}

async function copyContacts() {
  const btn = document.getElementById('contactCopyBtn');
  try {
    await navigator.clipboard.writeText(contactsAsText());
    btn.textContent = '복사됨 ✓';
    setTimeout(() => { btn.textContent = '전체 복사'; }, 1500);
  } catch {
    showToast('클립보드 복사에 실패했습니다.', 'error');
  }
}
