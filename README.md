# Notato

**Notato** is a desktop screen annotation overlay built with [Electron](https://www.electronjs.org/). It gives you a full-screen, always-on-top transparent layer so you can draw and highlight over anything on your display—presentations, videos, browsers, or other apps—without capturing those apps inside the tool itself.

## Features

- **Full-screen overlay** on the active display at launch, with automatic adjustment when display metrics change
- **Vector drawing** (SVG): pen, straight lines, arrows, rectangles and circles (outline and filled), eraser, and a selection tool to move, resize, rotate, and flip content
- **Background modes**: transparent, blackboard, or whiteboard (also available via global shortcuts)
- **Multiple canvases** with automatic saving to disk
- **Click-through when idle**: toggle drawing off so the mouse passes through to the apps underneath; toggle the overlay visibility from the tray or shortcuts
- **System tray** for quick show/hide
- **Global shortcuts** (see below) so you can control the overlay without focusing it first

## Requirements

- [Node.js](https://nodejs.org/) (current LTS recommended) and npm

## Development

From the repository root:

```bash
cd electron
npm install
npm start
```

This runs the app in development with Electron.

## Building installers

Packaging is configured with [electron-builder](https://www.electron.build/). From `electron/`:

```bash
npm run dist
```

Outputs are written to `electron/out/`. Targets include Windows (NSIS), macOS (DMG), and Linux (AppImage), as defined in `electron/package.json`.

To produce an unpacked directory without a full installer:

```bash
npm run pack
```

## Global shortcuts

Shortcuts use **Ctrl+Shift** on Windows and Linux, and **⌘⇧ (Command+Shift)** on macOS.

| Shortcut | Action |
|----------|--------|
| **A** | Toggle drawing on/off (when off, mouse events pass through the overlay) |
| **D** | Toggle overlay visibility (show/hide window) |
| **B** | Set background to blackboard |
| **W** | Set background to whiteboard |
| **X** | Clear the current canvas |
| **Q** | Quit the application |

Tray icon click toggles overlay visibility, matching the **D** shortcut behavior.

## Where data is stored

Notato keeps its data under your user application data directory (not inside the project folder):

- **Windows:** `%APPDATA%\Notato\Notato\data`
- **macOS:** `~/Library/Application Support/Notato/Notato/data`
- **Linux:** `~/.local/share/notato/data`

State and canvas files are JSON on disk; nothing is sent to a remote server by this app.

## Project layout

- **`electron/`** — Electron main process, preload bridge, renderer (HTML/CSS/JS), and build configuration

## License

No license is specified in this repository yet. Add a `LICENSE` file if you intend to distribute or accept contributions.
