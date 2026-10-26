"use strict";
// Windows DPAPI binds the encrypted file to the current Windows user and machine.
// Neither platform cookies nor encryption keys are written into the project.
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
function command(decrypt) {
  const transform = decrypt
    ? "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputText), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))"
    : "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($inputText), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const source = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $inputText=[Console]::In.ReadToEnd(); [Console]::Out.Write(${transform})`;
  return ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")];
}
function createCredentialStore(options = {}) {
  if (process.platform !== "win32") return null;
  const directory = options.directory || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MikuFocus", "auth");
  const file = path.join(directory, "netease-sessions.dpapi");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let pending = Promise.resolve();
  function load() {
    if (!fs.existsSync(file)) return [];
    try {
      const sealed = fs.readFileSync(file, "utf8"); if (sealed.length > 4 * 1024 * 1024) return [];
      const result = spawnSync(powershell, command(true), { input: sealed, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      if (result.status !== 0) return [];
      const data = JSON.parse(result.stdout); return data.version === 1 && Array.isArray(data.sessions) ? data.sessions : [];
    } catch { return []; }
  }
  function encrypt(text) {
    return new Promise((resolve, reject) => {
      const child = spawn(powershell, command(false), { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      let output = "", settled = false;
      const done = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(new Error("无法安全保存登录，请检查 Windows 用户权限。")) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); done(true); }, 15000);
      child.on("error", () => done(true)); child.stdin.on("error", () => done(true));
      child.stdout.on("data", chunk => { output += chunk; if (output.length > 4 * 1024 * 1024) { child.kill(); done(true); } });
      child.on("close", code => done(code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output), output));
      child.stdin.end(text);
    });
  }
  function save(sessions) {
    const snapshot = JSON.stringify({ version: 1, sessions });
    const operation = pending.catch(() => {}).then(async () => {
      await fsp.mkdir(directory, { recursive: true });
      const sealed = await encrypt(snapshot), temp = path.join(directory, `.${randomBytes(12).toString("hex")}.tmp`);
      try { await fsp.writeFile(temp, sealed, { flag: "wx", mode: 0o600 }); await fsp.rename(temp, file); }
      finally { await fsp.unlink(temp).catch(() => {}); }
    });
    pending = operation; return operation;
  }
  return { load, save, flush: () => pending, file };
}
module.exports = { createCredentialStore };
