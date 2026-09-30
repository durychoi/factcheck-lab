"use strict";
// 의존: sources.js (SOURCE_TYPES, PRIORITY_DOMAINS, classifySource)
//       evidence.js (MAX_EVIDENCE, WEAK_SOURCE_TYPE, selectEvidence)
//       judge.js (VERDICTS, HOLD, CLAIM_TYPES, NOTE_KINDS, NOTE_STANCES, normalizeResult)
// 핵심 주장 화면(article-ui.js)과 출고 전 점검 화면(precheck-ui.js)이 이 파일의 호출·표시 함수를 같이 쓴다.

// ── 설정 ────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.5-flash"; // 모델을 바꿀 때는 이 줄만 수정
const CANDIDATE_POOL = 10; // 검색 1회에 받아 오는 후보 수 (이 중 MAX_EVIDENCE건을 고른다)
const KEY_STORE = { tavily: "factcheck.tavilyKey", gemini: "factcheck.geminiKey" };
const FATAL_STATUS = [401, 403, 429]; // 재시도해도 소용없는 오류
const TAVILY_CONNECT_ERROR =
  "Tavily에 연결하지 못했습니다. 키가 틀렸거나 사용 한도를 넘었을 때도 이렇게 표시됩니다. 키와 인터넷 연결을 확인하세요.";

const $ = (id) => document.getElementById(id);

// ── 키 저장 (localStorage만 사용) ───────────────────────
function loadKey(name) {
  try { return localStorage.getItem(KEY_STORE[name]) || ""; } catch { return ""; }
}
function saveKey(name, value) {
  try { localStorage.setItem(KEY_STORE[name], value.trim()); } catch { /* 저장 불가 환경 */ }
}
function clearKeys() {
  try { Object.values(KEY_STORE).forEach((k) => localStorage.removeItem(k)); } catch { /* noop */ }
  $("tavilyKey").value = "";
  $("geminiKey").value = "";
  showStatus("저장된 키를 지웠습니다.");
}

// ── 화면 표시 ──────────────────────────────────────
function setStatus(id, msg, isError = false) {
  const box = $(id);
  box.textContent = msg;
  box.className = "status show" + (isError ? " error" : "");
}
function clearStatus(id) { $(id).className = "status"; }
function showStatus(msg, isError = false) { setStatus("status", msg, isError); }
function hideStatus() { clearStatus("status"); }

