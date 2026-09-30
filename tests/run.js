"use strict";
// 사용법: node tests/run.js
// tests 폴더의 *.test.js를 모두 실행한다. 각 파일은 [이름, 함수] 배열을 내보낸다.
// 시험 데이터 규칙: URL은 test.invalid, 인물·기관은 "가상" 이름(사용자가 준 재현 사례 제외).
const fs = require("fs");
const path = require("path");

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
let passed = 0;
const failures = [];

for (const file of files) {
  for (const [name, fn] of require(path.join(__dirname, file))) {
    try {
      fn();
      passed++;
    } catch (err) {
      failures.push({ file, name, err });
    }
  }
}

for (const f of failures) {
  console.log(`실패  ${f.file} › ${f.name}\n      ${String(f.err.message).split("\n").join("\n      ")}`);
}
console.log(`\n${files.length}개 파일, 시험 ${passed + failures.length}개: 통과 ${passed}, 실패 ${failures.length}`);
process.exitCode = failures.length ? 1 : 0;
