/* ===================================================================
 * 큐카드 (Cue Card) — SillyTavern 확장  v1.1.0
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
 *
 * v1.1 — 로어북 연동 자동 큐:
 *  · 로어북을 카드 창고로 연결. 엔트리 제목 "폴더 · 카드이름" 접두사가 폴더.
 *  · 상시 폴더(기본: 일상)는 매 턴 통째로 주입, 판정 대상 아님.
 *  · 나머지 폴더는 전송 순간 미니 판정(2단: 폴더→카드)으로 자동 점등/소등.
 *  · 엔트리 본문 맨 앞 [상황: …] 한 줄 = 판정용 큐, 그 아래 = 주입 지침.
 *  · 판정은 현재 RP와 같은 연결로 나감(모델만 설정에서 교체 가능).
 * =================================================================== */

import { eventSource, event_types, saveSettingsDebounced, updateMessageBlock, getRequestHeaders } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { loadWorldInfo, saveWorldInfo, world_names } from '../../../world-info.js';
import { oai_settings, getChatCompletionModel } from '../../../openai.js';
import { ConnectionManagerRequestService } from '../../shared.js';

const MODULE = 'cueCard';
const VERSION = '1.1.0';
const ctx = () => SillyTavern.getContext();

// 🔁 지속 카드 — 여러 턴에 걸쳐 무르익히는 빌드업용 래퍼
const DEFAULT_WRAPPER_PERSIST =
  "[Director's note — invisible to {{user}}. Steer the story toward the goals below, naturally and gradually across multiple turns. Build them up; never force or rush.]";
// 1회성 카드 — 이번 응답에 즉시 반영하는 래퍼
const DEFAULT_WRAPPER_ONCE =
  "[Director's note — invisible to {{user}}. Work the following into THIS reply, right now, naturally. Do not drag it out.]";
// 로어북 가이드 — 상시 + 자동 점등 카드 본문 앞에 붙는 래퍼
const DEFAULT_WRAPPER_GUIDE =
  "[Scene craft guides — invisible to {{user}}. Where the current scene fits, write it following this guidance:]";
// AI 자동 완료: 지속 카드 블록 끝에 붙는 완료 신호 규약
const DONE_INSTR =
  "When a goal above is fully realized in the story, append <cue_done>exact goal label</cue_done> at the very end of your reply (hidden meta — never mention it in prose).";

const DEFAULT_CARDS = [
    { label: '며칠 뒤', persist: false, prompt: '며칠 뒤의 새로운 에피소드로 바꿔줘' },
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
    // v1.1 로어북 연동 (큐로어)
    s.lorebook       = s.lorebook ?? '';
    s.alwaysFolders  = s.alwaysFolders ?? '';
    s.anchorText     = s.anchorText ?? '<cue_lore>';
    // v1.2 마이그레이션: 일상도 상시가 아니라 판정 대상 (싸움·데이트·취기·질투 등 상황이 제각각)
    if (!s._migrNoAlways) { s.alwaysFolders = ''; s._migrNoAlways = true; }
    // v1.2.1 마이그레이션: 전용 앵커 프롬프트(🎬 Cue Lore, 꿈결 프리셋)로 교체
    if (!s._migrCueAnchor) { s.anchorText = '<cue_lore>'; s._migrCueAnchor = true; }
    s.judgeEnabled   = (s.judgeEnabled === undefined) ? true : s.judgeEnabled;
    s.judgeModel     = s.judgeModel ?? '';
    s.judgeProfile   = s.judgeProfile ?? '';
    s.wrapperGuide   = s.wrapperGuide ?? DEFAULT_WRAPPER_GUIDE;
    s.sceneByChat    = s.sceneByChat || {};
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

/* ===================================================================
 * v1.1 — 로어북 카드 창고
 * =================================================================== */
let lore = { name: '', entries: [] }; // entry: {uid, folder, title, situation, body, constant}

function parseComment(comment) {
    const t = String(comment || '').trim();
    const i = t.indexOf('·');
    if (i === -1) return { folder: '기타', title: t || '(무제)' };
    return { folder: t.slice(0, i).trim() || '기타', title: t.slice(i + 1).trim() || '(무제)' };
}
/* 엔트리 본문 앞머리 두 줄을 벗겨낸다.
 *   [상황: …]  = 사용자가 읽는 한글 설명
 *   [cue: …]   = 판정에 실제로 보내는 영어 큐 (없으면 상황줄로 대체)
 * 둘 다 주입에서는 빠지고, 본문(영어 지침)만 <cue_lore>에 들어간다. */
function parseContent(content) {
    let rest = String(content || '');
    let situation = '', cue = '';
    for (let i = 0; i < 2; i++) {
        const m = rest.match(/^\s*\[\s*(상황|cue)\s*:?\s*([^\]]*?)\]\s*/i);
        if (!m) break;
        if (m[1] === '상황') situation = m[2].trim();
        else cue = m[2].trim();
        rest = rest.slice(m[0].length);
    }
    return { situation, cue, body: rest.trim() };
}

