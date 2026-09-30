"use strict";
// 근거 후보의 중복 제거와 출처 다양성 선정. DOM에 의존하지 않는다.
// 의존: sources.js (SOURCE_TYPES, classifySource)

const MAX_EVIDENCE = 5;
const MAX_PER_TYPE = 2; // 한 유형이 근거 5개 중 넘지 못하는 수
const WEAK_SOURCE_TYPE = "기타";
const DUP_SIMILARITY = 0.8; // 제목 유사도가 이 값 이상이면 같은 근거로 본다

// 사이트 꼬리표("- KCI", "| DBpia")를 떼기 위해 가장 긴 조각을 제목으로 본다
function normalizeTitle(title) {
  const parts = String(title).split(/\s[-–—|]\s/);
  const main = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
  return main.toLowerCase().replace(/[\s\-–—|:·,.()[\]{}"'“”‘’…_/~!?]+/g, "");
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // 쿼리는 유지한다: 학술 사이트는 쿼리 값으로 논문을 구분한다
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search;
  } catch { return url; }
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = bigrams(a), y = bigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  x.forEach((g) => { if (y.has(g)) common++; });
  return (2 * common) / (x.size + y.size);
}

function isDuplicate(a, b) {
  return normalizeUrl(a.url) === normalizeUrl(b.url) ||
    titleSimilarity(normalizeTitle(a.title), normalizeTitle(b.title)) >= DUP_SIMILARITY;
}

function typeRank(type) { return SOURCE_TYPES.indexOf(type); }
function byRank(a, b) { return typeRank(a.type) - typeRank(b.type) || b.score - a.score; }

// 링크로 가져온 원 기사와 그 사본(포털 전재 등)인지: URL이 같거나 제목이 같거나 거의 같다.
// 원 기사를 근거로 쓰면 기사가 자기 자신을 확인하는 순환 검증이 된다.
function isSourceCopy(e, source) {
  if (!source) return false;
  if (source.url && normalizeUrl(e.url) === normalizeUrl(source.url)) return true;
  return Boolean(source.title) &&
    titleSimilarity(normalizeTitle(e.title), normalizeTitle(source.title)) >= DUP_SIMILARITY;
}

// 반환: { selected: 번호(id)가 붙은 최종 근거, all: 전체 후보와 제외 사유(status) }
// opts: maxEvidence(최종 근거 수), maxPerType(한 유형 상한), exclude({url, title}: 원 기사)
function selectEvidence(items, opts = {}) {
  const maxEvidence = opts.maxEvidence || MAX_EVIDENCE;
  const maxPerType = opts.maxPerType || MAX_PER_TYPE;
  const ranked = items.map((e) => ({ ...e, type: classifySource(e.url), status: "" })).sort(byRank);

  // 1) 원 기사·사본 제외, 중복 제거(순위가 높은 쪽만 남긴다)
  const kept = [];
  for (const e of ranked) {
    if (isSourceCopy(e, opts.exclude)) e.status = "원 기사·사본 제외";
    else if (kept.some((k) => isDuplicate(k, e))) e.status = "중복 제외";
    else kept.push(e);
  }

  // 2) 유형별로 한 건씩 돌아가며 선정. 한 유형은 maxPerType건까지.
  // [기타]는 신뢰 출처가 자리를 다 채우지 못했을 때만 남은 자리에 들어간다.
  const buckets = SOURCE_TYPES.map((t) => kept.filter((e) => e.type === t));
  const picked = [];
  for (let round = 0; round < maxPerType; round++) {
    for (const bucket of buckets) {
      if (bucket[0]?.type === WEAK_SOURCE_TYPE) continue;
      if (bucket[round] && picked.length < maxEvidence) picked.push(bucket[round]);
    }
  }
  for (const e of kept.filter((k) => k.type === WEAK_SOURCE_TYPE).slice(0, maxPerType)) {
    if (picked.length < maxEvidence) picked.push(e);
  }
  const pickedSet = new Set(picked);
  for (const e of kept) {
    if (pickedSet.has(e)) continue;
    const sameType = kept.filter((k) => k.type === e.type);
    e.status = sameType.indexOf(e) >= maxPerType ? "유형 상한 제외" : `${maxEvidence}건 초과 제외`;
  }

  // 3) 표시·전달 순서: 유형 순위 → 점수. 번호는 이 순서로 붙인다.
  const selected = picked.sort(byRank).map((e, i) => {
    e.id = i + 1;
    return e;
  });
  return { selected, all: ranked };
}

if (typeof module !== "undefined") {
  module.exports = { selectEvidence, normalizeTitle, titleSimilarity, isDuplicate, isSourceCopy };
}
