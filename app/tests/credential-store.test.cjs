"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createCredentialStore } = require("../credential-store.cjs");
test("Windows DPAPI encrypts credentials outside plaintext and restores Unicode; later saves supersede earlier snapshots", { skip: process.platform !== "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miku-dpapi-test-")), store = createCredentialStore({ directory });
  try {
    const records = [{ id: "fixture-session", name: "记住登录的测试账号", jar: [["MUSIC_U", "fixture-private-cookie"]] }];
    await store.save(records); const ciphertext = fs.readFileSync(store.file, "utf8");
    assert.ok(!ciphertext.includes("MUSIC_U") && !ciphertext.includes("fixture-private-cookie") && !ciphertext.includes("测试账号"));
    assert.deepEqual(createCredentialStore({ directory }).load(), records);
    await Promise.all([store.save(records), store.save([])]); assert.deepEqual(store.load(), []);
    fs.writeFileSync(store.file, "damaged-encrypted-data"); assert.deepEqual(store.load(), []);
  } finally { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); }
});