/* 상황·큐·본문을 다시 엔트리 본문으로 조립 */
function buildContent(situation, cue, body) {
    let head = '';
    if (situation) head += `[상황: ${situation}]\n`;
    if (cue) head += `[cue: ${cue}]\n`;
    return (head ? head + '\n' : '') + String(body || '').trim();
}

async function loadLore(silent) {
    const s = settings();
    const name = s.lorebook;
    lore = { name: '', entries: [] };
    if (name) {
        try {
            const data = await loadWorldInfo(name);
            const entries = Object.values(data?.entries || {});
            lore.name = name;
            lore.entries = entries
                .filter(e => !e.disable)
                .map(e => {
                    const { folder, title } = parseComment(e.comment);
                    const { situation, cue, body } = parseContent(e.content);
                    return { uid: String(e.uid), folder, title, situation, cue, body, constant: !!e.constant };
                })
                .filter(e => e.body);
            if (!silent) toast(`로어북 "${name}" — 카드 ${lore.entries.length}개 로드`);
        } catch (e) {
            console.log('[CueCard] lorebook load fail:', e);
            if (!silent) toast('로어북 로드 실패: ' + name);
        }
    }
    pruneScene();
    renderBar(); refreshPanel(); renderLorePanel(null);
}

const alwaysFolderList = () => String(settings().alwaysFolders || '').split(',').map(x => x.trim()).filter(Boolean);
const isAlways = (e) => e.constant || alwaysFolderList().includes(e.folder);

function situFolders() { // 판정 대상 폴더맵 {name: [entries]}
    const map = {};
    lore.entries.filter(e => !isAlways(e)).forEach(e => { (map[e.folder] = map[e.folder] || []).push(e); });
    return map;
}

/* 장면 상태 — 채팅별, 점등된 로어카드 uid 집합 */
function scene() {
    const s = settings(); const k = chatKey();
    if (!s.sceneByChat[k]) s.sceneByChat[k] = { cards: {} };
    if (!s.sceneByChat[k].cards) s.sceneByChat[k].cards = {};
    return s.sceneByChat[k];
}
const activeLoreCards = () => lore.entries.filter(e => !isAlways(e) && scene().cards[e.uid]);
const activeFolderNames = () => [...new Set(activeLoreCards().map(e => e.folder))];
function pruneScene() {
    const ids = new Set(lore.entries.map(e => e.uid));
    const st = scene();
    Object.keys(st.cards).forEach(k => { if (!ids.has(k)) delete st.cards[k]; });
}

/* 이름 느슨 매칭 (이모지·공백·기호 무시) */
const norm = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function matchName(list, name, get) {
    const n = norm(name);
    if (!n) return undefined;
    return list.find(x => { const t = norm(get(x)); return t === n || t.includes(n) || n.includes(t); });
}

/* ---------- 주입 텍스트 ---------- */
const cardLine = (c) => '\n• ' + c.label + (c.prompt ? ' — ' + c.prompt : '');

function buildGuideBlock() {
    if (!lore.entries.length) return null;
    const list = lore.entries.filter(isAlways).concat(activeLoreCards());
    if (!list.length) return null;
    const s = settings();
    let block = (s.wrapperGuide || DEFAULT_WRAPPER_GUIDE).trim();
    list.forEach(e => { block += '\n\n' + e.body; });
    return block;
}

function buildInjection() {
    const list = activeCards();
    const s = settings();
    const parts = [];

    const persistList = list.filter(c => c.persist);
    const onceList    = list.filter(c => !c.persist);

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
    if (!parts.length) return null;
    const out = parts.join('\n\n');
    return sub(out);
}

function sub(text) {
    try { return ctx().substituteParams ? ctx().substituteParams(text) : text; }
    catch (_) { return text; }
}

