"use strict";
// 출고 전 점검 화면: 본문 → 사실 항목 추출(구간별) → 유형 선택·예상 사용량 → 묶음별 순차 점검 → 항목 표·필터·CSV
// 의존: article.js (splitSentences, guessTitle, isUsableExtract, MAX_ARTICLE_CHARS)
//       items.js (ITEM_TYPES, UNKNOWN, chunkSentences, buildItemExtractionPrompt, ITEM_EXTRACTION_SCHEMA,
//                 normalizeItemExtraction, buildGroups, estimatePrecheck, buildItemJudgePrompt, ITEM_JUDGE_SCHEMA,
//                 normalizeItemVerdicts, noEvidenceResults, primarySourcesFor, buildCsv)
//       app.js (callGemini, fetchEvidence, tavilyExtract, readKeys, setStatus, clearStatus, errorMessage, isFatal,
//               isHttpUrl, el, makeBadge, makeNum, makeEvidenceItem, buildAllEvidence, $)

const PC_DELAY_MS = 4000; // 호출 사이 대기(Gemini 무료 한도 보호)
const PC_SEARCH = { depth: "basic", maxEvidence: 8, maxPerType: 3, fallbackBelow: 4 };
const PC_FETCH_FAIL = "본문을 가져오지 못했습니다. 기사 전문을 직접 붙여 넣어 주세요.";
const PC_QUICK_TYPES = {
  all: ITEM_TYPES,
  numbers: ["수치", "날짜"],
  people: ["인물·직함"],
};
const PC_FILTERS = [
  { id: "all", label: "전체", test: () => true },
  { id: "mismatch", label: "불일치", test: (r) => r?.verdict === "불일치" },
  { id: "approx", label: "근사", test: (r) => r?.verdict === "근사" },
  { id: "check", label: "확인 불가·원자료 확인", test: (r) => Boolean(r?.rawCheck) },
  { id: "pending", label: "미점검", test: (r) => !r },
];

const pc = {
  items: [], // normalizeItemExtraction 결과 + idx
  results: new Map(), // idx → 판정 결과 { verdict, reason, used, evidenceValue, rawCheck, all, query }
  types: new Set(ITEM_TYPES), // 점검할 유형
  filter: "all",
  open: new Set(), // 펼친 행의 idx
  fetched: null, // 가져온 기사 { url, title }
  calls: { extract: 0, extractGemini: 0, tavily: 0, gemini: 0 },
  running: false,
  stopRequested: false,
};

function pcStatus(msg, isError = false) { setStatus("pcStatus", msg, isError); }
function pcSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 원 기사(링크 URL, 제목)는 근거에서 뺀다. 순환 검증 방지.
function pcSource() {
  const url = $("pcUrl").value.trim();
  const title = $("pcTitle").value.trim();
  const src = { url: isHttpUrl(url) ? url : "", title };
  return src.url || src.title ? src : null;
}

function pcSpentText() {
  const c = pcCalls();
  return `지금까지 사용: Tavily Extract ${c.extract}회, Tavily 검색 ${c.tavily}회, Gemini ${c.gemini}회(추출 ${c.extractGemini}회 포함)`;
}
function pcCalls() {
  const c = pc.calls;
  return { extract: c.extract, tavily: c.tavily, extractGemini: c.extractGemini, gemini: c.gemini + c.extractGemini };
}

// ── ① 본문 ─────────────────────────────────────────
function pcUpdateCount() {
  const len = $("pcText").value.length;
  const box = $("pcCount");
  box.textContent = `${len.toLocaleString()} / ${MAX_ARTICLE_CHARS.toLocaleString()}자`;
  box.classList.toggle("over", len > MAX_ARTICLE_CHARS);
}

