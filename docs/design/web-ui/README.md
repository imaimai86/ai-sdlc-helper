# Web UI design

The source of the design canvas for the local web app (`ai-sdlc-helper ui`), planned in [../../web-ui.md](../../web-ui.md).
Live, with pan, zoom and working theme switches: https://claude.ai/artifact/TnKe8fZruDfqws2tMAzZzP

- `canvas.json`: the boards and their places on the canvas.
- One `.dc.html` file per screen: `Main` (Board, dark), `BoardLight` (the same board in the light theme), `Run`,
  `NewItem`, `Settings`, `Prompts`, `Models`, `Projects`, `Roadmap` (engine support requests and the `web/` layout).

The files are design components for the canvas, not the app: the app is built in `web/` from them. Controls tagged
`Future · E-n` wait on the engine request E-n listed in web-ui.md.
