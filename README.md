# ClubCut

A browser-based game-film editor for college club sports. Import an MP4, mark individual plays, label and reorder them, then export one MP4 highlight reel. Video processing happens locally in the browser using FFmpeg WebAssembly; footage is not uploaded to a server.

## Run locally

Requires Node.js 20.19+ or 22.12+ and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The development server sets the cross-origin isolation headers required by the FFmpeg worker. The first export downloads the FFmpeg core from jsDelivr, so an internet connection is required for that first load.

## Publish updates

The live site is https://tombudka1.github.io/clubcut/, served by GitHub Pages from the `gh-pages` branch. After changing the code:

```sh
git add -A
git commit -m "Describe the change"
git push
npm run deploy
```

`git push` saves the source code to GitHub. `npm run deploy` builds the site and publishes it, and the live page updates about a minute later.

GitHub Pages can't send the cross-origin isolation headers FFmpeg needs, so `public/coi-serviceworker.js` adds them in the browser. Each visitor's first page load reloads once while it installs.

## Games split across several files

Many cameras start a new file every ~4 GB or ~12 minutes, and some teams record each half separately. Select or drop all of the MP4s at once. ClubCut sorts them by filename, which keeps camera chapter order such as GH010042, GH020042, and plays them back to back as one game. Use the arrows on each file in the **Footage** bar to fix the order, the × to remove a file, or **Add file** to append more. Dashed orange lines on the timeline mark where one file ends and the next begins.

Auto-cut scans every file, and plays that cross a file break are handled automatically at export. With no plays marked, **Export joined** combines the files into one full-length MP4.

Fast export joins files without re-encoding, which works when they come from the same camera at the same settings. If the files come from different cameras or resolutions, turn on **Frame-accurate**.

## Cutting dead time automatically

1. Choose an MP4 using **Add game footage**.
2. Choose **Find live play**. ClubCut samples the game about once per second and measures how much of the picture changes between samples. Live play, with players running and the camera following the ball, scores high. Dead time scores low: huddles, walking back to the line, injury stoppages, waiting on a pull or a restart. A 90-minute game takes a few minutes to scan.
3. Check the activity strip. The lime areas are kept. Drag **Strictness** until only live play is lime, and use **Lead-in** to keep a few seconds of setup before each play. Then choose **Apply cuts**.
4. Press play with **Skip dead time** on to watch the cut version. Trim, delete, or add plays as needed.
5. Choose **Export video**. By default the export copies the video stream instead of re-encoding it, so a full game exports quickly with no quality loss. Cuts snap to the nearest keyframe, usually within a second or two. Turn on **Frame-accurate** for exact cuts; this re-encodes every play and is much slower.

Detection works best with a mostly fixed or slowly panning sideline camera. Footage with constant shaking, or crowds walking in front of the lens, will need a higher strictness.

## Editing by hand

1. Choose an MP4 using **Add game footage**.
2. Seek to a play's start and choose **Mark a play**. Each new selection starts at the playhead and defaults to a 10-second range (or the remaining duration).
3. Select the play in the playbook. Set its in/out points at the current playhead, rename it, choose a play type, or move it in the reel order.
4. Choose **Export reel** to render and download the compilation.

Export re-encodes each selection to H.264/AAC before joining clips. Rendering time and maximum usable source size depend on the device's memory and CPU; for long recordings, use a desktop browser and close other memory-heavy tabs. Only MP4 source files are supported for reliable export.
