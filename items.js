"use strict";
// 출고 전 점검(전수 점검)의 순수 로직. DOM에 의존하지 않는다.
// 의존: judge.js (processReason), evidence.js (WEAK_SOURCE_TYPE)

// ── 설정 ────────────────────────────────────────────
const ITEM_TYPES = ["수치", "날짜", "인물·직함", "기관·명칭", "사건", "인용"];
const PERSON_TYPE = "인물·직함";
const ITEM_VERDICTS = ["일치", "근사", "불일치", "확인 불가"];
const UNKNOWN = "확인 불가";
const VALUE_VERDICTS = ["근사", "불일치"]; // 근거상 값이 필요한 판정
const RAW_CHECK_TYPES = ["백과", "기타"]; // 이 유형 근거뿐이면 원자료 확인 필요
const CHUNK_CHARS = 3000; // 추출 1회에 보내는 분량
const CONTEXT_SENTENCES = 3; // 앞 구간에서 맥락용으로 함께 보내는 문장 수
const GROUP_MAX_SENTENCES = 5;
const GROUP_MAX_ITEMS = 12;
const SECONDS_PER_GROUP = 10; // 예상 소요 시간 계산용(대기 4초 포함)

// 인물 검색어에서 뺄 직함. 확인할 대상(직함)을 검색어에 넣으면 확증 편향이 생긴다.
// TITLE_WORDS: 낱말 전체가 이것과 같을 때만 뺀다. "연구원"은 빼도 "한국개발연구원"(기관명)은 남긴다.
// "이코노미스트"는 매체명과 겹쳐 넣지 않는다.
const TITLE_WORDS = [
  "교수", "부교수", "조교수", "명예교수", "소장", "장관", "차관", "대표", "회장", "사장",
  "의원", "위원", "원장", "총장", "학장", "대사", "청장", "처장", "실장", "국장", "과장",
  "부장", "차장", "팀장", "연구원", "애널리스트", "전무", "상무", "이사", "대통령", "총리",
  "도지사", "군수", "구청장", "판사", "검사", "변호사", "기자", "대변인", "수석", "비서관", "행정관",
  "총재", "부총재", "최고경영자", "CEO", "CFO", "CIO", "대행", "전", "현", "前", "現",
];
// COMPOUND_TITLES: 복합 직함. 낱말이 이것으로 끝나면 뺀다(예: "KDI선임연구원", "가상증권리서치센터장").
const COMPOUND_TITLES = [
  "선임연구원", "수석연구원", "책임연구원", "선임연구위원", "수석연구위원", "연구위원", "리서치센터장",
  "센터장", "본부장", "연구소장", "위원장", "이사장", "부회장", "부사장", "대표이사", "직무대행",
];

// ── 1차 확인처 (확인 불가 항목 안내용, API 호출 없음) ─────────────
const PRIMARY_SOURCES = [
  { name: "KRX 정보데이터시스템", url: "https://data.krx.co.kr",
    re: /코스피|코스닥|코넥스|지수|주가|종가|시가총액|거래대금|거래량|상장|증시|ETF|공매도|외국인 순매수|순매도/ },
  { name: "한국은행 경제통계시스템(ECOS)", url: "https://ecos.bok.or.kr",
    re: /금리|기준금리|환율|원·달러|원\/달러|달러당|통화량|M2|국고채|회사채|외환보유액|경상수지|가계부채|가계신용|소비자물가|물가상승률|GDP|성장률/ },
  { name: "KOSIS 국가통계포털", url: "https://kosis.kr",
    re: /인구|출생|출산율|사망|고령|가구|고용|실업|취업자|고용률|통계청|임금|소득|주택|미분양/ },
  { name: "국가법령정보센터", url: "https://www.law.go.kr",
    re: /법률|법령|시행령|시행규칙|조항|제\s?\d+\s?조|헌법|개정안|법안|특별법/ },
  { name: "전자공시시스템(DART)", url: "https://dart.fss.or.kr",
    re: /매출|영업이익|순이익|당기순|공시|실적|배당|지분|자사주|유상증자|인수합병/ },
  { name: "국회 의안정보시스템", url: "https://likms.assembly.go.kr/bill",
    re: /의안|발의|본회의|상임위|국회 통과|가결|부결/ },
  { name: "중앙선거관리위원회 선거통계시스템", url: "http://info.nec.go.kr",
    re: /득표|투표율|개표|당선|선거/ },
  { name: "헌법재판소", url: "https://www.ccourt.go.kr", re: /헌법재판소|헌재|위헌|합헌|헌법불합치/ },
  { name: "대법원 사법정보공개포털", url: "https://portal.scourt.go.kr", re: /대법원|판결|판례|선고/ },
];
const PERSON_SOURCE_HINT = { name: "소속 기관 공식 홈페이지(인물·조직 소개)", url: "" };
const DEFAULT_SOURCE_HINT = { name: "원자료(보도자료·공식 발표) 직접 확인", url: "" };

