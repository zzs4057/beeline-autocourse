# Compliance

This project is intended for ordinary DOM navigation assistance.

This document is an engineering risk disclosure, not legal advice or a legal
clearance. The operator's user agreement reviewed on 2026-10-25 prohibits
using technical means to interfere with the service and using automatic
devices to monitor or copy web pages or content. Automated navigation may
therefore breach the platform agreement even without any anti-detection code.

Reference:
<https://cdnobs.51xinwei.com/resources/xinwei/html/mx/userPrivacy.html>

## Implemented

- Reading visible course structure.
- Clicking normal page controls available to the user.
- Detecting loading states and refusing premature jumps.
- Pausing automation when the page is not foreground.

## Not implemented

- Visibility or focus spoofing.
- Platform event suppression.
- Fake heartbeat or progress messages.
- Direct calls to course completion APIs.
- Credential or cookie collection.
- Anti-cheat bypasses.
- Visibility/focus spoofing, simulated input, anomaly auto-refresh, or
  playback-rate locking.

## User responsibilities

- Follow platform terms and course rules.
- Keep course windows foreground when required.
- Do not use the project to fabricate attendance, answers, assessments, or completion records.
- Respect copyright and access restrictions.

The maintainers do not guarantee that any platform will accept automated
interaction. Public release does not create platform authorization and may
lead to account action, a rights-holder complaint, repository takedown, or
other legal claims.

Before public distribution, a qualified lawyer should review the planned
distribution under applicable law. Platform terms and page behavior may change
after the date above.