/* 큐로어 주입 — 앵커(기본: 폰인젝트) 메시지 바로 아래에 끼워넣는다 */
const msgText = (m) => typeof m?.content === 'string' ? m.content
    : Array.isArray(m?.content) ? m.content.map(p => p?.text || '').join('') : '';

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function insertGuide(eventData) {
    const guide = buildGuideBlock();
    if (!guide) return;
    const content = sub(guide);
    const anchor = (settings().anchorText || '').trim();
    if (anchor) {
        const idx = eventData.chat.findIndex(m => msgText(m).includes(anchor));
        if (idx >= 0) {
            const m = eventData.chat[idx];
            // 앵커가 <tag> 형태면 폰인젝트처럼 태그 "안"에 채워 넣는다
            const tag = anchor.match(/^<([\w-]+)>$/);
            if (tag && typeof m.content === 'string') {
                const close = '</' + tag[1] + '>';
                const re = new RegExp(reEsc(anchor) + '\\s*' + reEsc(close));
                if (re.test(m.content)) {
                    m.content = m.content.replace(re, anchor + '\n' + content + '\n' + close);
                    return;
                }
            }
            // 태그 짝이 없으면 그 메시지 바로 아래에
            eventData.chat.splice(idx + 1, 0, { role: 'user', content });
            return;
        }
    }
    eventData.chat.push({ role: 'user', content });
}

/* 카드 완료 처리: 활성 해제 + 즉석이면 제거 */
function completeCard(id) {
    setActive(getActive().filter(x => x !== id));
    if (temps.some(t => t.id === id)) temps = temps.filter(t => t.id !== id);
}

/* ===================================================================
 * v1.1 — 자동 큐 판정 (전송 순간, 2단: 폴더 → 카드)
 * =================================================================== */
const JUDGE_TIMEOUT = 8000;

const judgeProfiles = () => (extension_settings.connectionManager?.profiles || []).filter(p => p?.id && p?.name);

async function callLLM(messages, maxTokens) {
    const s = settings();

    // 연결 프로필 지정 시 — 프로필 라우팅 (API·모델·프록시 전부 프로필 따라감)
    if (s.judgeProfile) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT);
        try {
            const res = await ConnectionManagerRequestService.sendRequest(
                s.judgeProfile, messages, maxTokens || 400,
                { stream: false, signal: controller.signal, extractData: true, includePreset: false, includeInstruct: false },
                { temperature: 0 },
            );
            return String(res?.content || '');
        } finally { clearTimeout(timer); }
    }

    const src = oai_settings.chat_completion_source;
    let model = (s.judgeModel || '').trim();
    if (!model) { try { model = getChatCompletionModel(); } catch (_) { model = ''; } }
    const body = {
        chat_completion_source: src,
        model,
        messages,
        max_tokens: maxTokens || 400,
        temperature: 0,
        stream: false,
    };
    if (src === 'custom') {
        body.custom_url = oai_settings.custom_url;
        body.custom_include_body = oai_settings.custom_include_body;
        body.custom_exclude_body = oai_settings.custom_exclude_body;
        body.custom_include_headers = oai_settings.custom_include_headers;
    }
    if (src === 'makersuite' || src === 'vertexai') {
        body.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
        body.vertexai_region = oai_settings.vertexai_region;
        body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
    }
    if (oai_settings.reverse_proxy) {
        body.reverse_proxy = oai_settings.reverse_proxy;
        body.proxy_password = oai_settings.proxy_password;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT);
    try {
        const res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) { console.log('[CueCard] judge http', res.status, data); return ''; }
        let out = data?.choices?.[0]?.message?.content
            ?? data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('')
            ?? data?.text ?? '';
        if (Array.isArray(out)) out = out.map(p => p?.text || '').join('');
        return String(out || '');
    } finally { clearTimeout(timer); }
}