async function pcFetchArticle() {
  const url = $("pcUrl").value.trim();
  const keys = readKeys();
  if (!keys) return pcStatus("상단에 Tavily 키와 Gemini 키를 모두 입력하세요.", true);
  if (!isHttpUrl(url)) return pcStatus("http:// 또는 https://로 시작하는 기사 링크를 넣어 주세요.", true);
  if ($("pcText").value.trim() && !confirm("본문 입력칸의 내용을 가져온 본문으로 바꿀까요?")) return;

  $("pcFetch").disabled = true;
  pcStatus("본문을 가져오는 중...");
  try {
    const text = await tavilyExtract(url, keys.tavily);
    pc.calls.extract++;
    if (!isUsableExtract(text)) return pcStatus(PC_FETCH_FAIL, true);
    $("pcText").value = text;
    $("pcTitle").value = guessTitle(text);
    pcUpdateCount();
    const over = text.length > MAX_ARTICLE_CHARS
      ? ` ${MAX_ARTICLE_CHARS.toLocaleString()}자를 넘으니 필요 없는 부분을 지워 주세요.` : "";
    pcStatus(`본문 ${text.length.toLocaleString()}자를 가져왔습니다. 제목과 본문을 확인·수정한 뒤 [사실 항목 추출]을 누르세요.${over}`);
  } catch (err) {
    pcStatus(PC_FETCH_FAIL + (isFatal(err) ? ` (${errorMessage(err)})` : ""), true);
  } finally {
    $("pcFetch").disabled = pc.running;
  }
}

// ── ② 사실 항목 추출 (구간별 순차) ─────────────────────────
async function pcExtract() {
  const text = $("pcText").value.trim();
  const keys = readKeys();
  if (!keys) return pcStatus("상단에 Tavily 키와 Gemini 키를 모두 입력하세요.", true);
  if (!text) return pcStatus("기사 본문을 붙여 넣으세요.", true);
  if (text.length > MAX_ARTICLE_CHARS) {
    return pcStatus(`본문이 ${MAX_ARTICLE_CHARS.toLocaleString()}자를 넘습니다. 줄인 뒤 다시 시도하세요.`, true);
  }
  if (pc.results.size && !confirm("이전 점검 결과를 지우고 새로 추출할까요?")) return;

  const chunks = chunkSentences(splitSentences(text));
  const found = [];
  pc.running = true;
  pcRefreshControls();
  try {
    for (let i = 0; i < chunks.length; i++) {
      pcStatus(`사실 항목 추출 중: ${i + 1}/${chunks.length} 구간`);
      try {
        const raw = await callGemini(buildItemExtractionPrompt(chunks[i]), ITEM_EXTRACTION_SCHEMA, keys.gemini);
        pc.calls.extractGemini++;
        found.push(...normalizeItemExtraction(raw, chunks[i]));
      } catch (err) {
        const where = `${i + 1}번째 구간(문장 ${chunks[i].target[0].no}~)부터 추출하지 못했습니다.`;
        pcStatus(`${where} ${errorMessage(err)} 앞 구간에서 뽑은 항목만 표시합니다.`, true);
        break;
      }
      if (i < chunks.length - 1) await pcSleep(PC_DELAY_MS);
    }
    pc.items = found.map((it, idx) => ({ ...it, idx }));
    pc.results.clear();
    pc.open.clear();
    pc.filter = "all";
    if (!$("pcStatus").classList.contains("error")) {
      pcStatus(pc.items.length ? `사실 항목 ${pc.items.length}개를 뽑았습니다. 점검할 유형을 고른 뒤 [점검 시작]을 누르세요.`
        : "확인할 사실 항목을 찾지 못했습니다.", !pc.items.length);
    }
  } finally {
    pc.running = false;
    pcRenderAll();
  }
}

// ── ③ 유형 선택과 예상 사용량 ─────────────────────────────
function pcPendingGroups() {
  return buildGroups(pc.items.filter((it) => pc.types.has(it.type) && !pc.results.has(it.idx)));
}

function pcRenderTypes() {
  const counts = new Map(ITEM_TYPES.map((t) => [t, pc.items.filter((it) => it.type === t).length]));
  const boxes = ITEM_TYPES.map((t) => {
    const label = el("label", "type-option");
    const box = el("input");
    box.type = "checkbox";
    box.checked = pc.types.has(t);
    box.disabled = pc.running;
    box.addEventListener("change", () => {
      if (box.checked) pc.types.add(t); else pc.types.delete(t);
      pcRefreshControls();
    });
    label.append(box, ` ${t} (${counts.get(t)})`);
    return label;
  });
  $("pcTypes").replaceChildren(...boxes);
}

function pcSetQuickTypes(name) {
  pc.types = new Set(PC_QUICK_TYPES[name]);
  pcRenderTypes();
  pcRefreshControls();
}