// ── 1단계: Tavily 근거 수집 (우선 출처 1차 → 부족하면 전체 2차) ────
// Tavily 공통 호출.
// Tavily의 오류 응답(401 키 오류, 429 한도 초과 등)에는 브라우저 허용(CORS) 헤더가 없어서
// 브라우저에서는 상태 코드 대신 네트워크 오류(TypeError)로만 보인다. 그래서 연결 실패를 치명 오류로 다룬다.
async function tavilyPost(path, key, payload) {
  let res;
  try {
    res = await fetch(`https://api.tavily.com/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    throw Object.assign(new Error(TAVILY_CONNECT_ERROR), { fatal: true, cause });
  }
  if (!res.ok) throw httpError("Tavily", res.status);
  return res.json();
}

async function tavilySearch(claim, key, extra) {
  const data = await tavilyPost("search", key,
    { query: claim, max_results: CANDIDATE_POOL, search_depth: "advanced", ...extra });
  return (data.results || [])
    .filter((r) => isHttpUrl(r.url))
    .map((r) => ({
      title: r.title || "(제목 없음)",
      summary: r.content || "",
      url: r.url,
      score: typeof r.score === "number" ? r.score : 0,
    }));
}

// 기사 링크에서 본문을 가져온다. 성공 응답이지만 본문이 없으면 빈 문자열.
async function tavilyExtract(url, key) {
  const data = await tavilyPost("extract", key, { urls: [url], extract_depth: "basic" });
  const hit = (data.results || []).find((r) => typeof r.raw_content === "string");
  return hit ? hit.raw_content.trim() : "";
}

function mergeUnique(lists) {
  const seen = new Set();
  return lists.flat().filter((e) => (seen.has(e.url) ? false : seen.add(e.url)));
}

// 반환: { selected, all, searches } (selected·all은 evidence.js의 selectEvidence 참고, searches는 실제 검색 횟수)
// opts: depth("advanced"|"basic"), fallbackBelow(1차 근거가 이 수보다 적으면 2차 검색),
//       maxEvidence·maxPerType·exclude(selectEvidence로 전달)
async function fetchEvidence(claim, key, opts = {}) {
  const depth = { search_depth: opts.depth || "advanced" };
  const fallbackBelow = opts.fallbackBelow || MAX_EVIDENCE;
  let priority = [];
  let searches = 1;
  try {
    priority = await tavilySearch(claim, key, { ...depth, include_domains: PRIORITY_DOMAINS });
  } catch (err) {
    // 키·한도·연결 오류는 그대로 알린다. 그 밖의 거부(도메인 목록 등)는 2차 검색으로 넘어간다.
    if (!err.status || isFatal(err)) throw err;
  }
  let result = selectEvidence(priority, opts);
  if (result.selected.length < fallbackBelow) {
    searches++;
    const general = await tavilySearch(claim, key, depth);
    result = selectEvidence(mergeUnique([priority, general]), opts);
  }
  return { ...result, searches };
}

// ── 2단계: Gemini 판정 (근거 목록만 전달) ─────────────────
function buildPrompt(claim, evidence) {
  const list = evidence
    .map((e) => `[${e.id}] 출처유형: ${e.type}\n제목: ${e.title}\n요약: ${e.summary}`)
    .join("\n\n");
  return [
    "너는 팩트체크 판정자다. 아래 [근거 목록]에 적힌 내용만으로 [주장]을 판정하라.",
    "",
    "[기본 규칙]",
    "- 근거 목록 밖의 지식, 추측, 기억으로 판정하지 마라.",
    `- verdict는 반드시 다음 중 하나: ${VERDICTS.join(" / ")}`,
    "- reasons는 한국어 문장 3개 이하. 건조하고 객관적으로 쓴다.",
    "- used_evidence에는 판정에 실제로 쓴 근거의 번호(정수)만 넣어라. URL은 쓰지 마라.",
    "- reasons에서 근거를 인용할 때는 [번호] 형식으로만 써라. 인용한 번호는 반드시 used_evidence에도 넣어라. 근거 목록에 없는 번호는 쓰지 마라.",
    "",
    "[주장 유형]",
    `- 오늘 날짜는 ${todayString()}이다.`,
    `- 판정 전에 claim_type을 정하라: ${CLAIM_TYPES.join(" / ")}`,
    "  - 검증 가능한 사실: 오늘까지의 과거·현재 상태, 기록, 결정에 대한 진술",
    "  - 미래 예측·전망: 오늘 이후 시점의 수치·사건에 대한 진술",
    "  - 가정: \"만약 ~라면\" 같은 조건부 진술 / 의견: 평가·주장·가치 판단",
    `- claim_type이 검증 가능한 사실이 아니면 관련 근거가 있어도 반드시 "${HOLD}"로 하고, reasons 첫 문장에 "검증할 수 없는 미래 예측"처럼 유보 사유를 써라.`,
    "",
    "[반박과 근거 부재의 구분]",
    "- \"반박 근거가 있음\"(주장과 다른 사실을 진술하는 근거가 있음)과 \"지지 근거가 없음\"을 구분하라.",
    "- 지지 근거가 없다는 것만으로는 거짓이나 대체로 거짓이 될 수 없다. 거짓 계열은 성격 사실진술·입장 반박인 근거가 있을 때만 내려라.",
    "- 사실 계열은 성격 사실진술·입장 지지인 근거가 있을 때만 내려라.",
    "",
    "[사실과 의견의 구분]",
    "- 먼저 근거마다 evidence_notes에 성격과 입장을 적어라.",
    "  - 성격: 사실진술(현재 상태·기록·결정에 대한 서술) / 의견·규범(\"~해야 한다\", \"~는 위헌이다\" 같은 의견·비판·규범적 주장) / 무관(주장과 관련 없음)",
    "  - 입장: 주장에 대해 지지 / 반박 / 중립",
    "- 의견·비판·규범적 주장은 사실 판정의 반대 근거로 세지 마라. 의견·규범과 무관 근거는 used_evidence에 넣지 마라.",
    `- "${HOLD}"은 사실진술끼리 서로 충돌해 결론을 낼 수 없을 때, 또는 판정에 쓸 사실진술 근거가 없을 때만 사용하라.`,
    "- 공공기관·법령 같은 1차 출처의 사실진술은 학술·언론의 의견보다 무겁게 보라.",
    `- 판정에 쓴 근거가 모두 출처유형 "${WEAK_SOURCE_TYPE}"이면 "${HOLD}" 외의 판정을 내리지 말고 반드시 "${HOLD}"로 하라.`,
    "",
    `[주장]\n${claim}`,
    "",
    `[근거 목록]\n${list}`,
  ].join("\n");
}

// 근거별 성격 분석을 판정보다 먼저 생성하게 한다
const JUDGE_SCHEMA = {
  type: "OBJECT",
  propertyOrdering: ["claim_type", "evidence_notes", "verdict", "reasons", "used_evidence"],
  properties: {
    claim_type: { type: "STRING", enum: CLAIM_TYPES },
    evidence_notes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        propertyOrdering: ["id", "kind", "stance"],
        properties: {
          id: { type: "INTEGER" },
          kind: { type: "STRING", enum: NOTE_KINDS },
          stance: { type: "STRING", enum: NOTE_STANCES },
        },
        required: ["id", "kind", "stance"],
      },
    },
    verdict: { type: "STRING", enum: VERDICTS },
    reasons: { type: "ARRAY", items: { type: "STRING" } },
    used_evidence: { type: "ARRAY", items: { type: "INTEGER" } },
  },
  required: ["claim_type", "evidence_notes", "verdict", "reasons", "used_evidence"],
};

async function askGemini(claim, evidence, key) {
  return callGemini(buildPrompt(claim, evidence), JUDGE_SCHEMA, key);
}

// Gemini 공통 호출 (temperature 0, JSON 응답)
async function callGemini(prompt, schema, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  if (!res.ok) throw httpError("Gemini", res.status);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini가 응답을 돌려주지 않았습니다. 잠시 뒤 다시 시도하세요.");
  try { return JSON.parse(text); } catch { throw new Error("Gemini 응답 형식이 올바르지 않습니다. 다시 시도하세요."); }
}

// ── 검증 절차 (문장 분석·기사 분석 공용) ─────────────────────
// 반환: { result, all, usage: { tavily, gemini } }
// opts는 fetchEvidence로 전달 (예: exclude로 원 기사 제외)
async function verifyClaim(claim, keys, onStep = () => {}, opts = {}) {
  onStep("근거를 검색하는 중...");
  const { selected, all, searches } = await fetchEvidence(claim, keys.tavily, opts);
  if (selected.length === 0) {
    const result = { verdict: HOLD, reasons: ["관련 근거를 찾지 못해 판단을 유보합니다."], used: [], notes: null, claimType: null };
    return { result, all, usage: { tavily: searches, gemini: 0 } };
  }
  onStep(`근거 ${selected.length}건으로 판정하는 중...`);
  const raw = await askGemini(claim, selected, keys.gemini);
  return { result: normalizeResult(raw, selected), all, usage: { tavily: searches, gemini: 1 } };
}

// ── 결과 렌더링 (textContent만 사용: 외부 문자열은 HTML로 해석하지 않음) ──
// 화면의 번호는 목록 순서가 아니라 Gemini에 전달한 근거 번호(id)다. 이유 문장의 [번호]와 같다.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeBadge(type) { return el("span", "badge t-" + type, `[${type}]`); }
function makeNum(id) { return el("span", "num", id ? `[${id}]` : "[–]"); }
function verdictClass(verdict) { return "v-" + verdict.replace(/ /g, "-"); }

function makeEvidenceItem(e, detail) {
  const li = el("li");
  const a = el("a", "", e.title);
  a.href = e.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  li.append(makeNum(e.id), " ", makeBadge(e.type), " ", a, el("div", "hint", detail));
  return li;
}

// 검색된 후보 전체와 처리 결과 (원인 진단용). 전달된 근거를 번호순으로, 제외된 후보를 뒤에 둔다.
function buildAllEvidence(all, used, notes) {
  const usedIds = new Set(used.map((e) => e.id));
  const ordered = [
    ...all.filter((e) => e.id).sort((a, b) => a.id - b.id),
    ...all.filter((e) => !e.id),
  ];
  const details = el("details");
  details.hidden = all.length === 0;
  details.append(
    el("summary", "", `검색된 근거 전체 보기 (${all.length}건)`),
    el("p", "hint", "[–]는 중복·상한으로 제외되어 판정에 전달되지 않은 후보입니다.")
  );
  const ul = el("ul", "numbered");
  ul.append(...ordered.map((e) => {
    let state = e.status;
    if (!state) {
      const note = notes?.get(e.id);
      const noteText = note ? ` · ${note.kind}/${note.stance}` : "";
      state = (usedIds.has(e.id) ? "판정에 사용" : "검토됨(판정에 미사용)") + noteText;
    }
    return makeEvidenceItem(e, state);
  }));
  details.append(ul);
  return details;
}

// 상세 결과 한 묶음 (판정·유형·이유·판정에 쓴 근거·전체 근거)
function buildResultView({ verdict, reasons, used, claimType, notes }, all) {
  const wrap = el("div", "result-view");
  wrap.append(el("div", "verdict " + verdictClass(verdict), verdict));
  if (claimType) wrap.append(el("p", "hint claim-type", `주장 유형: ${claimType}`));
  const ul = el("ul", "reasons");
  ul.append(...reasons.map((r) => el("li", "", r)));
  const sources = el("ul", "numbered sources");
  sources.append(...used.map((e) => makeEvidenceItem(e, e.url)));
  wrap.append(
    ul,
    el("h3", "", "판정에 쓴 근거"),
    used.length ? sources : el("p", "hint", "없음"),
    el("p", "hint", "AI 판정은 참고용입니다. 근거 링크를 직접 확인하세요."),
    buildAllEvidence(all, used, notes)
  );
  return wrap;
}

// ── 유틸 ───────────────────────────────────────────
function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isHttpUrl(u) {
  try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; }
}
function httpError(who, status) {
  let msg = `${who} 호출에 실패했습니다(상태 코드 ${status}).`;
  if (status === 401 || status === 403) msg = `${who} 키가 올바르지 않거나 권한이 없습니다. 키를 확인하세요.`;
  else if (status === 429) msg = `${who} 사용 한도를 넘었습니다. 잠시 뒤 다시 시도하세요.`;
  else if (status === 400) msg = `${who} 요청이 거부되었습니다(400). 키와 입력 내용을 확인하세요.`;
  return Object.assign(new Error(msg), { status });
}
// 다음 주장으로 넘어가도 소용없는 오류(키·한도·Tavily 연결 실패)
function isFatal(err) {
  return Boolean(err && (err.fatal || FATAL_STATUS.includes(err.status)));
}
function errorMessage(err) {
  // fetch 자체 실패(네트워크, CORS 등)는 TypeError
  return err instanceof TypeError ? "네트워크 오류로 호출하지 못했습니다. 연결을 확인하세요." : err.message;
}

// 입력칸의 키를 읽어 저장한다. 하나라도 비었으면 null.
function readKeys() {
  const keys = { tavily: $("tavilyKey").value.trim(), gemini: $("geminiKey").value.trim() };
  if (!keys.tavily || !keys.gemini) return null;
  saveKey("tavily", keys.tavily);
  saveKey("gemini", keys.gemini);
  return keys;
}

// ── 문장 분석 실행 ────────────────────────────────────
async function analyze() {
  const claim = $("claim").value.trim();
  const keys = readKeys();
  if (!keys) return showStatus("상단에 Tavily 키와 Gemini 키를 모두 입력하세요.", true);
  if (!claim) return showStatus("검증할 주장을 입력하세요.", true);

  $("analyze").disabled = true;
  $("result").hidden = true;
  try {
    const { result, all } = await verifyClaim(claim, keys, (msg) => showStatus(msg));
    $("result").replaceChildren(buildResultView(result, all));
    $("result").hidden = false;
    hideStatus();
  } catch (err) {
    showStatus(errorMessage(err), true);
  } finally {
    $("analyze").disabled = false;
  }
}

// ── 탭 전환 ────────────────────────────────────────
// 탭 이름 → [탭 버튼 id, 화면 id]
const TABS = {
  sentence: ["tabSentence", "sentencePane"],
  article: ["tabArticle", "articlePane"],
  precheck: ["tabPrecheck", "precheckPane"],
};

function switchTab(name) {
  Object.entries(TABS).forEach(([key, [tab, pane]]) => {
    $(pane).hidden = key !== name;
    $(tab).setAttribute("aria-selected", String(key === name));
  });
}

// ── 초기화 ─────────────────────────────────────────
$("tavilyKey").value = loadKey("tavily");
$("geminiKey").value = loadKey("gemini");
$("analyze").addEventListener("click", analyze);
$("clearKeys").addEventListener("click", clearKeys);
Object.entries(TABS).forEach(([key, [tab]]) => $(tab).addEventListener("click", () => switchTab(key)));