function primarySourcesFor(item) {
  const text = `${item.expression} ${item.check} ${item.sentence}`;
  const hits = PRIMARY_SOURCES.filter((s) => s.re.test(text)).slice(0, 2).map(({ name, url }) => ({ name, url }));
  if (item.type === PERSON_TYPE) return [PERSON_SOURCE_HINT, ...hits].slice(0, 2);
  return hits.length ? hits : [DEFAULT_SOURCE_HINT];
}

// ── 추출 ────────────────────────────────────────────
// 문장 목록을 약 CHUNK_CHARS 단위 구간으로 나눈다. 각 구간에는 앞 구간의 끝 문장 몇 개를 맥락으로 붙인다.
function chunkSentences(sentences) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const s of sentences) {
    if (cur.length && len + s.text.length > CHUNK_CHARS) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += s.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((target, i) => {
    const prev = i > 0 ? chunks[i - 1].slice(-CONTEXT_SENTENCES) : [];
    return { context: prev, target };
  });
}

function formatSentence(s) {
  return `(${s.no}) ${s.speaker ? `[화자: ${s.speaker}] ` : ""}${s.text}`;
}

function buildItemExtractionPrompt(chunk) {
  return [
    "너는 출고 전 사실 확인 담당 편집자다. [대상 문장]에서 확인할 수 있는 사실 항목을 빠짐없이 뽑아라.",
    "",
    "[항목 단위]",
    "- 사실 하나가 항목 하나다. 한 문장에 수치가 둘이면 항목도 둘이다.",
    `- type은 다음 중 하나: ${ITEM_TYPES.join(" / ")}`,
    "- expression: 기사 문장에 적힌 표현을 한 글자도 바꾸지 말고 그대로 옮겨라(예: 7033.92, 3.5%, 9월 26일, 김영익 소장).",
    "- check: 무엇을 확인하는지 문장 하나로 정리하라. 지시어는 실제 이름으로 바꾸고, 원문에 없는 정보는 덧붙이지 마라.",
    "- 의견·평가, 미래 예측·전망, 가정은 뽑지 마라.",
    "- 인용: 누가 그렇게 말했는지를 확인하는 항목이다. [화자: ○○]가 붙은 좌담·인터뷰 문장에는 인용 항목을 만들지 마라.",
    "",
    "[검색어]",
    "- 문장마다 topic(짧은 주제명, 예: 코스피 지수)과 search_query(그 문장의 사실을 확인할 검색어)를 적어라.",
    "- 같은 주제의 문장에는 같은 topic을 써라.",
    "- 인물·직함 항목에는 person_query를 적어라: 이름과 소속 기관 키워드만 쓴다. 직함은 절대 넣지 마라(예: \"김영익 서강대\").",
    "",
    "[맥락 문장] (참고만 하고 여기서는 뽑지 마라)",
    chunk.context.map(formatSentence).join("\n") || "(없음)",
    "",
    "[대상 문장]",
    chunk.target.map(formatSentence).join("\n"),
  ].join("\n");
}