function pcRefreshControls() {
  const groups = pcPendingGroups();
  const est = estimatePrecheck(groups);
  const done = pc.results.size;
  $("pcEstimate").textContent = est.items === 0
    ? `점검할 항목이 없습니다. ${pcSpentText()}`
    : `점검할 항목 ${est.items}개 · 검색 묶음 ${est.groups}개 · 예상 사용량: Tavily 검색 ${est.tavilyMin}~${est.tavilyMax}회(basic), `
      + `Gemini ${est.gemini}회 · 예상 소요 약 ${est.minutes}분 · ${pcSpentText()}`;
  $("pcRun").textContent = done ? "남은 항목 점검" : "점검 시작";
  $("pcRun").disabled = pc.running || est.items === 0;
  $("pcStop").disabled = !pc.running;
  $("pcExtract").disabled = pc.running;
  $("pcFetch").disabled = pc.running;
  $("pcCsv").disabled = pc.items.length === 0;
  document.querySelectorAll("#pcTypes input, #pcQuick button").forEach((b) => { b.disabled = pc.running; });
  $("pcSetup").hidden = pc.items.length === 0;
  $("pcTableBox").hidden = pc.items.length === 0;
}

// ── ④ 묶음별 순차 점검 ─────────────────────────────────
async function pcRun() {
  const keys = readKeys();
  if (!keys) return pcStatus("상단에 Tavily 키와 Gemini 키를 모두 입력하세요.", true);
  const groups = pcPendingGroups();
  if (!groups.length) return;
  const source = pcSource();

  pc.running = true;
  pc.stopRequested = false;
  pcRefreshControls();
  try {
    for (let i = 0; i < groups.length; i++) {
      if (pc.stopRequested) { pcStatus(`중지했습니다. ${pcSpentText()}`); return; }
      const g = groups[i];
      pcStatus(`${i + 1}/${groups.length} 묶음 점검 중: ${g.query} (항목 ${g.items.length}개)`);
      try {
        await pcCheckGroup(g, keys, source);
      } catch (err) {
        if (isFatal(err)) {
          pcStatus(`${errorMessage(err)} 끝난 결과는 남겨 두었습니다. 나중에 [남은 항목 점검]으로 이어서 할 수 있습니다.`, true);
          return;
        }
        pcStatus(`묶음 "${g.query}" 점검 실패: ${errorMessage(err)} 다음 묶음으로 넘어갑니다.`, true);
      }
      pcRenderTable();
      if (i < groups.length - 1 && !pc.stopRequested) await pcSleep(PC_DELAY_MS);
    }
    pcStatus(`점검을 마쳤습니다. ${pcSpentText()}`);
  } finally {
    pc.running = false;
    pcRenderAll();
  }
}

async function pcCheckGroup(g, keys, source) {
  const ev = await fetchEvidence(g.query, keys.tavily, { ...PC_SEARCH, exclude: source });
  pc.calls.tavily += ev.searches;
  let results;
  if (ev.selected.length === 0) {
    results = noEvidenceResults(g);
  } else {
    const raw = await callGemini(buildItemJudgePrompt(g, ev.selected), ITEM_JUDGE_SCHEMA, keys.gemini);
    pc.calls.gemini++;
    results = normalizeItemVerdicts(raw, g, ev.selected);
  }
  g.items.forEach((it, k) => pc.results.set(it.idx, { ...results[k], all: ev.all, query: g.query }));
}

