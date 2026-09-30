"use strict";
// 기사 분석의 순수 로직: 문장 나누기, 원자료 확인 표시, 추출 응답 검증, 사용량 계산. DOM에 의존하지 않는다.

const MAX_ARTICLE_CHARS = 15000;
const MIN_EXTRACTED_CHARS = 200; // 가져온 본문이 이보다 짧으면 유료·차단 안내문으로 보고 실패 처리
const MAX_CANDIDATES = 10; // 추출할 주장 후보 최대 수
const MAX_SELECT = 5; // 한 번에 검증할 수 있는 주장 수
const CLAIM_KINDS = ["일반", "발언 사실", "발언 내용"];

// ── 좌담·인터뷰 화자 판별 ─────────────────────────────
// 줄 맨 앞의 "이름:" 또는 "이름 직함:" (예: "김영익 소장:", "김영익 서강대 교수:", "사회:")
const SPEAKER_LINE = /^([가-힣]{2,5}(?:\s[가-힣A-Za-z·]{1,15}){0,3})\s*[:：]\s*(.+)$/;
const MIN_SPEAKER_LINES = 2; // 이 횟수 이상 나와야 좌담·인터뷰로 본다
const NON_SPEAKER_LABELS = new Set([
  "출처", "사진", "참고", "예", "주", "자료", "제목", "부제", "요약", "결론", "문의", "그래픽", "영상",
  "관련기사", "편집자주", "일시", "장소", "참석자", "정리", "대담", "기사", "원문", "단위", "비고",
]);

// 반환: speaker(화자 이름 또는 null), body(화자 표시를 뗀 본문), notice(출처·일시 같은 일반 표기 줄 여부)
function parseSpeakerLine(para) {
  const m = SPEAKER_LINE.exec(para);
  if (!m) return { speaker: null, body: para, notice: false };
  const label = m[1].trim();
  const words = label.split(" ");
  if (NON_SPEAKER_LABELS.has(words[0]) || NON_SPEAKER_LABELS.has(words[words.length - 1])) {
    return { speaker: null, body: para, notice: true };
  }
  return { speaker: label, body: m[2].trim(), notice: false };
}

