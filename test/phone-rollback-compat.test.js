import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Room } from '../room.js';

// This verifies the exact old serializer changes required by the deployment
// rollback plan. It does not read or change any live room.
test('compatibility rollback preserves phone identity, owner, seats, chips and immutable history for re-upgrade', async t => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'phone-rollback-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  let CompatibilityRoom;
  if (process.env.PHONE_ROLLBACK_ROOM) ({ Room: CompatibilityRoom } = await import(pathToFileURL(path.resolve(process.env.PHONE_ROLLBACK_ROOM)).href));
  let baseline;
  if (!CompatibilityRoom) {
  try { baseline = execFileSync('git', ['show', 'e9cde307a3b7e2d30111ee4b52c2f71f1cbdef86:room.js'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { t.skip('baseline Git object is not bundled in isolated deployment source'); return; }
  const compat = baseline.replace("from './engine.js'", `from '${pathToFileURL(path.join(root, 'engine.js')).href}'`)
    .replace('    room.ownerToken = data.ownerToken;', '    room.ownerToken = data.ownerToken;\n    room.phoneIdentity = data.phoneIdentity ?? null;')
    .replace('      ownerToken: this.ownerToken,', '      ownerToken: this.ownerToken,\n      ...(this.phoneIdentity ? { phoneIdentity: this.phoneIdentity, displayIdentityVersion: 0 } : {}),');
  const modulePath = path.join(temporary, 'room.mjs');
  writeFileSync(modulePath, compat);
  ({ Room: CompatibilityRoom } = await import(pathToFileURL(modulePath).href));
  }
  const room = new Room('810301');
  const first = room.joinPhone('Original', '+12025550101');
  room.command(first.token, { type: 'sit', seat: 0, buyIn: 2345 });
  room.joinPhone('Latest', '+12025550101');
  const data = JSON.parse(JSON.stringify(room.toJSON()));
  const old = CompatibilityRoom.fromJSON(data);
  old.join('Rollback guest');
  const serialized = JSON.parse(JSON.stringify(old.toJSON()));
  assert.deepEqual(serialized.phoneIdentity, data.phoneIdentity);
  assert.equal(serialized.members[0].phoneKey, data.members[0].phoneKey);
  assert.equal(serialized.displayIdentityVersion, 0);
  assert.deepEqual(serialized.events, data.events);
  const upgraded = Room.fromJSON(serialized);
  const same = upgraded.joinPhone('After upgrade', '+12025550101');
  assert.equal(same.id, first.id);
  assert.equal(same.token, first.token);
  assert.equal(same.seat, 0);
  assert.equal(same.stack, 2345);
  assert.equal(upgraded.ownerToken, first.token);
  assert.equal(upgraded.members.size, 2);
  assert.equal(upgraded.stateFor(first.token).events[0].text.startsWith('After upgrade '), true);
});