// ── ⑤ 결과 표·필터 ──────────────────────────────────
function pcRenderFilters() {
  const buttons = PC_FILTERS.map((f) => {
    const n = pc.items.filter((it) => f.test(pc.results.get(it.idx))).length;
    const b = el("button", "filter" + (pc.filter === f.id ? " active" : ""), `${f.label} ${n}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(pc.filter === f.id));
    b.addEventListener("click", () => { pc.filter = f.id; pcRenderTable(); pcRenderFilters(); });
    return b;
  });
  $("pcFilters").replaceChildren(...buttons);
}

function pcVerdictCell(r) {
  const td = el("td");
  if (!r) { td.append(el("span", "row-state", "대기")); return td; }
  td.append(el("span", "verdict small " + verdictClass(r.verdict), r.verdict));
  if (r.rawCheck) td.append(el("div", "", ""), el("span", "raw-badge", "원자료 확인 필요"));
  return td;
}

function pcRenderTable() {
  const filter = PC_FILTERS.find((f) => f.id === pc.filter) || PC_FILTERS[0];
  const rows = pc.items
    .filter((it) => filter.test(pc.results.get(it.idx)))
    .flatMap((it) => {
      const r = pc.results.get(it.idx);
      const main = el("tr", "result-row" + (pc.open.has(it.idx) ? " open" : ""));
      main.tabIndex = 0;
      const exprCell = el("td");
      exprCell.append(el("div", "expr", it.expression));
      if (it.speaker) exprCell.append(el("div", "hint", `${it.speaker}:`));
      main.append(
        el("td", "center", String(it.sentenceNo)),
        exprCell,
        el("td", "nowrap", it.type),
        pcVerdictCell(r),
        el("td", "expr", r?.evidenceValue || ""),
        el("td", "nowrap", r?.used.length ? r.used.map((e) => `[${e.id}]`).join(" ") : (r ? "–" : "")),
      );
      const detail = el("tr", "detail-row");
      detail.hidden = !pc.open.has(it.idx);
      const cell = el("td");
      cell.colSpan = 6;
      if (!detail.hidden) cell.append(pcBuildDetail(it, r));
      detail.append(cell);
      const toggle = () => {
        if (pc.open.has(it.idx)) pc.open.delete(it.idx); else pc.open.add(it.idx);
        detail.hidden = !pc.open.has(it.idx);
        main.classList.toggle("open", !detail.hidden);
        cell.replaceChildren(...(detail.hidden ? [] : [pcBuildDetail(it, r)]));
      };
      main.addEventListener("click", toggle);
      main.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      return [main, detail];
    });
  $("pcTable").querySelector("tbody").replaceChildren(...rows);
  $("pcEmpty").hidden = rows.length > 0;
  pcRenderFilters();
}

function pcBuildDetail(it, r) {
  const wrap = el("div", "result-view");
  wrap.append(
    el("p", "", `확인할 내용: ${it.check}`),
    el("p", "hint", `원문(문장 ${it.sentenceNo}): ${it.speaker ? `${it.speaker}: ` : ""}${it.sentence}`),
  );
  if (!r) {
    wrap.append(el("p", "hint", "아직 점검하지 않은 항목입니다."));
    return wrap;
  }
  wrap.append(el("p", "", `이유: ${r.reason || "–"}`));
  if (r.verdict === UNKNOWN) {
    const box = el("div", "primary-sources");
    box.append(el("strong", "", "1차 확인처: "));
    primarySourcesFor(it).forEach((h, i) => {
      if (i) box.append(" · ");
      if (h.url) {
        const a = el("a", "", h.name);
        a.href = h.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        box.append(a);
      } else {
        box.append(h.name);
      }
    });
    wrap.append(box);
  }
  const sources = el("ul", "numbered sources");
  sources.append(...r.used.map((e) => makeEvidenceItem(e, e.url)));
  wrap.append(
    el("h3", "", "판정에 쓴 근거"),
    r.used.length ? sources : el("p", "hint", "없음"),
    el("p", "hint", `검색어: ${r.query}`),
    buildAllEvidence(r.all, r.used, null),
  );
  return wrap;
}

function pcRenderAll() {
  pcRenderTypes();
  pcRefreshControls();
  pcRenderTable();
}

// ── ⑥ CSV 내려받기 ──────────────────────────────────
function pcDownloadCsv() {
  const csv = buildCsv(pc.items.map((item) => ({ item, result: pc.results.get(item.idx) })));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const d = new Date();
  const stamp = `${todayString().replace(/-/g, "")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = `출고전점검-${stamp}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── 초기화 ─────────────────────────────────────────
$("pcText").addEventListener("input", pcUpdateCount);
$("pcFetch").addEventListener("click", pcFetchArticle);
$("pcExtract").addEventListener("click", pcExtract);
$("pcRun").addEventListener("click", pcRun);
$("pcStop").addEventListener("click", () => {
  pc.stopRequested = true;
  $("pcStop").disabled = true;
  pcStatus("지금 점검 중인 묶음까지 마치고 멈춥니다...");
});
$("pcCsv").addEventListener("click", pcDownloadCsv);
document.querySelectorAll("#pcQuick button").forEach((b) => {
  b.addEventListener("click", () => pcSetQuickTypes(b.dataset.types));
});
pcUpdateCount();
pcRefreshControls();
