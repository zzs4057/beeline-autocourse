# Configuration

Configuration is stored in browser `localStorage` under `BL_COURSE_CFG_V1`.

| Key | Default | Description |
|---|---:|---|
| `enabled` | `false` | Master switch; requires explicit opt-in |
| `autoNext` | `true` | Enable next-section automation |
| `guardSkipAhead` | `true` | Require the current video to finish |
| `instantClick` | `false` | Use the more aggressive immediate scan path |
| `skipCourseware` | `false` | Skip static courseware and empty nodes |
| `autoPlay` | `true` | Resume playback in foreground |
| `pptDwell` | `5` | Static-content dwell time in seconds |
| `scanEvery` | `10` | Next-button scan interval |
| `clickDelayMin` | `0.3` | Minimum click delay |
| `clickDelayMax` | `2.5` | Maximum click delay |
| `interval` | `0.5` | Main tick interval |
| `endThreshold` | `1` | End-of-video threshold in seconds |
| `completionPercent` | `100` | Completion target as a percentage of video duration |
| `playRate` | `1` | Playback rate |

Invalid values are repaired by `sanitizeConfig()` and fall back to safe defaults.
