# Agent brief: Slack ad polish

This directory is the editable source of the 28-second showcase film. It is isolated
from production data and writes only into the surrounding standardized showcase
package.

Start here:

1. Edit copy and timing in `config.js`.
2. Edit scene DOM in `index.html` and visual design in `style.css`.
3. Edit only the paused GSAP master in `timeline.js`. Use absolute positions and keep
   `window.__seek(seconds)` deterministic.
4. Run `bun run snapshot` for the representative pass or `bun run render` for the
   complete silent encode. If capture is interrupted, use
   `bun x tsx render.ts --render --resume`; it fills holes rather than trusting the
   last frame index.
5. Inspect `../renders/contact-sheet.jpg`,
   `../evidence/refinement/temporal-strip.jpg`, and `../evidence/qa/report.json`
   before accepting the MP4.

Constraints:

- 1920×1080, 30fps, exactly 28 seconds, with no authored audio track.
- Local assets only: no network, randomness, timers, external fonts, or runtime
  fetches.
- Never expose real names or photos from supplied screenshots. Keep fictional people
  and organizations, or replace them with other clearly fictional content.
- Keep Sequences as a restrained one-line cameo.
- Camera moves must be short, motivated commits; the active focal component must stay
  inside the QA safe frame.
- Write generated results only into the surrounding package's `renders/` and
  `evidence/` directories.
- Do not replace DOM-editable messages with screenshots.

The mark is the official eight-path Slack SVG across hero, orbit, and lockup. The
field is Apple-white with the MIT wallpaper desktop behind modal/workspace scenes.
Typewriters reveal by width so carets ride the text edge. The 12–16.25s beat contains
a 2.3× superzoom with a rightward pan during the reply. Preserve the clean end hold.
