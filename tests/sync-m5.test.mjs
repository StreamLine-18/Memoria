/* Sync M5: key rotation, device revocation, skipped old-key bundles, future
 * clock guard, passphrase key cache, and superseded decisions in sync. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

const dbmod = require("../dist/engine/store/db.js");
const keys = require("../dist/engine/sync/keys.js");
const folder = require("../dist/engine/sync/folder.js");
const bundle = require("../dist/engine/sync/bundle.js");
const { addMemoryWithDedupe } = require("../dist/engine/extract/dedupe.js");

const PASS = "m5-test-passphrase";
const shared = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-m5-share-"));
const dirs = {};
function use(name) {
  dbmod.closeDb();
  if (!dirs[name]) dirs[name] = fs.mkdtempSync(path.join(os.tmpdir(), `memoria-m5-${name}-`));
  dbmod.initDb(dirs[name]);
}
const mem = (content, over = {}) =>
  dbmod.insertMemory({ projectId: null, kind: "fact", content, importance: 0.6, createdAt: Date.now(), sourceTool: "test", status: "active", origin: "user", ...over });
const byContent = (c) => dbmod.allMemories().find((m) => m.content === c) ?? null;
const memsyncFiles = () => fs.readdirSync(shared).filter((f) => f.endsWith(".memsync"));

let recovery;
let deviceC;

test("three devices share a folder", async () => {
  use("a");
  recovery = keys.setupSync({ passphrase: PASS, deviceName: "dev-a" }).recoveryCode;
  folder.setSharedFolder(shared, { passphrase: PASS });
  mem("shared before rotation");
  assert.ok(folder.exportPendingToFolder({ passphrase: PASS }).exported);

  for (const name of ["b", "c"]) {
    use(name);
    keys.setupSync({ joinCode: recovery, passphrase: PASS, deviceName: `dev-${name}` });
    folder.setSharedFolder(shared, { passphrase: PASS });
    const scan = await folder.scanAndApplyFolder({ passphrase: PASS });
    assert.equal(scan.failed, 0);
    assert.ok(byContent("shared before rotation"), `${name} received A's memory`);
  }
  use("c");
  deviceC = dbmod.getDeviceId();
  mem("written by C");
  assert.ok(folder.exportPendingToFolder({ passphrase: PASS }).exported);

  use("a");
  await folder.scanAndApplyFolder({ passphrase: PASS });
  assert.ok(byContent("written by C"));
  const devices = keys.listDevices();
  assert.ok(devices.some((d) => d.self));
  assert.ok(devices.some((d) => d.deviceId === deviceC && d.bundles >= 1), "C is listed from its applied bundles");
});

test("A revokes C: new key, C's later bundles are skipped (not failures)", async () => {
  use("a");
  const before = keys.syncStatus({ passphrase: PASS }).groupId;
  const r = keys.revokeDevice(deviceC.slice(0, 10), { passphrase: PASS });
  assert.equal(r.deviceId, deviceC);
  assert.equal(r.previousGroupId, before);
  assert.notEqual(r.groupId, before);
  assert.deepEqual(keys.previousGroupIds(), [before]);
  assert.throws(() => keys.revokeDevice(dbmod.getDeviceId().slice(0, 8), { passphrase: PASS }), /this device/);
  mem("secret after rotation");
  const ex = folder.exportPendingToFolder({ passphrase: PASS, force: true, full: true });
  assert.ok(ex.exported);

  // C still has the old key: cannot read A's new bundle.
  use("c");
  const scanC = await folder.scanAndApplyFolder({ passphrase: PASS });
  assert.equal(byContent("secret after rotation"), null, "revoked device cannot read new data");
  assert.ok(scanC.failed >= 1, "C sees the new bundle as undecryptable");
  mem("C after revocation");
  folder.exportPendingToFolder({ passphrase: PASS });

  // A skips C's old-key bundle quietly.
  use("a");
  const scanA = await folder.scanAndApplyFolder({ passphrase: PASS });
  assert.equal(scanA.failed, 0, "old-key and revoked bundles are skipped, not errors");
  assert.equal(byContent("C after revocation"), null);
  assert.equal(keys.listDevices().find((d) => d.deviceId === deviceC).revoked, true);
});

test("B rejoins with the new code and catches up from the full export", async () => {
  use("b");
  keys.setupSync({ joinCode: r2(), passphrase: PASS, deviceName: "dev-b", force: true });
  const scan = await folder.scanAndApplyFolder({ passphrase: PASS });
  assert.equal(scan.failed, 0);
  assert.ok(byContent("secret after rotation"));
  assert.equal(byContent("C after revocation"), null);
});
// The new recovery code, read back from A's stored key.
function r2() {
  const cur = dirs.b;
  use("a");
  const { encodeRecoveryCode } = require("../dist/engine/sync/crypto.js");
  const code = encodeRecoveryCode(keys.loadGroupKey({ passphrase: PASS }));
  dbmod.closeDb();
  dbmod.initDb(cur);
  return code;
}

test("superseded decisions travel through sync", async () => {
  use("a");
  const pid = dbmod.ensureProject("m5-proj", undefined);
  addMemoryWithDedupe({ projectId: pid, kind: "decision", content: "Decided to use Postgres on Neon for staging data.", importance: 0.6, createdAt: Date.now() - 5000, lastAccessed: 0, accessCount: 0, sourceTool: "test", status: "active", origin: "user" });
  addMemoryWithDedupe({ projectId: pid, kind: "decision", content: "Decided to move staging from Postgres on Neon to Supabase for auth.", importance: 0.6, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "test", status: "active", origin: "user" });
  const old = dbmod.readMemories("WHERE content LIKE 'Decided to use Postgres on Neon%'", [])[0];
  assert.ok(old.validTo > 0);
  assert.ok(folder.exportPendingToFolder({ passphrase: PASS }).exported);

  use("b");
  const scan = await folder.scanAndApplyFolder({ passphrase: PASS });
  const row = dbmod.getDb().prepare("SELECT m.superseded_by, m.valid_to, s.content AS by FROM memories m JOIN memories s ON s.id = m.superseded_by WHERE m.content LIKE 'Decided to use Postgres on Neon%'").get();
  assert.ok(row, "superseded_by mapped to B's local id of the newer decision");
  assert.match(row.by, /Supabase/);
  assert.ok(row.valid_to > 0);
});

test("bundles claiming a clock far in the future are refused", () => {
  use("a");
  const key = keys.loadGroupKey({ passphrase: PASS });
  const future = `${String(Date.now() + 3 * 86400000).padStart(13, "0")}.000000.evil-device`;
  const file = path.join(os.tmpdir(), `m5-future-${Date.now()}.memsync`);
  bundle.writeBundleFile(file, [{ opId: "evil:1", hlc: future, entity: "memory", entityUid: "u-evil", op: "upsert", payload: { kind: "fact", content: "from the future", importance: 0.5, createdAt: 1, status: "active", origin: "user", archived: 0, tags: [] } }], key, "evil-device");
  assert.throws(() => bundle.readBundleFile(file, key), /future/);
  assert.equal(bundle.hlcWallMs("0001795000000000.000001.x"), 1795000000000);
});

test("passphrase-unlocked key is cached (scrypt runs once per process)", () => {
  use("a");
  const t0 = process.hrtime.bigint();
  keys.loadGroupKey({ passphrase: PASS });
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) keys.loadGroupKey({ passphrase: PASS });
  const t2 = process.hrtime.bigint();
  assert.ok(Number(t2 - t1) / 20 < Math.max(Number(t1 - t0), 5e6), "cached unlock is fast");
  assert.throws(() => keys.loadGroupKey({ passphrase: "wrong" }), /passphrase/i);
});
