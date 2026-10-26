import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('beeline-autocourse.user.js', root), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
const metaVersion = (source.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '';

const checks = [];
const ok = (name, condition, detail) => {
  checks.push(condition);
  console.log((condition ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -> ' + detail : ''));
};

console.log('=== Publication Sanitization Checks ===\n');
ok('userscript and package versions match',
  !!metaVersion && metaVersion === pkg.version, `${metaVersion} / ${pkg.version}`);
ok('no personal GitHub account in distribution',
  !/github\.com\/[A-Za-z0-9_.-]+\//.test(source) &&
  !pkg.repository &&
  !/github\.com\/[A-Za-z0-9_.-]+\//.test(
    fs.readFileSync(new URL('README.md', root), 'utf8')));
ok('no userscript namespace URL',
  !/^\/\/ @namespace/m.test(source));
ok('manual opt-in is required by default',
  /enabled:\s*false/.test(source) &&
  /instantClick:\s*false/.test(source) &&
  /skipCourseware:\s*false/.test(source));
ok('no visibility or focus spoofing',
  !/defineProperty\(document,\s*['"]hidden['"]/.test(source) &&
  !/defineProperty\(document,\s*['"]visibilityState['"]/.test(source) &&
  !/document\.hasFocus\s*=/.test(source));
ok('no simulated input or anti-detection loop',
  !/simulateActivity|humanPause|humanSeekBack/.test(source) &&
  !/new KeyboardEvent|window\.scrollBy|movementX/.test(source));
ok('no programmatic video pause',
  !/\.pause\s*\(/.test(source));
ok('no anomaly auto-refresh handler',
  !/handleAnomaly|detectAnomaly|location\.reload\s*\(/.test(source));
ok('no media prototype or playback-rate interception',
  !/HTMLMediaElement\.prototype\.play\s*=/.test(source) &&
  !/defineProperty\([^,]*playbackRate/.test(source));
ok('source has no outbound network request',
  !/\b(fetch|XMLHttpRequest|GM_xmlhttpRequest|sendBeacon|WebSocket|EventSource)\b/.test(source));
ok('no common real token patterns',
  !/(?:ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9_-]{10,}/.test(source) &&
  !/sk-[A-Za-z0-9]{16,}/.test(source));
ok('no local absolute paths',
  !/(?:[A-Za-z]:[\\/](?:Users|Codex data)|\\Users\\|\\Codex data\\)/.test(source));
ok('legal and trademark notices exist',
  fs.existsSync(new URL('NOTICE.md', root)) &&
  fs.existsSync(new URL('docs/compliance.md', root)) &&
  /user agreement/i.test(fs.readFileSync(new URL('docs/compliance.md', root), 'utf8')));

console.log(`\nResult: ${checks.filter(Boolean).length}/${checks.length} passed`);
process.exitCode = checks.some((value) => !value) ? 1 : 0;
