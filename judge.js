"use strict";
// Gemini 응답 검증과 판정 보정. DOM에 의존하지 않는다.
// 의존: evidence.js (WEAK_SOURCE_TYPE)

const VERDICTS = ["사실", "대체로 사실", "절반의 사실", "대체로 거짓", "거짓", "판단 유보"];
const HOLD = "판단 유보";
const TRUE_VERDICTS = ["사실", "대체로 사실"];
const FALSE_VERDICTS = ["거짓", "대체로 거짓"];
const CLAIM_TYPES = ["검증 가능한 사실", "미래 예측·전망", "가정", "의견"];
const FACT_CLAIM = CLAIM_TYPES[0];
const NOTE_KINDS = ["사실진술", "의견·규범", "무관"];
const NOTE_STANCES = ["지지", "반박", "중립"];
const UNUSABLE_KINDS = ["의견·규범", "무관"]; // used_evidence로 선언해도 판정 근거로 인정하지 않는 성격
const MAX_REASONS = 3;
const BAD_REF = "[번호 오류]";

// 이유 문장 속 근거 인용을 찾아 [번호] 형식으로 통일한다.
// 인식하는 형식: [5], [1, 3], 근거 5, 5번 근거  ("근거 5건"처럼 개수를 말하는 경우는 제외)
// 목록에 없는 번호는 [번호 오류]로 바꾼다.
function processReason(text, validIds) {
  const cited = new Set();
  const ref = (n) => {
    if (!validIds.has(n)) return BAD_REF;
    cited.add(n);
    return `[${n}]`;
  };
  const out = text
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, list) => {
      const nums = list.split(",").map((s) => Number(s.trim()));
      const ok = nums.filter((n) => validIds.has(n));
      ok.forEach((n) => cited.add(n));
      if (ok.length === 0) return BAD_REF;
      return `[${ok.join(", ")}]` + (ok.length < nums.length ? " " + BAD_REF : "");
    })
    .replace(/근거\s*(\d+)(?![\d건개])/g, (m, n) => "근거 " + ref(Number(n)))
    .replace(/(\d+)\s*번\s*근거/g, (m, n) => "근거 " + ref(Number(n)));
  return { text: out, cited };
}

function readNotes(raw, validIds) {
  return new Map(
    (Array.isArray(raw.evidence_notes) ? raw.evidence_notes : [])
      .filter((n) => n && validIds.has(n.id) && NOTE_KINDS.includes(n.kind))
      .map((n) => [n.id, { kind: n.kind, stance: NOTE_STANCES.includes(n.stance) ? n.stance : "중립" }])
  );
}

function unverifiableReason(claimType) {
  return `검증할 수 없는 ${claimType}입니다. 현재 확인 가능한 사실이 아니므로 판단을 유보합니다.`;
}

// 코드가 판정을 판단 유보로 바꿔야 하면 그 사유를, 아니면 null을 돌려준다.
function findOverride(verdict, claimType, used, notes) {
  if (verdict === HOLD) return null;
  if (claimType !== FACT_CLAIM) return unverifiableReason(claimType);
  if (used.length === 0) return "판정에 쓸 수 있는 사실 근거를 근거 목록에서 확인할 수 없어 판단을 유보합니다.";
  if (used.every((e) => e.type === WEAK_SOURCE_TYPE)) {
    return `신뢰도 높은 출처(공공기관·언론·학술·백과) 없이 [${WEAK_SOURCE_TYPE}] 출처만으로는 판정할 수 없어 판단을 유보합니다.`;
  }
  const hasFact = (stance) => used.some((e) => {
    const n = notes.get(e.id);
    return n && n.kind === "사실진술" && n.stance === stance;
  });
  if (FALSE_VERDICTS.includes(verdict) && !hasFact("반박")) {
    return "주장을 반박하는 사실 근거가 없어 판단을 유보합니다. 지지 근거가 없다는 것만으로는 거짓으로 판정하지 않습니다.";
  }
  if (TRUE_VERDICTS.includes(verdict) && !hasFact("지지")) {
    return "주장을 지지하는 사실 근거가 없어 판단을 유보합니다.";
  }
  return null;
}

// 출처는 Tavily 근거 목록에서 번호로만 찾는다. 목록에 없는 번호는 버린다.
function normalizeResult(raw, evidence) {
  const validIds = new Set(evidence.map((e) => e.id));
  const notes = readNotes(raw, validIds);
  const claimType = CLAIM_TYPES.includes(raw.claim_type) ? raw.claim_type : FACT_CLAIM;

  const cited = new Set();
  let reasons = (Array.isArray(raw.reasons) ? raw.reasons : [])
    .filter((s) => typeof s === "string" && s.trim())
    .slice(0, MAX_REASONS)
    .map((s) => {
      const r = processReason(s.trim(), validIds);
      r.cited.forEach((n) => cited.add(n));
      return r.text;
    });

  // 선언한 근거(의견·규범·무관 제외) + 이유 문장에서 인용한 근거 = 판정에 사용
  const declared = [...new Set(Array.isArray(raw.used_evidence) ? raw.used_evidence : [])]
    .filter((n) => Number.isInteger(n) && validIds.has(n))
    .filter((n) => !UNUSABLE_KINDS.includes(notes.get(n)?.kind));
  const usedIds = new Set([...declared, ...cited]);
  const used = evidence.filter((e) => usedIds.has(e.id)).sort((a, b) => a.id - b.id);

  const verdict = VERDICTS.includes(raw.verdict) ? raw.verdict : HOLD;
  const override = findOverride(verdict, claimType, used, notes);
  if (override) {
    // 이유를 코드 문장으로 바꾸므로 인용 번호도 사라진다. 사용 근거도 비워 번호 불일치를 막는다.
    return { verdict: HOLD, reasons: [override], used: [], notes, claimType };
  }
  if (claimType !== FACT_CLAIM && !reasons.some((r) => r.includes("검증할 수 없"))) {
    reasons = [unverifiableReason(claimType), ...reasons].slice(0, MAX_REASONS);
  }
  return { verdict, reasons, used, notes, claimType };
}

if (typeof module !== "undefined") {
  module.exports = { normalizeResult, processReason };
}
