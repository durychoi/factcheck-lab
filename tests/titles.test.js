"use strict";
// 인물 검색어의 직함 제거(stripTitles). 직함은 낱말 전체가 직함일 때만, 접미사 일치는 명시한 복합 직함만.
const assert = require("assert");
const { load } = require("./load");
const { stripTitles } = load(["stripTitles"]);

const cases = [
  // 사용자가 보고한 재현 사례: 기관·매체명은 남아야 한다
  ["김영익 한국개발연구원", "김영익 한국개발연구원"],
  ["홍길동 자본시장연구원", "홍길동 자본시장연구원"],
  ["홍길동 이코노미스트", "홍길동 이코노미스트"],
  // 기존 사례
  ["김영익 서강대 경제대학원 교수", "김영익 서강대 경제대학원"],
  ["홍가상 대전 연구소장", "홍가상 대전"],
  ["전 장관 박가상", "박가상"],
  // 복합 직함은 접미사로도 지운다
  ["박가상 가상증권 리서치센터장", "박가상 가상증권"],
  ["이가상 가상연구원 선임연구원", "이가상 가상연구원"],
  ["최가상 KDI수석연구원", "최가상"],
  // 낱말 전체가 직함이면 지운다
  ["정가상 가상연구소 연구원", "정가상 가상연구소"],
];

module.exports = cases.map(([input, expected]) => [
  `stripTitles("${input}")`,
  () => assert.strictEqual(stripTitles(input), expected),
]);
