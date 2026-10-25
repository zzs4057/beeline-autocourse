# Architecture

The project is distributed as a single Tampermonkey/Violentmonkey userscript.

## Runtime layers

1. **Bootstrap**
   - Domain restriction through `@match`.
   - Top-frame-only and singleton guards.
2. **Configuration**
   - Defaults, validation, persistence, and core-switch recovery.
3. **Foreground guard**
   - Uses normal browser visibility/focus APIs.
   - Pauses automatic behavior when the course window is not foreground.
4. **Media layer**
   - Finds visible/current videos across same-origin frames.
   - Tracks ready state, seeking, loading indicators, and stable completion.
5. **Course navigation**
   - Strict next-dialog recognition.
   - Static courseware and empty-node detection.
   - Standard/custom collapsed chapter expansion.
   - Document-order search for the next timed video.
6. **Click state machine**
   - Gate, random delay, click, confirmation samples, and backoff.
7. **UI and diagnostics**
   - Three-tab control panel.
   - Logs, current chapter, progress, and DOM diagnostics.

## Main loops

- Main tick: default `0.5s`.
- Next-button scanner: default `10s`.
- DOM mutation: early next-button check with a minimum interval.

## Completion rules

A video is considered complete only when:

- The selected video is the current visible/playing video.
- The video is at or near its end.
- It is not seeking or loading.
- No visible loading spinner is present.
- The completion state remains stable for at least `1.5s`.

Hidden, ended, or preloaded side videos are ignored.
