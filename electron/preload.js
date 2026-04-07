const { contextBridge, ipcRenderer } = require("electron");

/**
 * Narrow preload bridge: renderer has no Node integration.
 * @typedef {'toggleDrawing'|'toggleVisibility'|'clearCanvas'|'setBackgroundBlackboard'|'setBackgroundWhiteboard'|'quit'} MainShortcutAction
 */

contextBridge.exposeInMainWorld("notato", {
  getOverlayState: () => ipcRenderer.invoke("window:getOverlayState"),

  /**
   * @param {(state: { drawingEnabled: boolean; overlayVisible: boolean }) => void} callback
   * @returns {() => void} unsubscribe
   */
  onOverlayState(callback) {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("overlay-state", handler);
    return () => {
      ipcRenderer.removeListener("overlay-state", handler);
    };
  },

  /**
   * @param {(action: MainShortcutAction) => void} callback
   * @returns {() => void} unsubscribe
   */
  onShortcutAction(callback) {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("shortcut-action", handler);
    return () => {
      ipcRenderer.removeListener("shortcut-action", handler);
    };
  },

  /** @param {boolean} drawingOn When false, OS passes mouse through the overlay. */
  setDrawingEnabled: (drawingOn) =>
    ipcRenderer.invoke("window:setDrawingEnabled", drawingOn),

  /** @param {boolean} visible Soft show/hide (window still exists). */
  setOverlayVisible: (visible) =>
    ipcRenderer.invoke("window:setOverlayVisible", visible),

  /** Load persisted app state (may be default). */
  loadState: () => ipcRenderer.invoke("persist:loadState"),

  /** @param {unknown} state */
  saveState: (state) => ipcRenderer.invoke("persist:saveState", state),

  /** @param {string} id */
  loadCanvas: (id) => ipcRenderer.invoke("persist:loadCanvas", id),

  /** @param {string} id @param {unknown} file */
  saveCanvas: (id, file) => ipcRenderer.invoke("persist:saveCanvas", id, file),

  /** @param {string} id */
  deleteCanvasFile: (id) => ipcRenderer.invoke("persist:deleteCanvas", id),
});
