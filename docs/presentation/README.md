# Price Tracker presentation

The deck has **21 timed slides**, with complete diagrams integrated into their matching sections. It covers the required sections in **12 minutes**: 11 minutes of content and live demos, followed by one minute for questions. **Questions is the final slide.** All five members have meaningful speaking parts.

The deck uses the website palette from `apps/web/src/styles.css`: off-white backgrounds, dark ink, teal accents, white cards, and pale mint highlights. The builder uses sRGB equivalents of the site's OKLCH tokens, with dark teal for readable accent text. Embedded historical wireframes and full diagram exports retain their original artwork.

Every slide has embedded speaker notes: presenter, timing, a spoken script, and a transition. Demo notes also include timed actions; detailed diagram notes include optional Q&A explanations. Overview and detail slides share their section's time allocation. Open PowerPoint's **Notes** pane or **View → Notes Page** to read them; use **Presenter View** while projecting. The [presenter guide](presenter-guide.md) contains the same scripts and the USB, rehearsal, attendance, and campus-access checklists.

This is presentation preparation, **not full live-demo acceptance**. The November 11 report records HTTPS/database readiness and updated test results; SwaggerHub demonstration, real mailbox flows, and the full qualifying notification chain remain unverified. Verify demo prerequisites before rehearsal. The scripts describe intended successes, which must actually be observed before narrating them.

## Rebuild

Requires Node 24, npm and LibreOffice. Run from the repository root:

```sh
npm ci --prefix docs/presentation/tools
node docs/presentation/build.mjs
libreoffice -env:UserInstallation=file:///tmp/price-tracker-presentation-profile --headless --convert-to pdf --outdir docs/presentation docs/presentation/price-tracker.pptx
```

Edit `speaker-notes.mjs` for scripts, roles, and timing; edit `build.mjs` for slide layouts. Rebuilding generates both the PowerPoint and presenter guide from the same notes source. The builder checks that the timed slides total 720 seconds and that text boxes stay inside slide boundaries. Render the PowerPoint and inspect it after layout edits; those checks alone cannot detect clipped text.

The source embeds existing early web wireframes and six complete PlantUML PNG exports from `docs/diagrams/presentation/`. Diagram overviews are editable PowerPoint objects derived from those sources. Each complete diagram follows its related overview; the activity diagram sits within the price-check and notification section. There are no slides after Questions. Set `DIAGRAMS_DIR` only when using another directory of matching exports. The build fails if a required diagram is missing. Do not commit `tools/node_modules`, renderer packages, or preview images.

The PDF is a slide-only backup and does not include notes; bring the presenter guide as well. The current configured team domain is recorded in the guide with its dated evidence. The SwaggerHub URL remains unfilled until publication is verified. Never put passwords, access tokens, provider keys, or private account information in the deck or USB materials.
