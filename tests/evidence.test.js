"use strict";
// 출처 분류, 근거 중복 제거·다양성 선정, 원 기사 사본 제외(sources.js, evidence.js)
const assert = require("assert");
const { load } = require("./load");
const { classifySource, selectEvidence } = load(["classifySource", "selectEvidence"]);

const mk = (title, url, score) => ({ title, url, score, summary: "" });

module.exports = [
  ["출처 유형 분류", () => {
    const got = ["https://www.law.go.kr/x", "https://www.kci.go.kr/a", "https://encykorea.aks.ac.kr/a",
      "https://snu.ac.kr/a", "https://www.yna.co.kr/v", "https://ko.wikipedia.org/w", "https://test.invalid/a",
      "https://evilgo.kr/a"].map(classifySource);
    assert.deepStrictEqual(got, ["공공기관", "학술", "백과", "학술", "언론", "백과", "기타", "기타"]);
  }],
  ["같은 논문 사본은 하나만, 유형당 2건, [기타]는 빈자리만", () => {
    const r = selectEvidence([
      mk("가상 논문 제목 - KCI", "https://www.kci.go.kr/a?id=1", 0.9),
      mk("가상 논문 제목 | KISS", "https://kiss.kstudy.com/b", 0.85),
      mk("가상 논문 제목 - DBpia", "https://www.dbpia.co.kr/c", 0.8),
      mk("다른 가상 논문", "https://www.kci.go.kr/a?id=2", 0.7),
      mk("세 번째 가상 논문", "https://www.riss.kr/d", 0.6),
      mk("가상 헌재 결정", "https://www.ccourt.go.kr/e", 0.5),
      mk("가상 법령", "https://www.law.go.kr/f", 0.4),
      mk("가상 기사", "https://www.yna.co.kr/g", 0.3),
      mk("가상 백과", "https://ko.wikipedia.org/wiki/x", 0.2),
      mk("가상 기타", "https://test.invalid/h", 0.95),
    ]);
    assert.deepStrictEqual(r.selected.map((e) => e.type), ["공공기관", "공공기관", "언론", "학술", "백과"]);
    assert.strictEqual(r.all.filter((e) => e.status === "중복 제외").length, 2);
  }],
  ["원 기사 URL과 제목 사본은 근거에서 제외", () => {
    const r = selectEvidence([
      mk("가상지수 7000 돌파 - 가상신문", "https://test.invalid/news/1", 0.9),
      mk("가상지수 7000 돌파 | 가상포털", "https://test.invalid/portal/9", 0.8),
      mk("다른 기사", "https://test.invalid/other", 0.7),
    ], { exclude: { url: "https://test.invalid/news/1", title: "가상지수 7000 돌파" } });
    assert.deepStrictEqual(r.all.map((e) => e.status), ["원 기사·사본 제외", "원 기사·사본 제외", ""]);
    assert.strictEqual(r.selected.length, 1);
  }],
  ["근거 수·유형 상한 옵션", () => {
    const items = Array.from({ length: 6 }, (_, i) => mk(`가상 기사 ${i}번 제목 ${"가나다라"[i % 4]}`, `https://www.yna.co.kr/${i}`, 1 - i / 10));
    assert.strictEqual(selectEvidence(items).selected.length, 2);
    assert.strictEqual(selectEvidence(items, { maxEvidence: 8, maxPerType: 3 }).selected.length, 3);
  }],
];
