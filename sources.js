"use strict";

// 출처 유형 분류표. 도메인을 추가·삭제할 때는 이 파일만 고치면 된다.
// 유형은 Gemini가 아니라 이 표(코드)가 결정한다.

// 우선순위: 앞쪽일수록 먼저 Gemini에 전달된다.
const SOURCE_TYPES = ["공공기관", "언론", "학술", "백과", "기타"];

const ENCYCLOPEDIA_DOMAINS = [
  "wikipedia.org", "namu.wiki", "britannica.com",
  "encykorea.aks.ac.kr", "terms.naver.com", "doopedia.co.kr",
];

const ACADEMIC_DOMAINS = ["kci.go.kr", "riss.kr", "dbpia.co.kr", "kiss.kstudy.com"];
const ACADEMIC_SUFFIXES = [".ac.kr"]; // 대학 도메인

const PUBLIC_DOMAINS = ["kosis.kr"];
const PUBLIC_SUFFIXES = [".go.kr", ".gov", ".mil"]; // 법원·헌법재판소·국가법령정보센터·통계청 포함

const PRESS_DOMAINS = [
  "yna.co.kr", "yonhapnews.co.kr", "newsis.com", "news1.kr",
  "chosun.com", "joongang.co.kr", "donga.com", "hani.co.kr", "khan.co.kr",
  "hankookilbo.com", "kmib.co.kr", "segye.com", "munhwa.com", "seoul.co.kr",
  "mk.co.kr", "hankyung.com", "sedaily.com", "edaily.co.kr", "mt.co.kr",
  "fnnews.com", "asiae.co.kr", "economist.co.kr", "heraldcorp.com",
  "kbs.co.kr", "mbc.co.kr", "sbs.co.kr", "jtbc.co.kr", "ytn.co.kr",
  "tvchosun.com", "mbn.co.kr", "ohmynews.com", "pressian.com",
  "koreaherald.com", "koreatimes.co.kr", "reuters.com", "apnews.com",
  "bbc.com", "bbc.co.uk", "nytimes.com", "washingtonpost.com",
];

// 1차 검색(include_domains)에 넣을 우선 출처
const PRIORITY_DOMAINS = [
  "go.kr", "kosis.kr",
  ...ACADEMIC_DOMAINS,
  ...PRESS_DOMAINS,
];

function hostMatches(host, domain) {
  return host === domain || host.endsWith("." + domain);
}
function hostEndsWith(host, suffix) {
  return host.endsWith(suffix) || host === suffix.slice(1);
}

// 검사 순서가 중요하다: 백과 → 학술 → 공공기관 → 언론 → 기타
// (kci.go.kr은 go.kr이기도 하고, encykorea.aks.ac.kr은 ac.kr이기도 하기 때문)
function classifySource(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "기타"; }

  if (ENCYCLOPEDIA_DOMAINS.some((d) => hostMatches(host, d))) return "백과";
  if (ACADEMIC_DOMAINS.some((d) => hostMatches(host, d)) ||
      ACADEMIC_SUFFIXES.some((s) => hostEndsWith(host, s))) return "학술";
  if (PUBLIC_DOMAINS.some((d) => hostMatches(host, d)) ||
      PUBLIC_SUFFIXES.some((s) => hostEndsWith(host, s))) return "공공기관";
  if (PRESS_DOMAINS.some((d) => hostMatches(host, d))) return "언론";
  return "기타";
}
