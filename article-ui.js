"use strict";
// 기사 분석 화면: 주장 추출 → 선택(최대 5개) → 순차 검증 → 결과 표
// 의존: article.js (splitSentences, hasNumericDetail, buildExtractionPrompt, EXTRACTION_SCHEMA,
//                   normalizeExtraction, estimateUsage, isUsableExtract, MAX_ARTICLE_CHARS, MAX_SELECT)
//       app.js (callGemini, verifyClaim, tavilyExtract, buildResultView, readKeys, setStatus, clearStatus,
//               errorMessage, isFatal, isHttpUrl, el, verdictClass, $)

const CLAIM_DELAY_MS = 4000; // 주장 사이 대기(Gemini 무료 한도 보호)
const RAW_DATA_LABEL = "원자료 확인 필요";
const FETCH_FAIL_MESSAGE = "본문을 가져오지 못했습니다. 기사 전문을 직접 붙여 넣어 주세요.";

const articleState = {
  candidates: [], // normalizeExtraction 결과
  selected: new Set(), // 선택한 후보의 key
  edited: new Map(), // key → 사용자가 고친 주장 문구
  extractionCalls: 0, // 주장 추출에 쓴 Gemini 호출
  fetchCalls: 0, // 본문 가져오기에 쓴 Tavily Extract 호출
  used: { tavily: 0, gemini: 0 },
  running: false,
  stopRequested: false,
};

