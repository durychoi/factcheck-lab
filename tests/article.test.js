"use strict";
// 문장 나누기, 좌담 화자, 원자료 표시, 주장 추출 검증(article.js)
const assert = require("assert");
const { load } = require("./load");
const lib = load(["splitSentences", "hasNumericDetail", "normalizeExtraction", "estimateUsage",
  "isUsableExtract", "guessTitle", "buildExtractionPrompt"]);

const TALK = `좌담 일시: 9월 1일
가상 좌담회를 열었다. 참석자는 두 명이다.
사회: 먼저 국채 얘기부터 하죠.
가상인 소장: 가상국 국채는 가상지수에 편입됐다. 자금이 들어올 것이다.
외국인 매수가 늘었다.
나가상 가상대 교수: 저는 다르게 봅니다.
출처: 가상신문`;

module.exports = [
  ["문장 나누기: 소수점은 안 나눔, 따옴표 뒤·줄바꿈에서 나눔", () => {
    const s = lib.splitSentences('가상군 인구는 2.3만 명이다. 군수는 "인구가 줄었다"라고 말했다.\n두번째 문단이다! 정말인가? 끝.');
    assert.deepStrictEqual(s.map((x) => x.text), ["가상군 인구는 2.3만 명이다.", '군수는 "인구가 줄었다"라고 말했다.',
      "두번째 문단이다!", "정말인가?", "끝."]);
  }],
  ["좌담 화자: 이어지는 문단까지 같은 화자, 출처·일시 줄은 끊음", () => {
    const s = lib.splitSentences(TALK);
    const who = (start) => s.find((x) => x.text.startsWith(start)).speaker;
    assert.strictEqual(who("가상국 국채"), "가상인 소장");
    assert.strictEqual(who("외국인 매수"), "가상인 소장");
    assert.strictEqual(who("저는"), "나가상 가상대 교수");
    assert.strictEqual(who("좌담 일시"), null);
    assert.strictEqual(who("출처"), null);
  }],
  ["화자 표시가 한 번뿐이거나 시각 표기면 화자 아님", () => {
    assert.ok(lib.splitSentences("가상인 소장: 국채가 편입됐다.\n다른 문단이다.").every((x) => x.speaker === null));
    assert.ok(lib.splitSentences("오전 10:30 회의가 열렸다.\n출처: 가상\n사진: 가상").every((x) => x.speaker === null));
  }],
  ["원자료 표시 판별(핵심 주장 탭)", () => {
    for (const t of ["3.5%", "2만 3천 명", "지난해 말", "두 배로 늘었다", "5억원", "세 차례", "역대 최대"]) {
      assert.ok(lib.hasNumericDetail(t), t);
    }
    for (const t of ["서울은 대한민국의 수도다", "군수는 인구가 줄었다고 말했다", "이번 정책은 잘못됐다"]) {
      assert.ok(!lib.hasNumericDetail(t), t);
    }
  }],
  ["주장 추출 검증: 없는 문장 번호·빈 주장 버림, 좌담 문장은 발언 사실 버림", () => {
    const s = lib.splitSentences(TALK);
    const no = s.find((x) => x.text.startsWith("가상국 국채")).no;
    const r = lib.normalizeExtraction({ claims: [
      { sentence_no: no, kind: "발언 사실", claim: "가상인 소장은 편입됐다고 말했다" },
      { sentence_no: no, kind: "발언 내용", claim: "가상국 국채는 가상지수에 편입됐다" },
      { sentence_no: 99, kind: "일반", claim: "없는 문장" },
      { sentence_no: 1, kind: "일반", claim: "  " },
    ] }, s);
    assert.deepStrictEqual(r.map((c) => [c.kind, c.speaker, c.claim]), [["일반", "가상인 소장", "가상국 국채는 가상지수에 편입됐다"]]);
    assert.match(lib.buildExtractionPrompt(s), /\[화자: 가상인 소장\] 가상국 국채/);
  }],
  ["본문 가져오기 판정·제목 추정·사용량", () => {
    assert.ok(!lib.isUsableExtract("구독자 전용 기사입니다."));
    assert.ok(lib.isUsableExtract("가".repeat(200)));
    assert.strictEqual(lib.guessTitle("\r\n## 가상지수 7000 돌파 \r\n본문"), "가상지수 7000 돌파");
    assert.deepStrictEqual(lib.estimateUsage(3), { tavilyMin: 3, tavilyMax: 6, gemini: 3 });
  }],
];