function extractJson(raw) {
    if (!raw) return null;
    const t = String(raw).replace(/```(?:json)?/gi, '').trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function recentExchange(overrideUserText) {
    const c = ctx();
    const msgs = (c.chat || []).filter(m => !m.is_system);
    const lastAi = [...msgs].reverse().find(m => !m.is_user);
    const aiTail = lastAi ? String(lastAi.mes || '').slice(-1500) : '';
    let userText = overrideUserText;
    if (userText === undefined) {
        const last = msgs[msgs.length - 1];
        userText = (last && last.is_user) ? String(last.mes || '') : '';
    }
    return { aiTail, userText: String(userText || '').slice(0, 1000) };
}

const JUDGE_SYS =
    'You are a scene-state tracker for an ongoing roleplay chat. Decide which scene-guide cards apply RIGHT NOW. ' +
    'The user\'s latest input is decisive — if the user steers away from where the story was heading, follow the user. ' +
    'A card is lit only while its situation is ACTUALLY happening or clearly beginning in the scene right now. ' +
    'A mere mention, a similar mood, or something that might happen soon is NOT enough — when unsure, do not light it. ' +
    'A lit card stays lit while its situation continues; it goes dark when the situation has clearly ended or the user rejects that direction. ' +
    'Several cards may be lit at once when their situations genuinely co-occur, and lighting NONE is a perfectly good answer. ' +
    'Respond with ONLY compact JSON. No prose, no code fences.';

function setFolderCards(folderName, entries, titles) {
    const st = scene();
    entries.forEach(e => delete st.cards[e.uid]);
    (titles || []).slice(0, 3).forEach(t => {
        const hit = matchName(entries, t, e => e.title);
        if (hit) st.cards[hit.uid] = true;
    });
}

async function judgeFlow(overrideUserText) {
    const s = settings();
    if (!s.judgeEnabled || !lore.entries.length) return;
    const folders = situFolders();
    const names = Object.keys(folders);
    if (!names.length) return;

    const { aiTail, userText } = recentExchange(overrideUserText);
    const before = activeLoreCards().map(e => e.title);

    // 전체 카드의 상황줄을 다 실어 한 번에 판정 — 해당 없음·복수 해당 모두 허용
    // 판정에는 영어 큐를 보낸다 (없는 카드만 한글 상황줄로 폴백). 큐는 CUE_MAX 안에서 생성됨.
    const cardLines = names.map(n => folders[n].map(e =>
        `- [${n}] ${e.title}: ${(e.cue || e.situation || '').slice(0, CUE_MAX) || '(no cue)'}`).join('\n')).join('\n');
    const litNow = activeLoreCards().map(e => `[${e.folder}] ${e.title}`).join(', ') || 'none';
    const user =
`Scene-guide cards (each line: [folder] title: WHEN it applies):
${cardLines}

Currently lit: ${litNow}

Latest exchange:
[Assistant's last reply (tail)]: ${aiTail || '(none)'}
[User's new input]: ${userText || '(empty — user just continues)'}

Decide which cards should be lit RIGHT NOW, judging strictly by each card's WHEN description.
Output JSON — the FULL desired lit state (not a diff):
{"cards":{"folder":["card title", ...]}}
Use {"cards":{}} when nothing truly applies. Only use folder and card names listed above.`;
    const raw = await callLLM([{ role: 'system', content: JUDGE_SYS }, { role: 'user', content: user }], 400);
    const j = extractJson(raw);
    if (!j || typeof j !== 'object' || !j.cards || typeof j.cards !== 'object') return;

    // 전체 상태 선언형 적용 — 결과에 없는 폴더는 소등
    names.forEach(n => {
        const key = matchName(Object.keys(j.cards), n, x => x);
        const titles = (key && Array.isArray(j.cards[key])) ? j.cards[key] : [];
        setFolderCards(n, folders[n], titles);
    });
    save();

    const after = activeLoreCards().map(e => e.title);
    const added = after.filter(x => !before.includes(x));
    const removed = before.filter(x => !after.includes(x));
    if (added.length || removed.length) {
        // 알림 팝업은 안 띄움(사용자 요청) — 바 칩 점등/소등으로만 표시
        console.log('[CueCard] auto-cue:', { on: added, off: removed });
    }
    renderBar(); refreshPanel(); renderLorePanel(null);
}

/* ===================================================================
 * v1.1 — ✨ 제목·상황줄 자동 작성
 * 지침 본문만 있는 엔트리를 읽고, 판정하기 좋은 "폴더 · 제목"과
 * [상황: …] 큐 문단을 AI가 써서 로어북에 저장해 준다.
 * (이미 갖춰진 엔트리는 건드리지 않음 — 빠진 부분만 채움)
 * =================================================================== */
const META_SYS =
    'You label scene-guide cards for a roleplay prompt system. Read the guide text and produce Korean labels. ' +
    'Respond with ONLY compact JSON. No prose, no code fences.';

// 한글 본문 → 영어 지침 변환 (주입은 영어로, 사용자가 읽는 제목·상황줄은 한글 유지)
const TRANS_SYS =
    'You translate roleplay scene-writing guides into English for an AI storyteller. ' +
    'Keep every instruction and nuance faithfully; do not add new rules or soften anything. ' +
    'Write natural, directive prose. Respond with ONLY the translated guide text — no preamble, no quotes, no code fences.';

// 판정용 영어 큐 작성 — 판정 페이로드에 통째로 실리도록 길이를 처음부터 제한한다
const CUE_MAX = 220;
const CUE_SYS =
    'You write short scene-matching cues for a roleplay prompt system. ' +
    'A cue lists the concrete markers that tell a judge model this situation is happening RIGHT NOW — ' +
    'actions, objects, moments that would appear in the conversation itself. ' +
    'Never explain the guide or give writing advice. Keep it under the character limit you are given. ' +
    'Respond with ONLY the cue line — no preamble, no quotes, no code fences.';

/* 큐를 한 줄로 정리하고 한도 안으로 자른다 (문장 경계 우선) */
function fitCue(t) {
    const s = String(t || '').trim().replace(/[[\]]/g, '').replace(/\s*\n+\s*/g, ' ');
    if (s.length <= CUE_MAX) return s;
    const cut = s.slice(0, CUE_MAX);
    const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '));
    return (dot > CUE_MAX * 0.5 ? cut.slice(0, dot + 1) : cut).trim();
}

const koCount = (t) => (String(t).match(/[가-힣]/g) || []).length;
const enCount = (t) => (String(t).match(/[A-Za-z]/g) || []).length;
const isKoreanBody = (t) => koCount(t) > enCount(t);

async function writeMetaFor(rawComment, body, folderNames) {
    const user =
`Read this roleplay scene-guide text and write, in KOREAN:
- "folder": one short word for the broad scene category. Reuse one of the existing folders if it fits: [${folderNames.join(', ') || 'none yet'}]. Otherwise coin a new 1-2 word Korean name.
- "title": a short evocative card name, 2-6 Korean words. May start with exactly one fitting emoji.
- "situation": 2-4 Korean sentences, third person, describing concretely WHEN this guide applies in a roleplay — the actions, moments, moods that mark the situation actually happening. Pack it with concrete verbs and nouns; a judge model will match this text against live conversation. Do not use the characters ] or newline inside it.

Existing entry title (may be empty or partial): "${rawComment || ''}"

Guide text:
${body.slice(0, 3000)}

JSON: {"folder":"...","title":"...","situation":"..."}`;
    const raw = await callLLM([{ role: 'system', content: META_SYS }, { role: 'user', content: user }], 500);
    const j = extractJson(raw);
    if (!j || !j.title || !j.situation) return null;
    return {
        folder: String(j.folder || '기타').trim().replace(/·/g, ''),
        title: String(j.title).trim().replace(/·/g, ''),
        situation: String(j.situation).trim().replace(/[\[\]]/g, '').replace(/\n+/g, ' '),
    };
}

async function writeCueFor(situation, body) {
    const user =
`${situation ? `Korean version of this cue (match its scope and brevity):\n${situation}\n\n` : ''}Guide text:
${String(body || '').slice(0, 2000)}

Write the English cue line for this guide: a comma-separated run of the concrete scene markers that mean this situation is actually happening now.
HARD LIMIT: at most 200 characters — the line is sent whole to the judge and anything past ${CUE_MAX} is discarded, so keep it tight.
Markers only. No writing advice, no "This guide applies when...", no line breaks, never the "]" character.`;
    const raw = await callLLM([{ role: 'system', content: CUE_SYS }, { role: 'user', content: user }], 200);
    return fitCue(raw);
}

async function autoWriteMeta() {
    const s = settings();
    if (!s.lorebook) { toast('로어북을 먼저 연결하세요'); return; }
    const data = await loadWorldInfo(s.lorebook);
    if (!data?.entries) { toast('로어북을 읽지 못했습니다'); return; }

    const jobs = Object.values(data.entries).filter(e => {
        const content = String(e.content || '');
        if (e.disable || !content.trim()) return false;
        const hasPrefix = String(e.comment || '').includes('·');
        const p = parseContent(content);
        // 큐가 없거나, 한도를 넘어 잘려나갈 만큼 길면 다시 뽑는다
        return !hasPrefix || !p.situation || !p.cue || p.cue.length > CUE_MAX || isKoreanBody(p.body);
    });
    if (!jobs.length) { toast('손볼 엔트리가 없습니다 (제목·상황·큐 완비 + 본문 영어)'); return; }
    if (!confirm(`엔트리 ${jobs.length}개를 AI가 손봅니다:\n· "폴더 · 제목"과 [상황: …] — 한글 (네가 읽는 것)\n· [cue: …] — 영어 ${CUE_MAX}자 이내 (판정에 보내는 것)\n· 한글 본문 — 영어 지침으로 번역 (주입되는 것)\n진행할까요?`)) return;

    const folderNames = [...new Set(Object.values(data.entries)
        .map(e => parseComment(e.comment).folder).filter(f => f !== '기타'))];

    let done = 0, fail = 0;
    for (const e of jobs) {
        toast(`✨ 작성 중… ${done + fail + 1}/${jobs.length}`);
        try {
            const hasPrefix = String(e.comment || '').includes('·');
            let { situation, cue, body } = parseContent(e.content);
            let touched = false;

            // ① 제목·상황줄 (한글)
            if (!hasPrefix || !situation) {
                const meta = await writeMetaFor(e.comment, body, folderNames);
                if (meta) {
                    if (!hasPrefix) {
                        e.comment = `${meta.folder} · ${meta.title}`;
                        if (!folderNames.includes(meta.folder)) folderNames.push(meta.folder);
                    }
                    if (!situation) situation = meta.situation;
                    touched = true;
                }
            }
            // ② 한글 본문 → 영어 지침 (주입되는 것)
            if (body && isKoreanBody(body)) {
                const eng = String(await callLLM([
                    { role: 'system', content: TRANS_SYS },
                    { role: 'user', content: 'Translate this Korean scene-writing guide into English:\n\n' + body.slice(0, 4000) },
                ], 1200) || '').trim();
                if (eng && !isKoreanBody(eng)) { body = eng; touched = true; }
            }
            // ③ 영어 큐 (판정에 보내는 것) — 없거나 한도를 넘으면 다시 뽑는다
            if (!cue || cue.length > CUE_MAX) {
                const c = await writeCueFor(situation, body);
                if (c && !isKoreanBody(c)) { cue = c; touched = true; }
                else if (cue.length > CUE_MAX) { cue = fitCue(cue); touched = true; }
            }

            if (touched) { e.content = buildContent(situation, cue, body); e.addMemo = true; done++; }
            else fail++;
        } catch (err) { console.log('[CueCard] meta write fail:', err); fail++; }
    }
    if (done) await saveWorldInfo(s.lorebook, data, true);
    toast(`✨ 완료 — ${done}개 작성${fail ? `, ${fail}개 실패` : ''}`);
    await loadLore(true);
    renderBar(); refreshPanel();
}

/* ===================================================================
 * 프롬프트 주입 — Chat Completion 직전에 system 메시지로 끼워넣는다.
 * 판정은 전송 순간 딱 1회 — 실제로 보낸 입력 기준으로 돌고, 그 결과로 주입.
 * dryRun(미리보기 빌드)이 아닐 때는 판정·1회성 카드 소비를 하지 않는다.
 * =================================================================== */
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (eventData) => {
    try {
        if (!eventData.dryRun && settings().judgeEnabled && lore.entries.length) {
            try { await judgeFlow(); }
            catch (e) { console.log('[CueCard] judge error:', e); }
        }
        insertGuide(eventData);
        const block = buildInjection();
        if (block) eventData.chat.push({ role: 'system', content: block });
        const litLore = lore.entries.filter(isAlways).concat(activeLoreCards()).map(c => c.title);
        if (block || litLore.length) {
            console.log('[CueCard] injected:', activeCards().map(c => c.label).concat(litLore).join(', '));
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
    pruneScene();
    renderBar();
    refreshPanel();
    renderManage();
    renderLorePanel(null);
});

/* 로어북이 편집되면 자동 리로드 */
eventSource.on(event_types.WORLDINFO_UPDATED, (name) => {
    if (name && name === settings().lorebook) loadLore(true);
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
    <!-- 로어북 폴더 카드 -->
    <div class="cc-panel" id="cc-lorepanel"><div class="cc-inner" id="cc-lorepanel-body"></div></div>
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
      <span id="cc-lore" class="cc-collapsible"></span>
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
        const lc  = e.target.closest('.cc-lorecue');
        const fd  = e.target.closest('.cc-folder');
        const cue = e.target.closest('.cc-cue:not(.cc-lorecue)');
        const x   = e.target.closest('.cc-x');
        const act = e.target.closest('[data-act]');

        if (x) { e.stopPropagation(); removeTemp(x.dataset.id); return; }
        if (lc) { toggleLoreCard(lc.dataset.uid); return; }
        if (fd) { openLorePanel(fd.dataset.folder); return; }
        if (cue) { toggleCue(cue.dataset.id); return; }
        if (!act) return;

        switch (act.dataset.act) {
            case 'eye':   togglePanel('cc-panel', 'cc-eye'); break;
            case 'gear':  togglePanel('cc-manage', 'cc-gear'); break;
            case 'add':   togglePanel('cc-addform', null); break;
            case 'addtemp':  addTemp(); break;
            case 'addblank': addBlank(); break;
            case 'lorepanel': togglePanel('cc-lorepanel', null); break;
            case 'foldoff': {
                const folders = situFolders();
                const entries = folders[act.dataset.folder] || [];
                setFolderCards(act.dataset.folder, entries, []);
                save(); renderBar(); refreshPanel(); renderLorePanel(act.dataset.folder);
                break;
            }
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
function toggleLoreCard(uidStr) {
    const st = scene();
    if (st.cards[uidStr]) delete st.cards[uidStr];
    else st.cards[uidStr] = true;
    save(); renderBar(); refreshPanel(); renderLorePanel(null);
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
    ['cc-panel', 'cc-manage', 'cc-addform', 'cc-lorepanel'].forEach(p => {
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
    const n = getActive().length + activeLoreCards().length;
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

    // 로어북 폴더 칩 + 점등 카드 칩
    const lbox = document.getElementById('cc-lore');
    if (lbox) {
        const folders = situFolders();
        const st = scene();
        lbox.innerHTML = Object.keys(folders).map(name => {
            const lit = folders[name].filter(e => st.cards[e.uid]);
            const on = lit.length > 0;
            const chips = lit.map(e =>
                `<button class="cc-cue cc-lorecue active" data-uid="${e.uid}" title="탭하면 소등">${esc(e.title)}</button>`).join('');
            return `<button class="cc-folder${on ? ' on' : ''}" data-folder="${esc(name)}" title="폴더 카드 보기">📁 ${esc(name)}${on ? ' ' + lit.length : ''}</button>${chips}`;
        }).join('');
    }

    const cnt = document.getElementById('cc-count');
    if (cnt) cnt.textContent = '활성 ' + (a.length + activeLoreCards().length);
    updateDot();
}

let lorePanelFolder = null;
function openLorePanel(folderName) {
    lorePanelFolder = folderName;
    renderLorePanel(folderName);
    togglePanel('cc-lorepanel', null);
}
function renderLorePanel(folderName) {
    const body = document.getElementById('cc-lorepanel-body');
    if (!body) return;
    const name = folderName || lorePanelFolder;
    if (!name) { body.innerHTML = '<div class="cc-empty">폴더를 선택하세요.</div>'; return; }
    const folders = situFolders();
    const entries = folders[name] || [];
    const st = scene();
    const rows = entries.map(e => {
        const on = !!st.cards[e.uid];
        return `<div class="cc-lorerow">
          <button class="cc-cue cc-lorecue${on ? ' active' : ''}" data-uid="${e.uid}">${esc(e.title)}</button>
          <span class="cc-loresitu">${esc((e.situation || e.cue || '').slice(0, 90))}</span>
        </div>`;
    }).join('');
    body.innerHTML = `
      <div class="cc-phead"><h4>📁 ${esc(name)} — 탭해서 점등/소등 (자동 판정이 관리, 수동은 오버라이드)</h4>
        <button class="cc-close" data-act="lorepanel">✕ 닫기</button></div>
      ${rows || '<div class="cc-empty">카드 없음</div>'}
      <button class="cc-btn" data-act="foldoff" data-folder="${esc(name)}" style="margin-top:8px;">이 폴더 모두 끄기</button>`;
}

function refreshPanel() {
    const body = document.getElementById('cc-inj-body');
    if (!body) return;
    const guide = buildGuideBlock();
    const inj = buildInjection();
    if (!guide && !inj) { body.innerHTML = '<div class="cc-empty">활성화된 큐카드가 없습니다.</div>'; return; }
    let html = '';
    if (guide) html += '<div class="cc-mlabel" style="margin-bottom:3px;">📚 큐로어 — 앵커(' + esc(settings().anchorText || '없음') + ') 아래 주입</div>'
        + '<div class="cc-inj">' + esc(sub(guide)) + '</div>';
    if (inj) html += (guide ? '<div style="height:8px;"></div>' : '')
        + '<div class="cc-mlabel" style="margin-bottom:3px;">🎬 큐카드 — 프롬프트 끝 주입</div>'
        + '<div class="cc-inj">' + esc(inj).replace(/^•\s([^\n—]+?)(\s—|$)/gm, '• <span class="cc-lbl">$1</span>$2') + '</div>';
    body.innerHTML = html;
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
          <hr style="opacity:.2;margin:10px 0;">
          <b>📚 큐로어 (로어북 자동 큐)</b>
          <div style="margin:8px 0;">
            <span class="cc-mlabel">연결할 로어북 (제목 "폴더 · 카드이름" / 본문 맨 앞 [상황: 한글] [cue: 영어])</span>
            <select id="cc-lorebook" class="text_pole" style="width:100%;"></select>
          </div>
          <div style="margin:8px 0;">
            <span class="cc-mlabel">상시 폴더 (쉼표 구분 — 판정 없이 매 턴 통째 주입. 비우면 전부 판정 대상. 🔵constant 엔트리는 항상 상시)</span>
            <input id="cc-always" class="text_pole" style="width:100%;" placeholder="(없음 — 전부 상황 판정)">
          </div>
          <div style="margin:8px 0;">
            <span class="cc-mlabel">주입 위치 앵커 — 이 문자열이 든 프롬프트 메시지 바로 아래에 큐로어가 들어감 (없거나 못 찾으면 끝에)</span>
            <input id="cc-anchor" class="text_pole" style="width:100%;" placeholder="&lt;cue_lore&gt;">
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:10px 0;">
            <input type="checkbox" id="cc-judge-on">
            <span><b>자동 판정</b> <span style="opacity:.6;font-size:11px;">— 전송 순간 장면을 판정해 폴더 카드를 자동 점등/소등</span></span>
          </label>
          <div style="margin:8px 0;">
            <span class="cc-mlabel">판정 연결 프로필 (비우면 현재 RP 연결·모델 그대로)</span>
            <select id="cc-judge-profile" class="text_pole" style="width:100%;"></select>
          </div>
          <div style="display:flex;gap:6px;margin:8px 0;flex-wrap:wrap;">
            <button id="cc-lore-reload" class="menu_button" style="width:auto;white-space:nowrap;">🔄 로어북 다시 읽기</button>
            <button id="cc-judge-test" class="menu_button" style="width:auto;white-space:nowrap;">⚖ 판정 테스트</button>
            <button id="cc-meta-write" class="menu_button" style="width:auto;white-space:nowrap;">✨ 제목·상황 자동 작성</button>
          </div>
          <small style="opacity:.6;display:block;margin:-4px 0 8px;">✨ = 본문만 써둔 엔트리를 카드로 완성. <b>[상황:]·제목은 한글</b>(네가 읽는 것), <b>[cue:]와 본문은 영어</b>(판정·주입에 나가는 것). 완비된 엔트리는 안 건드림.</small>
          <small style="opacity:.6;">카드 추가/편집은 로어북(월드인포)에서. 수동 카드는 버튼 바의 <b>⚙ 관리</b>에서. 로어북은 ST에서 활성화하지 마세요 — 주입은 큐카드가 합니다.</small>
        </div>
      </div>
    </div>`;
    $('#extensions_settings').append(html);
    $('#cc-show-bar').on('change', function () {
        const root = document.getElementById('cc-root');
        if (root) root.style.display = this.checked ? '' : 'none';
    });

    const fillBooks = () => {
        const sel = document.getElementById('cc-lorebook');
        if (!sel) return;
        const cur = settings().lorebook;
        const names = Array.isArray(world_names) ? world_names : [];
        sel.innerHTML = '<option value="">(연결 안 함)</option>' +
            names.map(n => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
    };
    fillBooks();
    $('#cc-lorebook').on('focus', fillBooks).on('change', function () {
        settings().lorebook = this.value; save(); loadLore();
    });
    $('#cc-always').val(settings().alwaysFolders).on('change', function () {
        settings().alwaysFolders = this.value; save(); renderBar(); refreshPanel();
    });
    $('#cc-anchor').val(settings().anchorText).on('change', function () {
        settings().anchorText = this.value; save(); refreshPanel();
    });
    $('#cc-judge-on').prop('checked', settings().judgeEnabled).on('change', function () {
        settings().judgeEnabled = this.checked; save();
        toast(this.checked ? '자동 판정 ON' : '자동 판정 OFF');
    });
    const fillProfiles = () => {
        const sel = document.getElementById('cc-judge-profile');
        if (!sel) return;
        const cur = settings().judgeProfile;
        sel.innerHTML = '<option value="">(현재 RP 연결 그대로)</option>' +
            judgeProfiles().map(p => `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    };
    fillProfiles();
    $('#cc-judge-profile').on('focus', fillProfiles).on('change', function () {
        settings().judgeProfile = this.value; save();
        const p = judgeProfiles().find(x => x.id === this.value);
        toast('판정 연결: ' + (p ? p.name : '현재 RP 연결'));
    });
    $('#cc-lore-reload').on('click', () => loadLore());
    $('#cc-meta-write').on('click', () => autoWriteMeta().catch(e => { console.log('[CueCard] autoWriteMeta:', e); toast('자동 작성 실패'); }));
    $('#cc-judge-test').on('click', async () => {
        if (!lore.entries.length) { toast('로어북을 먼저 연결하세요'); return; }
        toast('판정 중…');
        try { await judgeFlow(); toast('판정 완료 — 바에서 점등 상태 확인'); }
        catch (e) { toast('판정 실패: ' + e); }
    });
}

/* ===================================================================
 * 부팅
 * =================================================================== */
jQuery(() => {
    settings();
    addSettingsDrawer();
    loadLore(true);
    let tries = 0;
    const t = setInterval(() => {
        if (mount() || ++tries > 40) clearInterval(t);
    }, 500);
    console.log('[CueCard] v' + VERSION + ' loaded (lorebook auto-cue)');
});
