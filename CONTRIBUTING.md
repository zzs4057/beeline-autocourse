# Contributing

Thank you for improving Beeline Autocourse.

## Before submitting a change

- Keep changes focused on course navigation and DOM reliability.
- Do not add visibility spoofing, risk-control bypasses, API completion calls, or fake progress.
- Do not include cookies, account credentials, private tokens, or unsanitized HAR files.
- Add or update regression tests for behavior changes.
- Keep documentation and configuration defaults consistent.

## Development

```bash
npm run check
npm test
```

## Commit style

Prefer concise commits:

```text
feat: support custom collapsed chapter headers
fix: ignore hidden stale video elements
docs: clarify foreground requirement
test: cover empty learning nodes
```

## Pull requests

Include:

- The problem being solved;
- The affected platform state;
- Tests run;
- Known limitations;
- Screenshots or DOM excerpts only when sanitized.
