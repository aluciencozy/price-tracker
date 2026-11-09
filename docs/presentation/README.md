# Price Tracker presentation

This is preparation material, **not yet ready for the live presentation**. As of November 9, 2026, local integration was verified; approved hosting, SwaggerHub publication, and the full live notification chain remain open. See [the presenter guide](presenter-guide.md) before using the deck.

## Rebuild

Requires Node 24, npm and LibreOffice. After the separate diagram contribution is integrated, run from the repository root:

```sh
npm ci --prefix docs/presentation/tools
node docs/presentation/build.mjs
libreoffice -env:UserInstallation=file:///tmp/opencode/lo-presentation --headless --convert-to pdf --outdir docs/presentation docs/presentation/price-tracker.pptx
```

The source uses the existing early web wireframes and the six PNG exports in `docs/diagrams/presentation/`. For an unmerged diagram worktree, set `DIAGRAMS_DIR` to its absolute `docs/diagrams/presentation` directory before running the build. The build fails if any actual diagram is missing. The slide text, shapes and cards are editable PowerPoint objects; diagram and wireframe images are exported visuals. Narration and timing are embedded in speaker notes. Do not commit `tools/node_modules`.

The live demonstration URLs are deliberately unfilled, not example URLs. Update the slides and notes only after the team approves actual public URLs; never put passwords, access tokens, provider keys or private account information in the deck.
