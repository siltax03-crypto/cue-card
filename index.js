/* ===================================================================
 * 큐카드 (Cue Card) — SillyTavern 확장
 *
 * 채팅 입력창 위에 "연출 지시" 버튼을 띄운다. 버튼은 명령이 아니라
 * 감독이 배우에게 몰래 건네는 큐카드 — AI는 그 지시를 한 턴에
 * 터뜨리지 않고 여러 턴에 걸쳐 자연스럽게 무르익게 유도한다.
 *
 *  · 카드 클릭 = 무장(여러 개 동시 가능). 다음 전송 시 프롬프트에 주입.
 *  · 1회성 = 전송 후 해제 / 🔁지속 = 목표 끝날 때까지 매 턴 재주입.
 *  · ＋즉석 = 이번 세션에만 쓸 카드를 실시간 등록.
 *  · 👁 주입 보기 = 지금 무엇이 주입될지 확인 / ⚙ 관리 = 카드 편집.
 *  · 🎬 핸들 = UI 전체 접기/펴기.
 * =================================================================== */

import { eventSource, event_types, saveSettingsDebounced, updateMessageBlock } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE = 'cueCard';
const ctx = () => SillyTavern.getContext();

// 🔁 지속 카드 — 여러 턴에 걸쳐 무르익히는 빌드업용 래퍼
const DEFAULT_WRAPPER_PERSIST =
  "[Director's note — invisible to {{user}}. Steer the story toward the goals below, naturally and gradually across multiple turns. Build them up; never force or rush.]";
// 1회성 카드 — 이번 응답에 즉시 반영하는 래퍼
const DEFAULT_WRAPPER_ONCE =
  "[Director's note — invisible to {{user}}. Work the following into THIS reply, right now, naturally. Do not drag it out.]";
// AI 자동 완료: 지속 카드 블록 끝에 붙는 완료 신호 규약
const DONE_INSTR =
  "When a goal above is fully realized in the story, append <cue_done>exact goal label</cue_done> at the very end of your reply (hidden meta — never mention it in prose).";

const DEFAULT_CARDS = [
    { label: '며칠 뒤', persist: false, prompt: '며칠 뒤의 새로운 에피소드로 바꿔줘' },
    { label: '바람피는 거', persist: false, prompt: '' },
    { label: '고백', persist: false, prompt: '' },
];

let temps = [];          // 즉석 카드 (세션 한정, 저장 안 함)
let _idSeq = 0;
const uid = () => 'c' + Date.now().toString(36) + (_idSeq++).toString(36);

/* ---------- 설정 / 상태 ---------- */
function settings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = {
            collapsed: false,
            wrapperPersist: DEFAULT_WRAPPER_PERSIST,
            wrapperOnce: DEFAULT_WRAPPER_ONCE,
            autoComplete: true,
            cards: DEFAULT_CARDS.map(c => ({ id: uid(), ...c })),
            activeByChat: {},
        };
    }
    const s = extension_settings[MODULE];
    s.wrapperPersist = s.wrapperPersist ?? DEFAULT_WRAPPER_PERSIST;
    s.wrapperOnce    = s.wrapperOnce ?? DEFAULT_WRAPPER_ONCE;
    s.autoComplete   = (s.autoComplete === undefined) ? true : s.autoComplete;
    s.cards          = Array.isArray(s.cards) ? s.cards : [];
    s.activeByChat   = s.activeByChat || {};
    s.cards.forEach(c => { if (!c.id) c.id = uid(); });
    return s;
}
const save = () => saveSettingsDebounced();

function chatKey() {
    const c = ctx();
    if (c?.chatId) return 'chat_' + c.chatId;
    if (c?.groupId) return 'group_' + c.groupId;
    if (c?.characterId !== undefined && c?.characterId !== null) return 'char_' + c.characterId;
    return 'default';
}
function getActive() {
    const s = settings();
    const k = chatKey();
    if (!s.activeByChat[k]) s.activeByChat[k] = [];
    return s.activeByChat[k];
}
function setActive(ids) { settings().activeByChat[chatKey()] = ids; save(); }

