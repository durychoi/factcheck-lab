"use strict";
// 문장 분석·핵심 주장 판정 보정(judge.js)
const assert = require("assert");
const { load } = require("./load");
const { normalizeResult, processReason } = load(["normalizeResult", "processReason"]);

const ev = [1, 2, 3, 4, 5].map((id) => ({
  id, type: id === 5 ? "공공기관" : "언론", title: `t${id}`, url: `https://test.invalid/${id}`,
}));
const note = (id, kind, stance) => ({ id, kind, stance });
const FACT = "검증 가능한 사실";

module.exports = [
  ["이유에서 인용한 [5]도 판정에 사용으로 표시", () => {
    const r = normalizeResult({ claim_type: FACT, evidence_notes: [note(1, "사실진술", "지지"), note(5, "사실진술", "지지")],
      verdict: "사실", reasons: ["근거 [5]에 따르면 3만 명이다."], used_evidence: [1, 2, 3, 4] }, ev);
    assert.deepStrictEqual(r.used.map((e) => e.id), [1, 2, 3, 4, 5]);
    assert.strictEqual(r.verdict, "사실");
  }],
  ["인용된 의견 근거도 사용으로 표시", () => {
    const r = normalizeResult({ claim_type: FACT, evidence_notes: [note(1, "사실진술", "지지"), note(2, "의견·규범", "반박")],
      verdict: "사실", reasons: ["[1] 지지, [2]는 의견"], used_evidence: [1] }, ev);
    assert.deepStrictEqual(r.used.map((e) => e.id), [1, 2]);
  }],
  ["목록에 없는 번호는 [번호 오류], '근거 5건'은 인용 아님", () => {
    assert.strictEqual(processReason("근거 [9]와 [1, 9], 근거 3, 4번 근거, 근거 5건", new Set([1, 3, 4])).text,
      "근거 [번호 오류]와 [1] [번호 오류], 근거 [3], 근거 [4], 근거 5건");
  }],
  ["미래 예측은 거짓이 아니라 판단 유보", () => {
    const r = normalizeResult({ claim_type: "미래 예측·전망", evidence_notes: [note(1, "사실진술", "반박")],
      verdict: "거짓", reasons: ["[1]"], used_evidence: [1] }, ev);
    assert.strictEqual(r.verdict, "판단 유보");
    assert.match(r.reasons[0], /검증할 수 없는 미래 예측/);
    assert.strictEqual(r.used.length, 0);
  }],
  ["반박하는 사실 근거 없이 거짓 불가", () => {
    const r = normalizeResult({ claim_type: FACT, evidence_notes: [note(1, "사실진술", "중립")],
      verdict: "거짓", reasons: ["[1]"], used_evidence: [1] }, ev);
    assert.strictEqual(r.verdict, "판단 유보");
  }],
  ["반박하는 사실 근거가 있으면 거짓 유지", () => {
    const r = normalizeResult({ claim_type: FACT, evidence_notes: [note(5, "사실진술", "반박")],
      verdict: "거짓", reasons: ["[5]"], used_evidence: [5] }, ev);
    assert.strictEqual(r.verdict, "거짓");
  }],
  ["지지하는 사실 근거 없이 사실 불가", () => {
    const r = normalizeResult({ claim_type: FACT, evidence_notes: [note(2, "의견·규범", "지지")],
      verdict: "사실", reasons: ["[2]"], used_evidence: [2] }, ev);
    assert.strictEqual(r.verdict, "판단 유보");
  }],
  ["[기타] 출처만으로는 판단 유보", () => {
    const weak = [{ id: 1, type: "기타", title: "x", url: "https://test.invalid/x" }];
    const r = normalizeResult({ claim_type: FACT, evidence_notes: [note(1, "사실진술", "지지")],
      verdict: "사실", reasons: ["[1]"], used_evidence: [1] }, weak);
    assert.strictEqual(r.verdict, "판단 유보");
  }],
];
