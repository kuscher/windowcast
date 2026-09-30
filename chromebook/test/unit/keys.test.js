import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modifiersOf, toCdpKeyEvent, browserShortcut } from '../../shared/keys.js';

const key = (over) => ({ type: 'down', key: 'a', code: 'KeyA', keyCode: 65, location: 0, repeat: false,
  alt: false, ctrl: false, meta: false, shift: false, ...over });

test('modifier bits follow the DevTools protocol', () => {
  assert.equal(modifiersOf(key({})), 0);
  assert.equal(modifiersOf(key({ alt: true, ctrl: true, meta: true, shift: true })), 15);
  assert.equal(modifiersOf(key({ ctrl: true })), 2);
});

test('a plain letter types its text', () => {
  const e = toCdpKeyEvent(key({}));
  assert.equal(e.type, 'keyDown');
  assert.equal(e.text, 'a');
  assert.equal(e.windowsVirtualKeyCode, 65);
  assert.equal(e.code, 'KeyA');
  assert.equal(e.modifiers, 0);
});

test('shift letters type the shifted character', () => {
  const e = toCdpKeyEvent(key({ key: 'A', shift: true }));
  assert.equal(e.text, 'A');
  assert.equal(e.modifiers, 8);
});

test('Ctrl, Meta and Alt shortcuts never type their letter', () => {
  for (const mod of ['ctrl', 'meta', 'alt']) {
    const e = toCdpKeyEvent(key({ key: 'c', code: 'KeyC', keyCode: 67, [mod]: true }));
    assert.equal(e.type, 'rawKeyDown', mod);
    assert.equal(e.text, undefined, mod);
  }
});

test('Enter types a carriage return and arrows type nothing', () => {
  assert.equal(toCdpKeyEvent(key({ key: 'Enter', code: 'Enter', keyCode: 13 })).text, '\r');
  const arrow = toCdpKeyEvent(key({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }));
  assert.equal(arrow.type, 'rawKeyDown');
  assert.equal(arrow.text, undefined);
});

test('key up carries no text and keeps the auto-repeat flag off', () => {
  const e = toCdpKeyEvent(key({ type: 'up' }));
  assert.equal(e.type, 'keyUp');
  assert.equal(e.text, undefined);
  assert.equal(e.autoRepeat, false);
});

test('repeats and keypad keys are flagged', () => {
  const e = toCdpKeyEvent(key({ key: '1', code: 'Numpad1', keyCode: 97, location: 3, repeat: true }));
  assert.equal(e.autoRepeat, true);
  assert.equal(e.isKeypad, true);
});

test('browser shortcuts become toolbar actions', () => {
  assert.equal(browserShortcut(key({ key: 'l', ctrl: true })), 'focus-address');
  assert.equal(browserShortcut(key({ key: 'ArrowLeft', alt: true })), 'back');
  assert.equal(browserShortcut(key({ key: 'ArrowRight', alt: true })), 'forward');
  assert.equal(browserShortcut(key({ key: 'r', ctrl: true })), 'reload');
  assert.equal(browserShortcut(key({ key: 'F5' })), 'reload');
  assert.equal(browserShortcut(key({ key: 't', ctrl: true })), 'new-tab');
  assert.equal(browserShortcut(key({ key: 'w', ctrl: true })), 'close-tab');
  assert.equal(browserShortcut(key({ key: 'Tab', ctrl: true })), 'next-tab');
  assert.equal(browserShortcut(key({ key: 'Tab', ctrl: true, shift: true })), 'prev-tab');
  assert.equal(browserShortcut(key({ key: 'c', ctrl: true })), null);
  assert.equal(browserShortcut(key({ key: 'l', ctrl: true, type: 'up' })), null);
});