const ITEM_EXTRACTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    sentences: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        propertyOrdering: ["sentence_no", "topic", "search_query", "items"],
        properties: {
          sentence_no: { type: "INTEGER" },
          topic: { type: "STRING" },
          search_query: { type: "STRING" },
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              propertyOrdering: ["type", "expression", "check", "person_query"],
              properties: {
                type: { type: "STRING", enum: ITEM_TYPES },
                expression: { type: "STRING" },
                check: { type: "STRING" },
                person_query: { type: "STRING" },
              },
              required: ["type", "expression", "check"],
            },
          },
        },
        required: ["sentence_no", "topic", "search_query", "items"],
      },
    },
  },
  required: ["sentences"],
};

// 직함 낱말인지: 직함 목록과 낱말 전체가 같거나, 복합 직함으로 끝나면 직함이다.
function isTitleWord(w) {
  return TITLE_WORDS.includes(w) || COMPOUND_TITLES.some((t) => w === t || w.endsWith(t));
}
function stripTitles(query) {
  return String(query || "")
    .split(/\s+/)
    .filter((w) => w && !isTitleWord(w))
    .join(" ")
    .trim();
}

function str(v) { return typeof v === "string" ? v.trim() : ""; }

// 추출 응답 검증. 문장 번호는 이번 구간에 있는 것만, expression은 그 문장에 글자 그대로 있어야 받는다.
// 반환: 항목 배열 { sentenceNo, sentence, speaker, type, expression, check, topic, query }
function normalizeItemExtraction(raw, chunk) {
  const byNo = new Map(chunk.target.map((s) => [s.no, s]));
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(raw?.sentences) ? raw.sentences : []) {
    const s = entry && byNo.get(entry.sentence_no);
    if (!s) continue;
    const topic = str(entry.topic) || `문장 ${s.no}`;
    const sentenceQuery = str(entry.search_query) || s.text.slice(0, 120);
    for (const it of Array.isArray(entry.items) ? entry.items : []) {
      const expression = str(it?.expression);
      const type = ITEM_TYPES.includes(it?.type) ? it.type : null;
      if (!type || !expression || !s.text.includes(expression)) continue;
      if (type === "인용" && s.speaker) continue;
      const key = `${s.no}|${type}|${expression}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const personQuery = stripTitles(str(it.person_query) || expression);
      out.push({
        sentenceNo: s.no,
        sentence: s.text,
        speaker: s.speaker || null,
        type,
        expression,
        check: str(it.check) || expression,
        topic,
        query: type === PERSON_TYPE ? (personQuery || stripTitles(sentenceQuery)) : sentenceQuery,
      });
    }
  }
  return out;
}

// ── 검색 묶음 ────────────────────────────────────────
// 인물·직함 항목은 인물 검색어별로, 나머지는 같은 주제끼리 묶는다(문장 5개·항목 12개 상한).
function groupKey(item) {
  return item.type === PERSON_TYPE ? `인물|${item.query}` : `주제|${item.topic.replace(/\s+/g, "")}`;
}

function buildGroups(items) {
  const open = new Map();
  const groups = [];
  const sorted = [...items].sort((a, b) => a.sentenceNo - b.sentenceNo);
  for (const item of sorted) {
    const key = groupKey(item);
    let g = open.get(key);
    const sentences = g ? new Set(g.items.map((i) => i.sentenceNo)) : null;
    const full = g && (g.items.length >= GROUP_MAX_ITEMS ||
      (!sentences.has(item.sentenceNo) && sentences.size >= GROUP_MAX_SENTENCES));
    if (!g || full) {
      g = { key, query: item.query, topic: item.topic, items: [] };
      open.set(key, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups.map((g, i) => ({ ...g, id: i + 1 }));
}

function estimatePrecheck(groups) {
  const g = groups.length;
  return {
    groups: g,
    items: groups.reduce((n, x) => n + x.items.length, 0),
    tavilyMin: g,
    tavilyMax: g * 2,
    gemini: g,
    minutes: Math.ceil((g * SECONDS_PER_GROUP) / 60),
  };
}

// ── 항목 판정 ────────────────────────────────────────
function buildItemJudgePrompt(group, evidence) {
  const sentenceNos = [...new Set(group.items.map((i) => i.sentenceNo))];
  const sentences = sentenceNos.map((no) => {
    const it = group.items.find((i) => i.sentenceNo === no);
    return `(${no}) ${it.speaker ? `[화자: ${it.speaker}] ` : ""}${it.sentence}`;
  });
  const items = group.items.map((it, i) =>
    `<${i + 1}> 문장 ${it.sentenceNo} | 유형: ${it.type} | 원문 표현: ${it.expression} | 확인할 내용: ${it.check}`);
  const list = evidence.map((e) => `[${e.id}] 출처유형: ${e.type}\n제목: ${e.title}\n요약: ${e.summary}`).join("\n\n");
  return [
    "너는 출고 전 사실 확인 담당자다. 아래 [근거 목록]에 적힌 내용만으로 [확인할 사실 항목]을 하나씩 판정하라.",
    "",
    "[판정 기준]",
    `- verdict는 반드시 다음 중 하나: ${ITEM_VERDICTS.join(" / ")}`,
    "  - 일치: 근거가 같은 값·사실을 직접 적고 있다.",
    "  - 근사: 반올림, 단위, 표기 차이만 있다(예: 7,033.9와 7033.92).",
    "  - 불일치: 근거가 같은 대상·시점에 대해 다른 값·사실을 직접 적고 있다.",
    "  - 확인 불가: 관련 근거가 없거나, 근거끼리 충돌하거나, 근거의 대상·시점이 다르다.",
    "- 근거가 없다는 것만으로는 불일치가 될 수 없다. 그때는 확인 불가다.",
    "- 근사·불일치이면 evidence_value에 근거에 적힌 값을 한 글자도 바꾸지 말고 그대로 옮겨라. 일치·확인 불가이면 빈 문자열.",
    "- 인물·직함은 근거가 그 사람의 다른 직함을 같은 시점 기준으로 적고 있을 때만 불일치다. 과거 직함과 헷갈리지 마라.",
    "- 근거 목록 밖의 지식, 추측, 기억으로 판정하지 마라.",
    "- used_evidence에는 판정에 쓴 근거 번호만 넣어라. reason은 한국어 한 문장이며 근거는 [번호] 형식으로 인용하라.",
    "- 모든 항목에 대해 item_no를 빠짐없이 적어라.",
    "",
    `[기사 문장]\n${sentences.join("\n")}`,
    "",
    `[확인할 사실 항목]\n${items.join("\n")}`,
    "",
    `[근거 목록]\n${list}`,
  ].join("\n");
}

const ITEM_JUDGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        propertyOrdering: ["item_no", "used_evidence", "evidence_value", "verdict", "reason"],
        properties: {
          item_no: { type: "INTEGER" },
          used_evidence: { type: "ARRAY", items: { type: "INTEGER" } },
          evidence_value: { type: "STRING" },
          verdict: { type: "STRING", enum: ITEM_VERDICTS },
          reason: { type: "STRING" },
        },
        required: ["item_no", "used_evidence", "evidence_value", "verdict", "reason"],
      },
    },
  },
  required: ["items"],
};

function squash(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

// 근거상 값이 인용한 근거의 제목·요약에 글자 그대로(공백 차이만 허용) 있는지
function valueInEvidence(value, used) {
  const v = squash(value);
  return Boolean(v) && used.some((e) => squash(`${e.title} ${e.summary}`).includes(v));
}

function unknown(reason) {
  return { verdict: UNKNOWN, reason, used: [], evidenceValue: "" };
}

// 항목 하나의 판정 보정
function normalizeOneItem(raw, evidence) {
  if (!raw) return unknown("판정 응답에 이 항목이 없어 확인 불가로 둡니다.");
  const validIds = new Set(evidence.map((e) => e.id));
  const reason = processReason(str(raw.reason), validIds);
  const declared = (Array.isArray(raw.used_evidence) ? raw.used_evidence : [])
    .filter((n) => Number.isInteger(n) && validIds.has(n));
  const usedIds = new Set([...declared, ...reason.cited]);
  const used = evidence.filter((e) => usedIds.has(e.id));
  const verdict = ITEM_VERDICTS.includes(raw.verdict) ? raw.verdict : UNKNOWN;
  const value = str(raw.evidence_value);

  if (verdict === UNKNOWN) return { verdict, reason: reason.text, used, evidenceValue: "" };
  if (used.length === 0) return unknown("판정에 쓴 근거 번호가 없어 확인 불가로 둡니다.");
  if (used.every((e) => e.type === WEAK_SOURCE_TYPE)) {
    return unknown(`[${WEAK_SOURCE_TYPE}] 출처만으로는 판정할 수 없어 확인 불가로 둡니다.`);
  }
  if (VALUE_VERDICTS.includes(verdict) && !valueInEvidence(value, used)) {
    return unknown(`근거상 값(${value || "없음"})이 인용한 근거에 그대로 나오지 않아 확인 불가로 둡니다.`);
  }
  return { verdict, reason: reason.text, used, evidenceValue: VALUE_VERDICTS.includes(verdict) ? value : "" };
}

// 묶음의 판정 응답 → 항목별 결과 (group.items와 같은 순서)
function normalizeItemVerdicts(raw, group, evidence) {
  const byNo = new Map();
  for (const r of Array.isArray(raw?.items) ? raw.items : []) {
    if (r && Number.isInteger(r.item_no) && !byNo.has(r.item_no)) byNo.set(r.item_no, r);
  }
  return group.items.map((_, i) => withFlags(normalizeOneItem(byNo.get(i + 1), evidence)));
}

// 원자료 확인 필요: 확인 불가이거나, 판정 근거가 [백과]·[기타]뿐인 항목
function withFlags(result) {
  const rawCheck = result.verdict === UNKNOWN ||
    (result.used.length > 0 && result.used.every((e) => RAW_CHECK_TYPES.includes(e.type)));
  return { ...result, rawCheck };
}

function noEvidenceResults(group) {
  return group.items.map(() => withFlags(unknown("관련 근거를 찾지 못해 확인 불가로 둡니다.")));
}

// ── CSV ─────────────────────────────────────────────
const CSV_HEADERS = [
  "문장번호", "화자", "원문 문장", "원문 표현", "유형", "확인할 내용", "판정", "근거상 값",
  "이유", "근거 번호", "근거 URL", "원자료 확인 필요", "1차 확인처",
];

// 엑셀 수식으로 해석될 수 있는 첫 글자(=, +, -, @)는 작은따옴표로 막는다.
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// rows: [{ item, result }] (result가 없으면 미점검)
function buildCsv(rows) {
  const lines = rows.map(({ item, result }) => {
    const r = result || { verdict: "미점검", reason: "", used: [], evidenceValue: "", rawCheck: false };
    const hints = r.verdict === UNKNOWN ? primarySourcesFor(item).map((h) => h.url ? `${h.name} ${h.url}` : h.name) : [];
    return [
      item.sentenceNo, item.speaker || "", item.sentence, item.expression, item.type, item.check,
      r.verdict, r.evidenceValue, r.reason, r.used.map((e) => `[${e.id}]`).join(" "),
      r.used.map((e) => e.url).join(" "), r.rawCheck ? "예" : "", hints.join(" / "),
    ].map(csvCell).join(",");
  });
  return "﻿" + [CSV_HEADERS.join(","), ...lines].join("\r\n");
}

if (typeof module !== "undefined") {
  module.exports = {
    chunkSentences, normalizeItemExtraction, stripTitles, buildGroups, estimatePrecheck,
    normalizeItemVerdicts, noEvidenceResults, primarySourcesFor, buildCsv, valueInEvidence,
    buildItemExtractionPrompt, buildItemJudgePrompt,
  };
}
