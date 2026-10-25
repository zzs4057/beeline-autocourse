# Troubleshooting

## The script does not click the next chapter

1. Open the Diagnostics tab.
2. Confirm the current chapter is highlighted.
3. Confirm the “Watch next chapter” button is visible on screen.
4. Check whether the video is still loading, seeking, or not at its end.
5. Keep the course window in the foreground.

## A static courseware page is not skipped

- Confirm “Auto skip courseware” is enabled.
- Increase “Static courseware dwell time”.
- Check whether the next video is in a collapsed chapter.
- Run Diagnostics and inspect active menu text and iframe URLs.

## The page shows “This node has no file”

The script treats this as an empty node when “Auto skip courseware” is enabled. If no active menu item exists, it uses the last active item or the first incomplete timed video.

## Playback progress is invalid

Keep the browser window visible and on top. The release edition does not spoof focus or visibility.

## The wrong version appears in logs

Replace the installed script text completely, save in the userscript manager, and refresh the course page.
