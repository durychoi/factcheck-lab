"use strict";
// 브라우저용 스크립트(전역 선언)를 index.html과 같은 순서로 한 범위에 불러와, 요청한 이름을 돌려준다.
const fs = require("fs");
const path = require("path");

const SCRIPTS = ["sources.js", "evidence.js", "judge.js", "article.js", "items.js"];

function load(names) {
  const root = path.join(__dirname, "..");
  const src = SCRIPTS.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${src}\n;return { ${names.join(", ")} };`)();
}

module.exports = { load };