function setArticleStatus(msg, isError = false) { setStatus("articleStatus", msg, isError); }
function claimTextOf(c) { return (articleState.edited.get(c.key) ?? c.claim).trim(); }
function needsRawCheck(c) { return hasNumericDetail(claimTextOf(c), c.sentence); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeKindBadge(kind) {
  return kind === "일반" ? null : el("span", "kind-badge", `[${kind}]`);
}
function makeRawBadge() { return el("span", "raw-badge", RAW_DATA_LABEL); }
// 화자는 코드가 붙이는 이름표다. 검색·판정에는 주장 내용만 보낸다.
function speakerPrefix(c) { return c.speaker ? `${c.speaker}: ` : ""; }

// 이미 쓴 호출(본문 가져오기·주장 추출) 안내 문구
function spentText() {
  const parts = [];
  if (articleState.fetchCalls) parts.push(`본문 가져오기에 Tavily Extract ${articleState.fetchCalls}회`);
  if (articleState.extractionCalls) parts.push(`주장 추출에 Gemini ${articleState.extractionCalls}회`);
  return parts.length ? `이미 사용: ${parts.join(", ")}` : "";
}

// ── ① 기사 입력 ───────────────────────────────────────
function updateArticleCount() {
  const len = $("articleText").value.length;
  const box = $("articleCount");
  box.textContent = `${len.toLocaleString()} / ${MAX_ARTICLE_CHARS.toLocaleString()}자`;
  box.classList.toggle("over", len > MAX_ARTICLE_CHARS);
}

// 기사 링크 → Tavily Extract → 원문 입력칸 (추출은 사용자가 확인한 뒤 따로 누른다)
async function fetchArticle() {
  const url = $("articleUrl").value.trim();
  const keys = readKeys();
  if (!keys) return setArticleStatus("상단에 Tavily 키와 Gemini 키를 모두 입력하세요.", true);
  if (!isHttpUrl(url)) return setArticleStatus("http:// 또는 https://로 시작하는 기사 링크를 넣어 주세요.", true);
  const box = $("articleText");
  if (box.value.trim() && !confirm("원문 입력칸의 내용을 가져온 본문으로 바꿀까요?")) return;

  $("fetchArticle").disabled = true;
  setArticleStatus("본문을 가져오는 중...");
  try {
    const text = await tavilyExtract(url, keys.tavily);
    articleState.fetchCalls++;
    refreshSelectionState();
    if (!isUsableExtract(text)) return setArticleStatus(FETCH_FAIL_MESSAGE, true);
    box.value = text;
    updateArticleCount();
    const over = text.length > MAX_ARTICLE_CHARS
      ? ` ${MAX_ARTICLE_CHARS.toLocaleString()}자를 넘으니 필요 없는 부분을 지워 주세요.` : "";
    setArticleStatus(`본문 ${text.length.toLocaleString()}자를 가져왔습니다. 메뉴·광고 문구가 섞였을 수 있으니 확인·수정한 뒤 [주장 추출]을 누르세요.${over}`);
  } catch (err) {
    const detail = isFatal(err) ? ` (${errorMessage(err)})` : "";
    setArticleStatus(FETCH_FAIL_MESSAGE + detail, true);
  } finally {
    $("fetchArticle").disabled = articleState.running;
  }
}

// ── ② 주장 추출 ───────────────────────────────────────
async function extractClaims() {
  const text = $("articleText").value.trim();
  const keys = readKeys();
  if (!keys) return setArticleStatus("상단에 Tavily 키와 Gemini 키를 모두 입력하세요.", true);
  if (!text) return setArticleStatus("기사 원문을 붙여 넣으세요.", true);
  if (text.length > MAX_ARTICLE_CHARS) {
    return setArticleStatus(`기사가 ${MAX_ARTICLE_CHARS.toLocaleString()}자를 넘습니다. 나눠서 넣어 주세요.`, true);
  }
  const sentences = splitSentences(text);

  $("extract").disabled = true;
  setArticleStatus(`문장 ${sentences.length}개에서 주장을 추출하는 중...`);
  try {
    const raw = await callGemini(buildExtractionPrompt(sentences), EXTRACTION_SCHEMA, keys.gemini);
    articleState.extractionCalls++;
    articleState.candidates = normalizeExtraction(raw, sentences);
    articleState.selected.clear();
    articleState.edited.clear();
    $("tableBox").hidden = true;
    renderCandidates();
    if (articleState.candidates.length === 0) setArticleStatus("검증할 만한 사실 주장을 찾지 못했습니다.", true);
    else clearStatus("articleStatus");
  } catch (err) {
    setArticleStatus(errorMessage(err), true);
  } finally {
    $("extract").disabled = false;
  }
}

// ── 추출된 주장 목록 ───────────────────────────────────
function renderCandidates() {
  const items = articleState.candidates.map((c) => {
    const li = el("li", "candidate");
    const check = el("input");
    check.type = "checkbox";
    check.dataset.key = String(c.key);
    check.addEventListener("change", () => toggleCandidate(c.key, check.checked));

    const head = el("label", "candidate-head");
    head.append(check, " ", el("span", "sentence-no", `문장 ${c.sentenceNo}`));
    if (c.speaker) head.append(" ", el("span", "speaker", `${c.speaker}:`));
    const kind = makeKindBadge(c.kind);
    if (kind) head.append(" ", kind);
    const raw = makeRawBadge();
    raw.hidden = !needsRawCheck(c);
    head.append(" ", raw);

    const input = el("input", "claim-input");
    input.type = "text";
    input.value = c.claim;
    input.setAttribute("aria-label", `문장 ${c.sentenceNo} 주장 문구`);
    input.addEventListener("input", () => {
      articleState.edited.set(c.key, input.value);
      raw.hidden = !needsRawCheck(c);
    });

    li.append(head, input, el("div", "hint original", `원문: ${speakerPrefix(c)}${c.sentence}`));
    return li;
  });
  $("candidates").replaceChildren(...items);
  $("candidatesBox").hidden = articleState.candidates.length === 0;
  refreshSelectionState();
}

function toggleCandidate(key, checked) {
  if (checked && articleState.selected.size >= MAX_SELECT) return refreshSelectionState();
  if (checked) articleState.selected.add(key);
  else articleState.selected.delete(key);
  refreshSelectionState();
}

// 5개를 고르면 나머지 체크박스를 잠그고, 예상 사용량을 갱신한다.
function refreshSelectionState() {
  const full = articleState.selected.size >= MAX_SELECT;
  document.querySelectorAll("#candidates input[type=checkbox]").forEach((box) => {
    const key = Number(box.dataset.key);
    box.checked = articleState.selected.has(key);
    box.disabled = articleState.running || (full && !box.checked);
  });
  document.querySelectorAll("#candidates .claim-input").forEach((input) => {
    input.disabled = articleState.running;
  });
  const n = articleState.selected.size;
  const u = estimateUsage(n);
  const spent = spentText();
  $("usage").textContent = (n === 0
    ? `검증할 주장을 선택하세요(최대 ${MAX_SELECT}개).`
    : `선택 ${n}/${MAX_SELECT}개 · 예상 사용량: Tavily 검색 ${u.tavilyMin}~${u.tavilyMax}회(advanced), Gemini ${u.gemini}회`)
    + (spent ? ` · ${spent}` : "");
  $("verifyStart").disabled = articleState.running || n === 0;
  $("verifyStop").disabled = !articleState.running;
  $("extract").disabled = articleState.running;
  $("fetchArticle").disabled = articleState.running;
}

// ── ③ 순차 검증 ───────────────────────────────────────
async function startVerification() {
  const keys = readKeys();
  if (!keys) return setArticleStatus("상단에 Tavily 키와 Gemini 키를 모두 입력하세요.", true);
  const targets = articleState.candidates
    .filter((c) => articleState.selected.has(c.key))
    .map((c) => ({ ...c, claim: claimTextOf(c), rawCheck: needsRawCheck(c) }));
  if (targets.some((t) => !t.claim)) return setArticleStatus("비어 있는 주장 문구가 있습니다. 고친 뒤 다시 시도하세요.", true);

  articleState.running = true;
  articleState.stopRequested = false;
  articleState.used = { tavily: 0, gemini: 0 };
  refreshSelectionState();
  const rows = renderTable(targets);

  try {
    for (let i = 0; i < targets.length; i++) {
      if (articleState.stopRequested) { markRemaining(rows, i, "중단됨"); break; }
      const t = targets[i];
      const progress = `${i + 1}/${targets.length} 검증 중`;
      setRowState(rows[i], "검증 중");
      setArticleStatus(`${progress}: ${t.claim}`);
      try {
        const out = await verifyClaim(t.claim, keys, (msg) => setArticleStatus(`${progress}: ${msg}`));
        addUsage(out.usage);
        fillRow(rows[i], out);
      } catch (err) {
        setRowState(rows[i], "오류");
        if (isFatal(err)) {
          markRemaining(rows, i + 1, "중단됨");
          setArticleStatus(`${errorMessage(err)} 남은 주장은 중단했습니다.`, true);
          return;
        }
        rows[i].detail.querySelector("td").replaceChildren(el("p", "hint", errorMessage(err)));
      }
      if (i < targets.length - 1 && !articleState.stopRequested) {
        setArticleStatus(`${i + 1}/${targets.length} 완료. 다음 주장까지 잠시 대기합니다(무료 한도 보호).`);
        await sleep(CLAIM_DELAY_MS);
      }
    }
    setArticleStatus(articleState.stopRequested ? "중지했습니다." : `검증을 마쳤습니다. ${usageText()}`);
  } finally {
    articleState.running = false;
    refreshSelectionState();
  }
}

function addUsage(u) {
  articleState.used.tavily += u.tavily;
  articleState.used.gemini += u.gemini;
  $("usedSoFar").textContent = usageText();
}
function usageText() {
  const u = articleState.used;
  const spent = spentText();
  return `실제 사용(이번 검증): Tavily 검색 ${u.tavily}회, Gemini ${u.gemini}회` + (spent ? ` · ${spent}` : "");
}

// ── ④ 결과 표 ─────────────────────────────────────────
// 행마다 { main: 요약 행, detail: 펼침 행 }. 요약 행을 누르면 상세를 펼치고 접는다.
function renderTable(targets) {
  const tbody = $("resultTable").querySelector("tbody");
  const rows = targets.map((t) => {
    const main = el("tr", "result-row");
    main.tabIndex = 0;
    const claimCell = el("td");
    claimCell.append(el("div", "", speakerPrefix(t) + t.claim));
    const kind = makeKindBadge(t.kind);
    if (kind) claimCell.append(kind, " ");
    if (t.rawCheck) claimCell.append(makeRawBadge());
    main.append(el("td", "center", String(t.sentenceNo)), claimCell, el("td"), el("td"), el("td"));

    const detail = el("tr", "detail-row");
    detail.hidden = true;
    const cell = el("td");
    cell.colSpan = 5;
    detail.append(cell);

    const toggle = () => { detail.hidden = !detail.hidden; main.classList.toggle("open", !detail.hidden); };
    main.addEventListener("click", toggle);
    main.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    return { main, detail };
  });
  tbody.replaceChildren(...rows.flatMap((r) => [r.main, r.detail]));
  rows.forEach((r) => setRowState(r, "대기"));
  $("usedSoFar").textContent = "";
  $("tableBox").hidden = false;
  return rows;
}

function setRowState(row, state) {
  row.main.children[2].replaceChildren(el("span", "row-state", state));
}

function markRemaining(rows, from, state) {
  rows.slice(from).forEach((r) => setRowState(r, state));
}

function fillRow(row, { result, all }) {
  const [, , verdictCell, typeCell, idsCell] = row.main.children;
  verdictCell.replaceChildren(el("span", "verdict small " + verdictClass(result.verdict), result.verdict));
  typeCell.textContent = result.claimType || "–";
  idsCell.textContent = result.used.length ? result.used.map((e) => `[${e.id}]`).join(" ") : "–";
  row.detail.querySelector("td").replaceChildren(buildResultView(result, all));
}

// ── 초기화 ─────────────────────────────────────────
$("articleText").addEventListener("input", updateArticleCount);
$("extract").addEventListener("click", extractClaims);
$("fetchArticle").addEventListener("click", fetchArticle);
$("verifyStart").addEventListener("click", startVerification);
$("verifyStop").addEventListener("click", () => {
  articleState.stopRequested = true;
  $("verifyStop").disabled = true;
  setArticleStatus("지금 검증 중인 주장까지 마치고 멈춥니다...");
});
updateArticleCount();
