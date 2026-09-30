// Keyboard: viewer KeyboardEvent data to Chrome DevTools Protocol Input.dispatchKeyEvent parameters,
// and the browser shortcuts the viewer turns into toolbar actions instead of sending to the page.

/** DevTools protocol bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(e) {
  return (e.alt ? 1 : 0) | (e.ctrl ? 2 : 0) | (e.meta ? 4 : 0) | (e.shift ? 8 : 0);
}

function textOf(e) {
  if (e.ctrl || e.meta || e.alt) return undefined;
  if (e.key === 'Enter') return '\r';
  return typeof e.key === 'string' && e.key.length === 1 ? e.key : undefined;
}

/** e: {type: 'down'|'up', key, code, keyCode, location, repeat, alt, ctrl, meta, shift}. */
export function toCdpKeyEvent(e) {
  const base = {
    modifiers: modifiersOf(e),
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: e.keyCode,
    nativeVirtualKeyCode: e.keyCode,
    location: e.location,
    isKeypad: e.location === 3,
    autoRepeat: e.type === 'down' && Boolean(e.repeat),
  };
  if (e.type === 'up') return { type: 'keyUp', ...base };
  const text = textOf(e);
  return text === undefined ? { type: 'rawKeyDown', ...base } : { type: 'keyDown', ...base, text, unmodifiedText: text };
}

/** Toolbar action for a browser shortcut on key down, or null to send the key to the page. */
export function browserShortcut(e) {
  if (e.type !== 'down') return null;
  const k = typeof e.key === 'string' ? e.key : '';
  if (e.ctrl && !e.alt && !e.meta) {
    if (k === 'Tab') return e.shift ? 'prev-tab' : 'next-tab';
    switch (k.toLowerCase()) {
      case 'l': return 'focus-address';
      case 'r': return 'reload';
      case 't': return 'new-tab';
      case 'w': return 'close-tab';
      default: return null;
    }
  }
  if (e.alt && !e.ctrl && !e.meta) {
    if (k === 'ArrowLeft') return 'back';
    if (k === 'ArrowRight') return 'forward';
  }
  if (k === 'F5' && !e.ctrl && !e.alt && !e.meta) return 'reload';
  return null;
}
