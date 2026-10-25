// M4.3 — hermetic tests for the pure main-process helpers: the tray icon
// PNG builder and tooltip text (app/src/trayicon.ts), and the saved
// window-bounds validator (app/src/windowstate.ts). No Electron needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { buildIconPng, crc32, trayTooltipText } from '../app/src/trayicon.ts';
import { boundsOnADisplay, DEFAULT_BOUNDS, parseWindowState } from '../app/src/windowstate.ts';

test('crc32: the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('trayTooltipText: the packet format', () => {
  assert.equal(trayTooltipText(2, 1), 'Relay Chat — 2 pending, 1 approvals waiting');
  assert.equal(trayTooltipText(0, 0), 'Relay Chat — 0 pending, 0 approvals waiting');
});

test('buildIconPng: a structurally valid 16×16 PNG; the alert icon differs', () => {
  const icon = buildIconPng({ alert: false });
  const alert = buildIconPng({ alert: true });
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'the PNG signature');
  assert.equal(icon.readUInt32BE(8), 13, 'IHDR length');
  assert.equal(icon.readUInt32BE(16), 16, 'width 16');
  assert.equal(icon.readUInt32BE(20), 16, 'height 16');
  assert.equal(icon[25], 6, 'RGBA');
  const idatAt = icon.indexOf(Buffer.from('IDAT'));
  const idat = icon.subarray(idatAt + 4, idatAt + 4 + icon.readUInt32BE(idatAt - 4));
  const raw = inflateSync(idat);
  assert.equal(raw.length, 16 * (1 + 16 * 4), '16 scanlines with filter bytes');
  assert.notDeepEqual(icon, alert, 'the alert icon is visibly different');
});

test('parseWindowState: valid bounds parse; corrupt or malformed files are ignored', () => {
  assert.deepEqual(parseWindowState('{"x":10,"y":20,"width":980,"height":720}'),
    { x: 10, y: 20, width: 980, height: 720 });
  assert.equal(parseWindowState('{ not json'), null, 'corrupt JSON');
  assert.equal(parseWindowState('null'), null);
  assert.equal(parseWindowState('[]'), null, 'not an object');
  assert.equal(parseWindowState('{"x":10,"y":20}'), null, 'missing size');
  assert.equal(parseWindowState('{"x":10.5,"y":20,"width":980,"height":720}'), null, 'fractional position');
  assert.equal(parseWindowState('{"x":10,"y":20,"width":99,"height":720}'), null, 'too narrow');
  assert.equal(parseWindowState('{"x":10,"y":20,"width":980,"height":99999}'), null, 'too tall');
  assert.deepEqual(DEFAULT_BOUNDS, { x: 120, y: 100, width: 980, height: 720 });
});

test('boundsOnADisplay: on screen, off screen, and a display to the left', () => {
  const displays = [
    { x: -1920, y: 0, width: 1920, height: 1080 }, // a monitor left of primary
    { x: 0, y: 0, width: 1920, height: 1080 },
  ];
  assert.equal(boundsOnADisplay({ x: 100, y: 100, width: 980, height: 720 }, displays), true, 'on screen');
  assert.equal(boundsOnADisplay({ x: -1900, y: 100, width: 980, height: 720 }, displays), true, 'the left display');
  assert.equal(boundsOnADisplay({ x: 5000, y: 100, width: 980, height: 720 }, displays), false, 'off screen');
  assert.equal(boundsOnADisplay({ x: 3000, y: 100, width: 980, height: 720 }, displays), false, 'in the gap past the edge');
  assert.equal(boundsOnADisplay({ x: Number.NaN, y: 0, width: 980, height: 720 }, displays), false, 'defensive');
});
