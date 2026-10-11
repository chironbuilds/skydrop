# Explainer video

A 31 second vertical (1080x1920, 30 fps) video that shows how Skydrop works, in the same airmail style as the site.

```
npm install
node build.mjs                # writes skydrop-explainer.mp4 (about 90 seconds)
node build.mjs --still 8.4    # one frame at t=8.4s, to check a scene
```

- `scene.html` holds every scene. A single `render(t)` function sets the state for any time, so each frame is deterministic.
- `audio.mjs` synthesises the soundtrack (beat, bass, arpeggio, whooshes, stamp thuds). No samples.
- `build.mjs` captures frames from headless Chrome, pipes them into a bundled ffmpeg and muxes the audio.
- Set `CHROME` if Chrome is not in a standard location. Fonts load from Google Fonts, so it needs a network connection.

To change the timing, edit the `data-s` and `data-e` of each scene and the `data-d` delays inside it. If you move a cut or a stamp, update the `slams` list in `scene.html` and `build.mjs` so the flashes and thuds line up.
