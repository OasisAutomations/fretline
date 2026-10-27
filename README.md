# Fretline

An independent, single-page rhythm game. Load your own music, put your own video behind the highway, and play along with five lanes. Not affiliated with or endorsed by any other game or brand. No music or video is included; everything you load stays on your device.

Live: https://oasisautomations.github.io/fretline/

## Features
- 5 lanes: **A S D F G** (rebindable) or tap the lanes on a touch screen. Space (or the star button) uses star power. Esc pauses.
- Perfect / Good / Miss timing, combo multiplier up to x4 (x8 with star power), results screen with grade and best scores.
- **Your music**: mp3, wav, m4a, ogg from a file picker or drag-and-drop. The chart is generated in your browser from the audio (onset detection plus tempo detection) at Easy, Medium, Hard or Expert density.
- **Your background**: a muted, looping video (mp4, webm, mov where the browser supports it) or an image, with a dim slider. The video is kept in sync with the song. You can also use the video's own audio as the song.
- **Chart recorder**: tap along to a song to record your own chart; it is saved per song in IndexedDB and can be chosen instead of the auto chart.
- Settings saved locally: difficulty, note speed, audio/visual offset (with a tap calibration), video sync offset, dim, key bindings.
- Built-in demo track, synthesized in the browser.
- Installable and fully offline (service worker).

## Notes and limits
- Auto charts assume a fairly steady tempo and have no sustain notes. Music with a clear beat works best. Use the recorder when you want an exact chart.
- Audio files themselves are not stored; re-select a file and its saved analysis and recorded chart are found again (matched by name, size and date).
- Video support depends on the browser's codecs (H.264 mp4 and webm are safest; HEVC .mov often will not play in Chrome).
- On iPhone, audio starts after your first tap, and Fullscreen is not available in Safari (use Add to Home Screen).

## Run locally
Static files only: serve this folder with any web server (for example `python3 -m http.server`) and open it. The service worker needs http(s), not `file://`.
