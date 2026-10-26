"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const launchers = ['启动学习房间.cmd', '启动工具/一键分享学习房间.cmd', '启动工具/一键Radmin联机.cmd'];

test('root offline entry resolves every local stylesheet, script and wallpaper after reorganization', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<base href="app\/">/);
  for (const match of html.matchAll(/(?:src|href)="([^"?#]+)(?:\?[^"#]*)?"/g)) {
    const relative = match[1]; if (relative === 'app/' || /^(?:https?:|data:|\/)/.test(relative)) continue;
    assert.ok(fs.existsSync(path.join(root, 'app', relative)), relative);
  }
  const app = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8');
  for (const match of app.matchAll(/src: "(assets\/[^\"]+)"/g)) assert.ok(fs.existsSync(path.join(root, 'app', match[1])), match[1]);
});

test('moved documentation links resolve and Docker copy sources exist in the root build context', () => {
  for (const file of ['README.md', ...fs.readdirSync(path.join(root, 'docs')).map(f => 'docs/' + f)]) {
    const markdown = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].split('#')[0]; if (!link || /^(?:https?:|mailto:)/.test(link)) continue;
      assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), decodeURIComponent(link))), `${file}: ${link}`);
    }
  }
  const docker = fs.readFileSync(path.join(root, 'app/Dockerfile'), 'utf8');
  for (const line of docker.split(/\r?\n/).filter(v => v.startsWith('COPY '))) for (const source of line.split(/\s+/).slice(1, -1)) assert.ok(fs.existsSync(path.join(root, source)), source);
  assert.ok(fs.existsSync(path.join(root, 'app/Dockerfile.dockerignore')));
});

test('Windows launchers retain ASCII and CRLF', () => {
  for (const name of launchers) {
    const bytes = fs.readFileSync(path.join(root, name)); assert.ok(bytes.every(b => b < 128), name);
    assert.equal(bytes.toString('ascii').replaceAll('\r\n', '').includes('\n'), false, name);
  }
});

test('all launchers enter app/ and dispatch the same command from an unrelated working directory', { skip: process.platform !== 'win32' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-layout-test-'));
  const log = path.join(temp, 'command.json'), probe = path.join(temp, 'probe.cjs');
  try {
    fs.writeFileSync(probe, `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), openBrowser: process.env.MIKU_OPEN_BROWSER }));`);
    for (const command of ['node', 'npm']) fs.writeFileSync(path.join(temp, command + '.cmd'), `@echo off\r\n"${process.execPath}" "${probe}" ${command} %*\r\nexit /b 0\r\n`, 'ascii');
    const env = { ...process.env }; const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path'; env[pathKey] = temp + ';' + env[pathKey];
    const expected = [['npm', 'start'], ['npm', 'run', 'share'], ['node', '--env-file-if-exists=.env', 'tools/radmin.cjs']];
    for (const [i, name] of launchers.entries()) {
      const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"call "${path.join(root, name)}""`], { cwd: temp, env, input: '\r\n', encoding: 'utf8', timeout: 15000, windowsHide: true, windowsVerbatimArguments: true });
      assert.equal(result.status, 0, result.stderr || name);
      const called = JSON.parse(fs.readFileSync(log, 'utf8'));
      assert.equal(called.cwd.toLowerCase(), path.join(root, 'app').toLowerCase(), name); assert.deepEqual(called.args, expected[i], name);
      if (i === 0) assert.equal(called.openBrowser, '1');
    }
  } finally {
    for (const name of ['command.json', 'probe.cjs', 'node.cmd', 'npm.cmd']) { const target = path.join(temp, name); if (fs.existsSync(target)) fs.unlinkSync(target); }
    fs.rmdirSync(temp);
  }
});