const allCards   = () => settings().cards.concat(temps);
const findCard   = (id) => allCards().find(c => c.id === id);
const activeCards = () => { const a = getActive(); return allCards().filter(c => a.includes(c.id)); };

/* ---------- 주입 텍스트 (모드별로 래퍼가 다름) ---------- */
const cardLine = (c) => '\n• ' + c.label + (c.prompt ? ' — ' + c.prompt : '');

function buildInjection() {
    const list = activeCards();
    if (!list.length) return null;
    const s = settings();
    const persistList = list.filter(c => c.persist);
    const onceList    = list.filter(c => !c.persist);
    const parts = [];

    if (persistList.length) {
        let block = (s.wrapperPersist || DEFAULT_WRAPPER_PERSIST).trim();
        if (s.autoComplete) block += '\n' + DONE_INSTR;
        persistList.forEach(c => block += cardLine(c));
        parts.push(block);
    }
    if (onceList.length) {
        let block = (s.wrapperOnce || DEFAULT_WRAPPER_ONCE).trim();
        onceList.forEach(c => block += cardLine(c));
        parts.push(block);
    }
    const out = parts.join('\n\n');
    try { return ctx().substituteParams ? ctx().substituteParams(out) : out; }
    catch (_) { return out; }
}

/* 카드 완료 처리: 활성 해제 + 즉석이면 제거 */
function completeCard(id) {
    setActive(getActive().filter(x => x !== id));
    if (temps.some(t => t.id === id)) temps = temps.filter(t => t.id !== id);
}

/* ===================================================================
 * 프롬프트 주입 — Chat Completion 직전에 system 메시지로 끼워넣는다.
 * dryRun(미리보기 빌드)이 아닐 때만 1회성 카드를 소비한다.
 * =================================================================== */
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
    try {
        const block = buildInjection();
        if (block) {
            eventData.chat.push({ role: 'system', content: block });
            console.log('[CueCard] injected:', activeCards().map(c => c.label).join(', '));
        }
        if (eventData.dryRun) return;
        // 1회성·즉석(비지속) 카드 소비 → 다음 턴엔 빠짐. 🔁지속은 유지.
        const onceIds = activeCards().filter(c => !c.persist).map(c => c.id);
        if (onceIds.length) {
            const remain = getActive().filter(id => !onceIds.includes(id));
            setActive(remain);
            temps = temps.filter(t => remain.includes(t.id));
            renderBar();
            refreshPanel();
        }
    } catch (e) { console.log('[CueCard] inject error:', e); }
});

/* 채팅 전환 시: 즉석 카드 초기화 + 바 갱신(활성 상태는 채팅별로 유지) */
eventSource.on(event_types.CHAT_CHANGED, () => {
    temps = [];
    pruneActive();
    renderBar();
    refreshPanel();
    renderManage();
});

function pruneActive() {
    const ids = new Set(allCards().map(c => c.id));
    const cleaned = getActive().filter(id => ids.has(id));
    if (cleaned.length !== getActive().length) setActive(cleaned);
}

/* ===================================================================
 * AI 자동 완료 — 응답에서 <cue_done>라벨</cue_done>을 파싱해
 * 해당 카드를 자동 해제(지속 끔 / 즉석 제거)하고 태그를 화면에서 지운다.
 * =================================================================== */
const DONE_RE = /<cue_done>\s*([\s\S]*?)\s*<\/cue_done>/gi;

eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    try {
        if (!settings().autoComplete) return;
        const c = ctx();
        const idx = (c.chat?.length || 0) - 1;
        const msg = c.chat?.[idx];
        if (!msg || msg.is_user) return;
        const text = msg.mes || '';
        if (!/<cue_done>/i.test(text)) return;

        const dones = [];
        let m; DONE_RE.lastIndex = 0;
        while ((m = DONE_RE.exec(text)) !== null) dones.push(m[1].trim().toLowerCase());

        // 라벨 매칭 → 완료 처리
        let changed = false;
        const active = getActive().slice();
        allCards().forEach(card => {
            if (!active.includes(card.id)) return;
            const cl = card.label.trim().toLowerCase();
            if (dones.some(d => d === cl || d.includes(cl) || cl.includes(d))) {
                completeCard(card.id);
                changed = true;
            }
        });

        // 태그를 본문에서 제거하고 메시지 재렌더
        const cleaned = text.replace(DONE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
        if (cleaned !== text) {
            msg.mes = cleaned;
            try { await updateMessageBlock(idx, msg); } catch (e) { console.log('[CueCard] re-render fail', e); }
            try { await c.saveChat?.(); } catch (e) { console.log('[CueCard] saveChat fail', e); }
        }
        if (changed) { renderBar(); refreshPanel(); toast('완료된 큐카드 자동 해제됨'); }
    } catch (e) { console.log('[CueCard] cue_done parse error:', e); }
});

/* ===================================================================
 * UI
 * =================================================================== */
const SKELETON = `
<div id="cc-root">
    <!-- 주입 보기 -->
    <div class="cc-panel" id="cc-panel"><div class="cc-inner">
      <div class="cc-phead"><h4>👁 이번 전송에 주입될 연출 지시 (사용자에게는 안 보임)</h4>
        <button class="cc-close" data-act="eye">✕ 닫기</button></div>
      <div id="cc-inj-body"><div class="cc-empty">활성화된 큐카드가 없습니다.</div></div>
    </div></div>
    <!-- 관리 -->
    <div class="cc-panel" id="cc-manage"><div class="cc-inner">
      <div class="cc-phead"><h4>⚙ 큐카드 관리 — 사전 등록 카드 편집</h4>
        <button class="cc-close" data-act="gear">✕ 닫기</button></div>
      <div id="cc-manage-list"></div>
      <button class="cc-btn" data-act="addblank">＋ 새 카드</button>
      <div style="margin-top:14px;border-top:1px dashed var(--SmartThemeBorderColor,#d9d9e0);padding-top:12px;">
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer;margin-bottom:12px;">
          <input type="checkbox" id="cc-autocomplete">
          <span><b>AI 자동 완료</b> <span style="opacity:.6;font-size:11px;">— AI가 목표 달성 시 <code>&lt;cue_done&gt;</code>로 신고하면 카드 자동 해제</span></span>
        </label>
        <span class="cc-mlabel">🔁 지속 카드 래퍼 <span style="opacity:.6;">— 여러 턴 빌드업</span></span>
        <textarea id="cc-wrap-persist" rows="3" style="width:100%;"></textarea>
        <button class="cc-btn" data-act="resetP" style="margin-top:4px;">기본값으로</button>
        <div style="height:10px;"></div>
        <span class="cc-mlabel">1회성 카드 래퍼 <span style="opacity:.6;">— 이번 응답에 즉시</span></span>
        <textarea id="cc-wrap-once" rows="2" style="width:100%;"></textarea>
        <button class="cc-btn" data-act="resetO" style="margin-top:4px;">기본값으로</button>
        <div class="cc-advnote">{{user}} {{char}} 매크로 사용 가능. 카드 라벨은 래퍼 아래 자동으로 붙습니다.
        자동 완료가 켜져 있으면 지속 래퍼에 완료 신고 규약이 자동으로 더해집니다.</div>
      </div>
    </div></div>
    <!-- 즉석 추가 -->
    <div class="cc-panel" id="cc-addform"><div class="cc-inner">
      <div class="cc-row">
        <div class="cc-f1"><span class="cc-mlabel">버튼 이름</span><input id="cc-new-label" placeholder="예: 비 내림"></div>
        <div class="cc-f2"><span class="cc-mlabel">숨겨진 지시 (선택)</span>
          <textarea id="cc-new-prompt" placeholder="비우면 라벨만 던져 AI가 알아서 — 권장"></textarea></div>
      </div>
      <button class="cc-btn primary" data-act="addtemp">이번만 추가</button>
      <button class="cc-btn" data-act="add">취소</button>
    </div></div>
    <!-- 버튼 바 (토글 + 카드 + 버튼이 한 줄) -->
    <div id="cc-bar">
      <span class="cc-toggle" id="cc-toggle" title="큐카드 접기/펴기">🎬<span class="cc-chev">▾</span><span class="cc-dot" id="cc-dot"></span></span>
      <span id="cc-cards"></span>
      <button class="cc-add cc-collapsible" data-act="add">＋ 즉석</button>
      <span class="cc-spacer cc-collapsible"></span>
      <span class="cc-count cc-collapsible" id="cc-count">활성 0</span>
      <button class="cc-iconbtn cc-collapsible" data-act="gear" id="cc-gear">⚙ 관리</button>
      <button class="cc-iconbtn cc-collapsible" data-act="eye" id="cc-eye">👁 주입 보기</button>
    </div>
</div>`;

