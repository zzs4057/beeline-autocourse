# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.4.0] - 2026-10-25

### Added

- Foreground-only automation guard.
- Clean release documentation, MIT license, CI, issue templates, and test runner.

### Changed

- Released as a compliance-focused edition.
- Visibility/focus spoofing and random page activity are no longer enabled.
- Anomaly auto-refresh is disabled by default.

### Preserved

- Strict next-chapter recognition.
- Static courseware and empty-node navigation.
- Collapsed chapter expansion and document-order video lookup.
- Video loading/buffering guards.
- Multi-video isolation and completion stability checks.

## [1.3.1] - 2026-10-25

- Added no-active-item fallback for empty learning nodes.
- Added first-incomplete-video fallback.

## [1.3.0] - 2026-10-25

- Added custom chapter header expansion.
- Added document-order lookup for videos.
- Added empty-node recognition.

## [1.2.5] - 2026-10-25

- Ignored hidden stale videos when entering static courseware.
- Added large document-viewer detection.

## [1.2.2] - 2026-10-23

- Stopped treating loading or buffering videos as completed.
- Added a stable completion window.

## [1.1.0] - 2026-10-22

- Removed global blue-button fallback.
- Added strict next-chapter dialog validation.
- Added mid-playback jump protection.
