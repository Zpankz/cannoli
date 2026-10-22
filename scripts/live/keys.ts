// Key identities for CDP Input.dispatchKeyEvent. `nativeVirtualKeyCode` is the
// platform's own key code: on macOS a Windows code there names another key
// (Alt's 18 is the "1" key, Enter's 13 is "W"), and with Cmd held such an
// unhandled event runs an app-menu item (it opened Obsidian's modal About box,
// which blocks the whole app until dismissed).

const MAC_CODES: Record<string, number> = {
  Enter: 36, Escape: 53, Tab: 48, Backspace: 51, Delete: 117, " ": 49,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126, Home: 115, End: 119,
  Meta: 55, Shift: 56, Alt: 58, Control: 59,
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29,
  O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46,
};

/** Windows virtual-key code plus the matching native code for this platform. */
export function keyCodes(key: string, windowsCode: number): { windowsVirtualKeyCode: number; nativeVirtualKeyCode?: number } {
  if (process.platform !== "darwin") return { windowsVirtualKeyCode: windowsCode, nativeVirtualKeyCode: windowsCode };
  const mac = MAC_CODES[key.length === 1 ? key.toUpperCase() : key];
  return mac === undefined ? { windowsVirtualKeyCode: windowsCode } : { windowsVirtualKeyCode: windowsCode, nativeVirtualKeyCode: mac };
}