// 문장 번호와 원문은 이 목록에서만 가져온다(Gemini가 세지 않는다).
// 문단(줄바꿈)으로 먼저 나누고, 문장부호(+닫는 따옴표) 뒤 공백에서 나눈다. "3.5%"처럼 뒤에 공백이 없는 점은 나누지 않는다.
// 좌담·인터뷰로 판단되면 화자 표시 줄부터 다음 화자 표시 전까지의 문장에 speaker를 붙이고, 문장에서 화자 표시는 뗀다.
function splitSentences(text) {
  const paras = String(text).replace(/\r\n?/g, "\n").split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const parsed = paras.map(parseSpeakerLine);
  const interview = parsed.filter((p) => p.speaker).length >= MIN_SPEAKER_LINES;

  const out = [];
  let current = null;
  parsed.forEach((p, i) => {
    let body = paras[i];
    if (interview && p.speaker) {
      current = p.speaker;
      body = p.body;
    } else if (p.notice) {
      current = null; // 출처·일시 같은 표기 줄은 발언이 아니므로 화자를 끊는다
    }
    body.split(/(?<=[.!?。…][”’"'」』)\]]*)\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => out.push({ no: out.length + 1, text: s, speaker: interview ? current : null }));
  });
  return out;
}

function isUsableExtract(text) {
  return typeof text === "string" && text.trim().length >= MIN_EXTRACTED_CHARS;
}

// 숫자·날짜·금액이 들어간 표현. 놓치는 것보다 과하게 표시하는 쪽을 택한다.
const NUMERIC_PATTERNS = [
  /[0-9０-９]/,
  /%|％|퍼센트|포인트/,
  /[일이삼사오육칠팔구십백천만억조]\s?(원|달러|엔|위안|유로)/,
  /[십백천만억조]\s?(명|개|건|곳|가구|채|대|톤)/,
  /(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|서른|마흔|수십|수백|수천|수만|수억|수조|몇)\s?(명|개|곳|배|차례|번째|번|해|달|살|건|가지|개월|년|일|시간|분)/,
  /(지난해|올해|작년|내년|재작년|전년|지난달|이달|다음 달|상반기|하반기|분기|연말|연초|월말|어제|오늘|내일)/,
  /(절반|과반|곱절|최대|최소|최고|최저|역대)/,
];

function hasNumericDetail(...texts) {
  return texts.some((t) => NUMERIC_PATTERNS.some((re) => re.test(String(t || ""))));
}

function buildExtractionPrompt(sentences) {
  const list = sentences.map((s) => `(${s.no}) ${s.speaker ? `[화자: ${s.speaker}] ` : ""}${s.text}`).join("\n");
  return [
    "너는 팩트체크 편집자다. 아래 [기사 문장 목록]에서 검증할 사실 주장을 뽑아라.",
    "",
    "[추출 규칙]",
    `- 최대 ${MAX_CANDIDATES}개. 수치·날짜·사건·제도·발언처럼 사실 여부를 확인할 수 있는 주장만 뽑아라.`,
    "- 의견·평가, 미래 예측·전망, 가정은 뽑지 마라.",
    "- sentence_no에는 그 주장이 나온 문장의 번호를 적어라. 목록에 있는 번호만 쓴다.",
    "- claim은 그 문장 하나만 읽어도 뜻이 통하게 정리하라. \"그는\", \"이 회사\" 같은 지시어는 기사에 나온 실제 이름으로 바꿔라.",
    "- claim에 원문에 없는 정보를 덧붙이거나, 수치·표현을 과장하거나 완화하지 마라.",
    "",
    "[발언 구분]",
    "- 발언(직접 인용 \"…\"라고 말했다, 간접 인용 …라고 밝혔다 등)이 들어간 문장은 두 항목으로 나눠라.",
    "  - kind \"발언 사실\": 누가 (언제, 어디서) 그렇게 말했는가. 예: 홍길동 장관은 3일 국회에서 \"A는 B다\"라고 말했다.",
    "  - kind \"발언 내용\": 발언 속 사실 주장 자체. 예: A는 B다.",
    "  - 발언 내용이 의견·전망이면 \"발언 사실\" 항목만 만들어라.",
    "- 발언이 아닌 주장은 kind \"일반\".",
    "",
    "[좌담·인터뷰 화자]",
    "- [화자: ○○]가 붙은 문장은 그 화자의 발언이다. 이런 문장은 발언 사실/발언 내용으로 나누지 말고, 발언 속 사실 주장만 kind \"일반\"으로 뽑아라.",
    "- claim에 화자 이름을 넣지 마라. 화자는 화면에서 따로 붙인다.",
    "",
    `[기사 문장 목록]\n${list}`,
  ].join("\n");
}

const EXTRACTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    claims: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        propertyOrdering: ["sentence_no", "kind", "claim"],
        properties: {
          sentence_no: { type: "INTEGER" },
          kind: { type: "STRING", enum: CLAIM_KINDS },
          claim: { type: "STRING" },
        },
        required: ["sentence_no", "kind", "claim"],
      },
    },
  },
  required: ["claims"],
};

// 화자가 붙은 문장에서 kind를 정리한다: 발언 사실은 버리고, 발언 내용은 일반으로 본다.
function kindForSentence(kind, speaker) {
  const k = CLAIM_KINDS.includes(kind) ? kind : "일반";
  if (!speaker) return k;
  return k === "발언 사실" ? null : "일반";
}

// 목록에 없는 문장 번호와 빈 주장은 버린다. 원문 문장과 화자는 코드의 목록에서 붙인다.
function normalizeExtraction(raw, sentences) {
  const byNo = new Map(sentences.map((s) => [s.no, s]));
  const seen = new Set();
  return (Array.isArray(raw?.claims) ? raw.claims : [])
    .filter((c) => c && Number.isInteger(c.sentence_no) && byNo.has(c.sentence_no))
    .filter((c) => typeof c.claim === "string" && c.claim.trim())
    .map((c) => {
      const s = byNo.get(c.sentence_no);
      return {
        sentenceNo: c.sentence_no,
        sentence: s.text,
        speaker: s.speaker || null,
        kind: kindForSentence(c.kind, s.speaker),
        claim: c.claim.trim(),
      };
    })
    .filter((c) => c.kind)
    .filter((c) => {
      const k = `${c.sentenceNo}|${c.kind}|${c.claim}`;
      return seen.has(k) ? false : seen.add(k);
    })
    .slice(0, MAX_CANDIDATES)
    .sort((a, b) => a.sentenceNo - b.sentenceNo || CLAIM_KINDS.indexOf(a.kind) - CLAIM_KINDS.indexOf(b.kind))
    .map((c, i) => ({ ...c, key: i }));
}

// 주장 하나당 Tavily 1차 검색 1회 + (후보 부족 시) 2차 1회, Gemini 판정 1회
function estimateUsage(count) {
  return { tavilyMin: count, tavilyMax: count * 2, gemini: count };
}

if (typeof module !== "undefined") {
  module.exports = {
    splitSentences, hasNumericDetail, normalizeExtraction, estimateUsage, buildExtractionPrompt, isUsableExtract,
  };
}