function mount() {
    if (document.getElementById('cc-root')) return true;
    const form = document.getElementById('send_form');
    if (!form) return false;
    form.insertAdjacentHTML('beforebegin', SKELETON);
    bind();
    settings();
    if (settings().collapsed) document.getElementById('cc-bar').classList.add('collapsed');
    renderBar();
    renderManage();
    refreshPanel();
    return true;
}

/* 모든 핸들러는 위임(delegation)으로 한 번만 바인딩 → 재렌더에도 유지 */
function bind() {
    const root = document.getElementById('cc-root');

    root.addEventListener('click', (e) => {
        const cue = e.target.closest('.cc-cue');
        const x   = e.target.closest('.cc-x');
        const act = e.target.closest('[data-act]');

        if (x) { e.stopPropagation(); removeTemp(x.dataset.id); return; }
        if (cue) { toggleCue(cue.dataset.id); return; }
        if (!act) return;

        switch (act.dataset.act) {
            case 'eye':   togglePanel('cc-panel', 'cc-eye'); break;
            case 'gear':  togglePanel('cc-manage', 'cc-gear'); break;
            case 'add':   togglePanel('cc-addform', null); break;
            case 'addtemp':  addTemp(); break;
            case 'addblank': addBlank(); break;
            case 'resetP':
                settings().wrapperPersist = DEFAULT_WRAPPER_PERSIST;
                document.getElementById('cc-wrap-persist').value = DEFAULT_WRAPPER_PERSIST;
                save(); refreshPanel(); toast('지속 래퍼 기본값으로'); break;
            case 'resetO':
                settings().wrapperOnce = DEFAULT_WRAPPER_ONCE;
                document.getElementById('cc-wrap-once').value = DEFAULT_WRAPPER_ONCE;
                save(); refreshPanel(); toast('1회성 래퍼 기본값으로'); break;
            case 'mode': {
                const c = findCard(act.dataset.id);
                if (c) { c.persist = !c.persist; save(); renderManage(); renderBar(); refreshPanel(); }
                break;
            }
            case 'del': {
                const c = findCard(act.dataset.id);
                if (c && confirm(`"${c.label}" 카드를 삭제할까요?`)) {
                    const s = settings();
                    s.cards = s.cards.filter(x => x.id !== act.dataset.id);
                    setActive(getActive().filter(id => id !== act.dataset.id));
                    save(); renderManage(); renderBar(); refreshPanel();
                }
                break;
            }
        }
    });

    // 토글(접기/펴기) — 카드 클릭과 구분해 별도 바인딩
    document.getElementById('cc-toggle').addEventListener('click', toggleExt);

    // 관리 패널 입력 변경 위임
    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.id === 'cc-wrap-persist') { settings().wrapperPersist = t.value; save(); refreshPanel(); return; }
        if (t.id === 'cc-wrap-once')    { settings().wrapperOnce = t.value; save(); refreshPanel(); return; }
        if (t.id === 'cc-autocomplete') { settings().autoComplete = t.checked; save(); refreshPanel();
            toast(t.checked ? 'AI 자동 완료 ON' : 'AI 자동 완료 OFF'); return; }
        const row = t.closest('[data-field]');
        if (row) {
            const c = findCard(row.dataset.id);
            if (c) { c[row.dataset.field] = t.value; save(); renderBar(); refreshPanel(); }
        }
    });
}

