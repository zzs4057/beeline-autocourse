import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(testsDir)
  .filter((name) => /^verify-.*\.mjs$/.test(name))
  .sort();

let failed = 0;

for (const test of tests) {
  console.log(`\n>>> ${test}`);
  const result = spawnSync(process.execPath, [path.join(testsDir, test)], {
    stdio: 'inherit'
  });
  if (result.status !== 0) failed++;
}

if (failed) {
  console.error(`\n${failed}/${tests.length} test files failed.`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} test files passed.`);
