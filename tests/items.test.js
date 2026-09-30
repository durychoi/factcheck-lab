"use strict";
// 출고 전 점검(items.js): 구간 나누기, 항목 추출 검증, 묶음, 항목 판정 보정, 1차 확인처, CSV
const assert = require("assert");
const { load } = require("./load");
const lib = load(["splitSentences", "chunkSentences", "normalizeItemExtraction", "buildGroups", "estimatePrecheck",
  "normalizeItemVerdicts", "primarySourcesFor", "buildCsv", "buildItemExtractionPrompt"]);

const ART = "가상지수는 7033.92로 마감했다. 거래대금은 12조 원이었다.\n사회: 시작하죠.\n가상인 소장: 가상지수는 강하다.";
const sentences = lib.splitSentences(ART);
const chunk = { context: [], target: sentences };
const items = lib.normalizeItemExtraction({ sentences: [
  { sentence_no: 1, topic: "가상지수", search_query: "가상지수 종가", items: [
    { type: "수치", expression: "7033.92", check: "가상지수 종가는 7033.92다" },
    { type: "수치", expression: "7000.00", check: "문장에 없는 값" },
    { type: "수치", expression: "7033.92", check: "중복" }] },
  { sentence_no: 2, topic: "가상지수", search_query: "거래대금", items: [
    { type: "수치", expression: "12조 원", check: "거래대금 12조 원" }] },
  { sentence_no: 4, topic: "좌담", search_query: "q", items: [
    { type: "인용", expression: "가상지수는 강하다", check: "x" },
    { type: "인물·직함", expression: "가상지수", check: "y", person_query: "가상인 가상연구소 소장" }] },
  { sentence_no: 99, topic: "x", search_query: "x", items: [{ type: "수치", expression: "1", check: "z" }] },
] }, chunk);

const ev = [
  { id: 1, type: "공공기관", title: "가상거래소 시황", summary: "가상지수는 7,013.92에 마감", url: "https://test.invalid/1" },
  { id: 2, type: "기타", title: "가상 블로그", summary: "7033.92", url: "https://test.invalid/2" },
  { id: 3, type: "백과", title: "가상 백과", summary: "거래대금 12조 원", url: "https://test.invalid/3" },
];

module.exports = [
  ["구간 나누기: 약 3,000자, 앞 구간 3문장 맥락", () => {
    const s = Array.from({ length: 100 }, (_, i) => ({ no: i + 1, text: "가".repeat(90) + ".", speaker: null }));
    const chunks = lib.chunkSentences(s);
    assert.ok(chunks.length >= 3 && chunks.length <= 4);
    assert.strictEqual(chunks[1].context.length, 3);
    assert.strictEqual(chunks.flatMap((c) => c.target).length, 100);
  }],
  ["항목 추출: 원문 표현이 문장에 없으면 버림, 중복·좌담 인용·없는 문장 버림", () => {
    assert.deepStrictEqual(items.map((i) => [i.sentenceNo, i.type, i.expression]),
      [[1, "수치", "7033.92"], [2, "수치", "12조 원"], [4, "인물·직함", "가상지수"]]);
  }],
  ["인물 검색어는 직함을 뺀 이름·기관", () => {
    assert.strictEqual(items[2].query, "가상인 가상연구소");
    assert.strictEqual(items[2].speaker, "가상인 소장");
    assert.match(lib.buildItemExtractionPrompt(chunk), /직함은 절대 넣지 마라/);
  }],
  ["묶음: 같은 주제는 합치고 인물은 따로, 사용량 계산", () => {
    const groups = lib.buildGroups(items);
    assert.deepStrictEqual(groups.map((g) => g.items.length), [2, 1]);
    const est = lib.estimatePrecheck(groups);
    assert.deepStrictEqual([est.items, est.tavilyMin, est.tavilyMax, est.gemini], [3, 2, 4, 2]);
  }],
  ["항목 판정 보정: 불일치 값 대조, [백과]만이면 원자료 확인, [기타]만이면 확인 불가, 응답 누락", () => {
    const g = { items: [items[0], items[1], items[0], items[0], items[1]] };
    const out = lib.normalizeItemVerdicts({ items: [
      { item_no: 1, used_evidence: [1], evidence_value: "7,013.92", verdict: "불일치", reason: "근거 [1]은 7,013.92" },
      { item_no: 2, used_evidence: [3], evidence_value: "", verdict: "일치", reason: "[3]" },
      { item_no: 3, used_evidence: [1], evidence_value: "7,000", verdict: "불일치", reason: "근거에 없는 값" },
      { item_no: 4, used_evidence: [2], evidence_value: "", verdict: "일치", reason: "[2]" },
    ] }, g, ev);
    assert.deepStrictEqual(out.map((r) => r.verdict), ["불일치", "일치", "확인 불가", "확인 불가", "확인 불가"]);
    assert.strictEqual(out[0].evidenceValue, "7,013.92");
    assert.deepStrictEqual(out.map((r) => r.rawCheck), [false, true, true, true, true]);
    assert.match(out[2].reason, /그대로 나오지 않아/);
  }],
  ["근거 없음만으로는 불일치 불가(근거 번호 없으면 확인 불가)", () => {
    const out = lib.normalizeItemVerdicts({ items: [
      { item_no: 1, used_evidence: [], evidence_value: "", verdict: "불일치", reason: "근거에 없음" }] },
    { items: [items[0]] }, ev);
    assert.strictEqual(out[0].verdict, "확인 불가");
  }],
  ["1차 확인처 연결", () => {
    const hint = (type, check) => lib.primarySourcesFor({ type, expression: "", check, sentence: "" })[0].name;
    assert.strictEqual(hint("수치", "코스피 종가"), "KRX 정보데이터시스템");
    assert.match(hint("수치", "기준금리"), /ECOS/);
    assert.match(hint("수치", "출산율"), /KOSIS/);
    assert.match(hint("사건", "시행령 개정"), /국가법령정보센터/);
    assert.match(hint("인물·직함", ""), /소속 기관/);
    assert.match(hint("사건", "가상 행사"), /원자료/);
  }],
  ["CSV: 엑셀용 BOM, 수식 방지, 미점검 표시", () => {
    const csv = lib.buildCsv([{ item: { ...items[0], sentence: '=HYPERLINK("x")' }, result: null }]);
    assert.ok(csv.startsWith("﻿문장번호,"));
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
    assert.ok(csv.includes("미점검"));
  }],
];