function toggleCue(id) {
    const a = getActive();
    const turningOff = a.includes(id);
    setActive(turningOff ? a.filter(x => x !== id) : a.concat(id));
    // 즉석 카드를 끄면(=완료) 통째로 제거 — 비활성 상태로 덜렁 남지 않게
    if (turningOff && temps.some(t => t.id === id)) {
        temps = temps.filter(t => t.id !== id);
    }
    renderBar(); refreshPanel();
}
function removeTemp(id) {
    // ✕ 명시적 삭제만 확인받음 (완료로 사라지는 건 안 물어봄)
    const c = temps.find(t => t.id === id);
    if (c && !confirm(`즉석 카드 "${c.label}"을(를) 삭제할까요?`)) return;
    temps = temps.filter(t => t.id !== id);
    setActive(getActive().filter(x => x !== id));
    renderBar(); refreshPanel();
}
function addTemp() {
    const label = document.getElementById('cc-new-label').value.trim();
    if (!label) { toast('이름을 입력하세요'); return; }
    const prompt = document.getElementById('cc-new-prompt').value.trim();
    // 즉석 카드는 지속(🔁) — 완료될 때까지 매 턴 재주입, 끄면 사라짐
    const c = { id: uid(), label, prompt, persist: true, temp: true };
    temps.push(c);
    setActive(getActive().concat(c.id));
    document.getElementById('cc-new-label').value = '';
    document.getElementById('cc-new-prompt').value = '';
    togglePanel('cc-addform', null);
    renderBar(); refreshPanel();
}
function addBlank() {
    settings().cards.push({ id: uid(), label: '새 카드', persist: false, prompt: '' });
    save(); renderManage(); renderBar();
}

function togglePanel(panelId, btnId) {
    // 패널은 한 번에 하나만 펼침
    ['cc-panel', 'cc-manage', 'cc-addform'].forEach(p => {
        if (p !== panelId) document.getElementById(p)?.classList.remove('open');
    });
    ['cc-eye', 'cc-gear'].forEach(b => document.getElementById(b)?.classList.remove('on'));
    const panel = document.getElementById(panelId);
    const open = panel.classList.toggle('open');
    if (btnId && open) document.getElementById(btnId).classList.add('on');
    if (panelId === 'cc-panel') refreshPanel();
    if (panelId === 'cc-manage' && open) {
        renderManage();
        const s = settings();
        document.getElementById('cc-wrap-persist').value = s.wrapperPersist || '';
        document.getElementById('cc-wrap-once').value = s.wrapperOnce || '';
        document.getElementById('cc-autocomplete').checked = !!s.autoComplete;
    }
}
function toggleExt() {
    const bar = document.getElementById('cc-bar');
    const collapsed = bar.classList.toggle('collapsed');
    settings().collapsed = collapsed; save();
    updateDot();
}
function updateDot() {
    const bar = document.getElementById('cc-bar');
    const dot = document.getElementById('cc-dot');
    if (!bar || !dot) return;
    const n = getActive().length;
    dot.textContent = (bar.classList.contains('collapsed') && n) ? ' ●' + n : '';
}

/* ---------- 렌더 ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderBar() {
    const box = document.getElementById('cc-cards');
    if (!box) return;
    const a = getActive();
    box.innerHTML = allCards().map(c => {
        const on = a.includes(c.id);
        const cls = 'cc-cue' + (c.temp ? ' temp' : '') + (c.persist ? ' persist' : '') + (on ? ' active' : '');
        const pin = c.persist ? '<span class="cc-pin">🔁</span>' : '';
        const x   = c.temp ? ` <span class="cc-x" data-id="${c.id}">✕</span>` : '';
        return `<button class="${cls}" data-id="${c.id}">${pin}${esc(c.label)}${x}</button>`;
    }).join('');
    const cnt = document.getElementById('cc-count');
    if (cnt) cnt.textContent = '활성 ' + a.length;
    updateDot();
}

function refreshPanel() {
    const body = document.getElementById('cc-inj-body');
    if (!body) return;
    const inj = buildInjection();
    if (!inj) { body.innerHTML = '<div class="cc-empty">활성화된 큐카드가 없습니다.</div>'; return; }
    const html = esc(inj).replace(/^•\s([^\n—]+?)(\s—|$)/gm, '• <span class="cc-lbl">$1</span>$2');
    body.innerHTML = '<div class="cc-inj">' + html + '</div>';
}

function renderManage() {
    const box = document.getElementById('cc-manage-list');
    if (!box) return;
    box.innerHTML = settings().cards.map(c => `
      <div class="cc-mrow">
        <div class="cc-ml"><span class="cc-mlabel">이름</span>
          <input data-id="${c.id}" data-field="label" value="${esc(c.label)}"></div>
        <div class="cc-mp"><span class="cc-mlabel">숨겨진 지시 (선택 · 비우면 라벨만)</span>
          <textarea data-id="${c.id}" data-field="prompt" placeholder="비워두면 라벨만 던져 AI가 알아서 — 권장">${esc(c.prompt || '')}</textarea></div>
        <div><span class="cc-mlabel">모드</span>
          <div class="cc-mode ${c.persist ? 'persist' : 'once'}" data-act="mode" data-id="${c.id}">${c.persist ? '🔁 지속' : '1회성'}</div></div>
        <button class="cc-del" title="삭제" data-act="del" data-id="${c.id}">🗑</button>
      </div>`).join('');
}

function toast(msg) { try { toastr.info(msg, '큐카드'); } catch (_) {} }

/* ===================================================================
 * 설정 드로어 (확장 설정 패널 안)
 * =================================================================== */
function addSettingsDrawer() {
    if (document.getElementById('cc-settings-drawer')) return;
    const html = `
    <div id="cc-settings-drawer" class="cue-card-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>🎬 큐카드 (Cue Card)</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <p style="opacity:.7;margin:8px 0;">채팅 입력창 위에 연출 지시 버튼을 띄웁니다. 버튼 클릭 → 전송하면
          숨겨진 지시가 프롬프트에 주입돼, AI가 여러 턴에 걸쳐 자연스럽게 유도합니다.</p>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:10px 0;">
            <input type="checkbox" id="cc-show-bar" checked>
            <span><b>입력창 위 버튼 바 표시</b></span>
          </label>
          <small style="opacity:.6;">카드 추가/편집은 버튼 바의 <b>⚙ 관리</b>에서. 끄면 바 전체가 숨겨집니다.</small>
        </div>
      </div>
    </div>`;
    $('#extensions_settings').append(html);
    $('#cc-show-bar').on('change', function () {
        const root = document.getElementById('cc-root');
        if (root) root.style.display = this.checked ? '' : 'none';
    });
}

/* ===================================================================
 * 부팅
 * =================================================================== */
jQuery(() => {
    settings();
    addSettingsDrawer();
    let tries = 0;
    const t = setInterval(() => {
        if (mount() || ++tries > 40) clearInterval(t);
    }, 500);
    console.log('[CueCard] v1.0.0 loaded');
});
