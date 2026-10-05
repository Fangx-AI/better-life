import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash, createCipheriv } from 'node:crypto';

const path = fileURLToPath(new URL('../scripts/offsite-backup-pull.ps1', import.meta.url));
const source = readFileSync(path, 'utf8');
const filename = 'better-life-2026-10-05T01-00-00-000Z-abcdef12.blbk';
const failure = 'Better Life 离机备份拉取失败；未覆盖旧文件。';
const pwshCandidates = [join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'), 'C:/Program Files/PowerShell/7/pwsh.exe'];
const pwsh = process.platform === 'win32' ? pwshCandidates.find(value => existsSync(value)) : undefined;
const skip = !pwsh ? '需要 Windows PowerShell 7；静态测试不代替实际 DPAPI/ACL。' : false;
const quote = value => `'${value.replaceAll("'", "''")}'`;
function wire({ header = {}, keys, magic = 'BLBK1', corruptHash = false, trailing = false } = {}) {
  const encryptionKey = randomBytes(32), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from('BLBK1'));
  const encrypted = Buffer.concat([cipher.update('synthetic-not-a-user-database'), cipher.final()]);
  const bytes = Buffer.concat([Buffer.from(magic), nonce, cipher.getAuthTag(), encrypted]);
  const keyObject = keys || { MEMBERSHIP_AUTH_SECRET: randomBytes(48).toString('base64url'), MEMBERSHIP_BACKUP_ENCRYPTION_KEY: encryptionKey.toString('base64url') };
  const keyBytes = Buffer.from(JSON.stringify(keyObject));
  const metadata = { application: 'better-life', version: 1, filename, bytes: bytes.length, sha256: corruptHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), keyBytes: keyBytes.length, ...header };
  return { bytes: Buffer.concat([Buffer.from(JSON.stringify(metadata) + '\n'), keyBytes, bytes, ...(trailing ? [Buffer.from('unexpected')] : [])]), ciphertext: bytes, keyBytes, keyObject };
}
function runPowerShell(t, body) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-offsite-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, 'synthetic-test.ps1');
  writeFileSync(script, `$ErrorActionPreference='Stop'\n. ${quote(path)}\n$fixtureRoot=${quote(directory)}\n$sshKey=Join-Path $fixtureRoot 'synthetic-ssh-key'\n[System.IO.File]::WriteAllText($sshKey,'synthetic-not-an-SSH-private-key')\n${body}`, 'utf8');
  // Minimal synthetic process environment; never inherit production secrets.
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { SystemRoot: 'C:\\Windows', TEMP: directory, TMP: directory } });
  assert.equal(result.status, 0, result.stderr || '合成 PowerShell 子进程失败');
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout.trim());
}
function transport(bytes, completion = '') {
  return `$wire=[Convert]::FromBase64String(${quote(bytes.toString('base64'))})\n$factory={param($hostName,$keyPath) @{Stream=[System.IO.MemoryStream]::new($wire,$false);Complete={param($token) ${completion}};Dispose={}}}.GetNewClosure()`;
}

test('offsite: SSH uses typed argument list, host-key pin policy and a read-only fixed remote program', () => {
  assert.match(source, /#Requires -Version 7\.0/); assert.match(source, /ProcessStartInfo/); assert.match(source, /ArgumentList\.Add/); assert.match(source, /UseShellExecute = \$false/); assert.match(source, /CreateNoWindow = \$true/);
  for (const option of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'IdentitiesOnly=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes']) assert.ok(source.includes(option));
  assert.ok(source.includes("'-F', 'NUL'")); assert.ok(source.includes("'/usr/bin/python3', '-'"));
  const remote = source.match(/\$script:OffsiteRemoteProgram = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  assert.ok(remote.includes("BACKUP_DIRECTORY = '/var/backups/better-life'")); assert.ok(remote.includes("KEY_FILE = '/etc/better-life/backup.env'"));
  assert.match(remote, /os\.O_RDONLY \| os\.O_NOFOLLOW/); assert.match(remote, /st_nlink != 1/); assert.match(remote, /st_mode & 0o077/); assert.match(remote, /st_mode & 0o022/);
  assert.ok(remote.includes('shlex.split')); assert.ok(remote.includes('hashlib.sha256')); assert.ok(remote.includes("backup.read(5) != b'BLBK1'"));
  assert.equal(/\b(?:subprocess|system\(|unlink\(|remove\(|chmod\(|chown\(|rename\(|exec\(|eval\(|source\s+(?:\/|\$))/.test(remote), false);
  assert.equal(/DEEPSEEK|PHONE_DELIVERY|PAYMENT_GATEWAY/.test(remote), false); assert.equal(/sys\.argv|os\.environ/.test(remote), false);
});

test('offsite: bounded protocol, CurrentUser DPAPI, atomic exclusive files and no task/remote deletion', () => {
  assert.ok(source.includes('268435456')); assert.ok(source.includes('8192')); assert.ok(source.includes('4096')); assert.ok(source.includes('CancelAfter(180000)'));
  assert.match(source, /DataProtectionScope\]::CurrentUser/); assert.equal(source.includes('DataProtectionScope]::LocalMachine'), false);
  assert.match(source, /FileMode\]::CreateNew/); assert.match(source, /FileShare\]::None/); assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/); assert.ok(source.includes("'S-1-5-18'"));
  assert.ok(source.includes('ReparsePoint')); assert.ok(source.includes('GetFileInformationByHandle')); assert.ok(source.includes('info.Links != 1')); assert.ok(source.includes('0x00200000'));
  assert.ok(source.includes("'ciphertext'")); assert.ok(source.includes("'key-escrow'")); assert.ok(source.includes('FixedTimeEquals')); assert.ok(source.includes('cipherSha256Matched = $true')); assert.ok(source.includes('restorationVerified = $false'));
  assert.equal(/Register-ScheduledTask|schtasks|Start-Process|cmd(?:\.exe)?\s|Invoke-Expression|\.Arguments\s*=/.test(source), false);
  assert.match(source, /FileSystemAclExtensions\]::Create\(\[System\.IO\.DirectoryInfo\][^\n]+\| Out-Null/);
  assert.ok(source.includes('Remove-Item -LiteralPath $safe -Force')); assert.equal(/Remove-Item[^\n]*-Recurse/.test(source), false);
  assert.ok(source.includes('[Console]::Error.WriteLine($script:OffsiteFailure)')); assert.equal(/Write-(?:Host|Output|Error|Verbose|Debug).*keyBytes|WriteAll(?:Text|Bytes).*keyBytes/.test(source), false);
});

test('offsite: PowerShell parses and a synthetic transfer performs real DPAPI/ACL without network or plaintext disk', { skip }, t => {
  const data = wire();
  const result = runPowerShell(t, `${transport(data.bytes)}
$destination=Join-Path $fixtureRoot 'private-destination'
$result=Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination $destination -TransportFactory $factory
$cipher=Join-Path $destination 'ciphertext/${filename}'
$escrow=Join-Path $destination 'key-escrow/${filename}.keys.dpapi'
$protected=[System.IO.File]::ReadAllBytes($escrow)
$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$expected=[Convert]::FromBase64String(${quote(data.keyBytes.toString('base64'))})
if(-not [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($expected,$plain)){throw 'synthetic escrow mismatch'}
Assert-OffsiteAcl $destination; Assert-OffsiteAcl $cipher; Assert-OffsiteAcl $escrow
if([System.Text.Encoding]::UTF8.GetString($protected).Contains('MEMBERSHIP_AUTH_SECRET')){throw 'synthetic plaintext leak'}
$plainObject=[System.Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json -AsHashtable
if(($plainObject.Keys | Sort-Object) -join ',' -ne 'MEMBERSHIP_AUTH_SECRET,MEMBERSHIP_BACKUP_ENCRYPTION_KEY'){throw 'synthetic wrong key fields'}
[Array]::Clear($plain,0,$plain.Length)
@{result=$result; fileCount=@(Get-ChildItem -LiteralPath $destination -Recurse -File).Count; dpapiVerified=$true; aclVerified=$true} | ConvertTo-Json -Depth 5 -Compress`);
  assert.equal(result.result.status, 'stored'); assert.equal(result.result.cipherSha256Matched, true); assert.equal(result.result.restorationVerified, false); assert.equal(result.result.keyEscrow, 'DPAPI-CurrentUser'); assert.equal(result.fileCount, 2); assert.equal(result.dpapiVerified, true); assert.equal(result.aclVerified, true);
});

test('offsite: identical latest backup is idempotently verified without overwriting old ciphertext or escrow', { skip }, t => {
  const data = wire();
  const result = runPowerShell(t, `${transport(data.bytes)}
$destination=Join-Path $fixtureRoot 'private-destination'
$first=Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination $destination -TransportFactory $factory
$escrow=Join-Path $destination 'key-escrow/${filename}.keys.dpapi'
$before=[System.IO.File]::ReadAllBytes($escrow)
$second=Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination $destination -TransportFactory $factory
$after=[System.IO.File]::ReadAllBytes($escrow)
if(-not [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($before,$after)){throw 'synthetic overwrite'}
@{first=$first.alreadyPresent; second=$second.alreadyPresent; files=@(Get-ChildItem -LiteralPath $destination -Recurse -File).Count} | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { first: false, second: true, files: 2 });
});

test('offsite: transport completion runtime objects never contaminate the public result', { skip }, t => {
  const data = wire();
  const result = runPowerShell(t, `${transport(data.bytes, '[pscustomobject]@{}; [pscustomobject]@{}')}
$destination=Join-Path $fixtureRoot 'private-destination'
$result=@(Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination $destination -TransportFactory $factory)
@{count=$result.Count; status=$result[0].status} | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { count: 1, status: 'stored' });
});

test('offsite: corrupt hash, unsafe filename, foreign app, oversized protocol, extra secrets, bad magic/trailing data and process failure are constant errors', { skip }, t => {
  const extraKeys = { ...wire().keyObject, DEEPSEEK_API_KEY: 'synthetic-not-a-real-key' };
  const cases = [wire({ corruptHash: true }), wire({ header: { filename: '../other-project.blbk' } }), wire({ header: { application: 'other-project' } }), wire({ header: { bytes: 268435457 } }), wire({ header: { keyBytes: 8193 } }), wire({ keys: extraKeys }), wire({ magic: 'WRONG' }), wire({ trailing: true }), wire()];
  let body = '$passed=0\n';
  cases.forEach((data, index) => {
    body += `${transport(data.bytes, index === cases.length - 1 ? "throw 'synthetic-remote-error-never-disclose'" : '')}
$destination=Join-Path $fixtureRoot 'failure-${index}'
try{Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination $destination -TransportFactory $factory | Out-Null; throw 'unexpected synthetic success'}catch{if($_.Exception.Message -ne ${quote(failure)}){throw 'nonconstant synthetic error'}}
if(@(Get-ChildItem -LiteralPath $destination -Recurse -File).Count -ne 0){throw 'synthetic partial file leaked'}
$passed++\n`;
  });
  const result = runPowerShell(t, body + '@{passed=$passed} | ConvertTo-Json -Compress'); assert.equal(result.passed, cases.length);
});

test('offsite: changed escrow keys and unsafe public directory cannot overwrite or disclose', { skip }, t => {
  const first = wire(), secondKeys = wire().keyObject;
  const originalHeader = JSON.parse(first.bytes.subarray(0, first.bytes.indexOf(10)).toString());
  const changedKeyBytes = Buffer.from(JSON.stringify(secondKeys));
  const changed = Buffer.concat([Buffer.from(JSON.stringify({ ...originalHeader, keyBytes: changedKeyBytes.length }) + '\n'), changedKeyBytes, first.ciphertext]);
  const result = runPowerShell(t, `${transport(first.bytes)}
$destination=Join-Path $fixtureRoot 'private-destination'
Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination $destination -TransportFactory $factory | Out-Null
$escrow=Join-Path $destination 'key-escrow/${filename}.keys.dpapi'; $before=[System.IO.File]::ReadAllBytes($escrow)
${transport(changed)}
try{Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination $destination -TransportFactory $factory | Out-Null; throw 'unexpected success'}catch{if($_.Exception.Message -ne ${quote(failure)}){throw 'nonconstant error'}}
if(-not [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($before,[System.IO.File]::ReadAllBytes($escrow))){throw 'old escrow changed'}
$badDestination=Join-Path $fixtureRoot 'public/offsite'
try{Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination $badDestination -TransportFactory $factory | Out-Null; throw 'unexpected success'}catch{if($_.Exception.Message -ne ${quote(failure)}){throw 'nonconstant error'}}
@{unchanged=$true; files=@(Get-ChildItem -LiteralPath $destination -Recurse -File).Count; noPublicDirectory=(-not (Test-Path -LiteralPath $badDestination))} | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { unchanged: true, files: 2, noPublicDirectory: true });
});

test('offsite: injected hostname, broad existing ACL and directory junction fail before transport; old files remain', { skip }, t => {
  const result = runPowerShell(t, `
$factory={param($hostName,$keyPath) throw 'transport-must-not-run'}
$destination=Join-Path $fixtureRoot 'broad-destination'; [System.IO.Directory]::CreateDirectory($destination) | Out-Null
[System.IO.File]::WriteAllText((Join-Path $destination 'old.txt'),'synthetic-old-file')
foreach($hostName in @('-oProxyCommand=bad','fixture@example.com;bad','fixture@example.com /tmp','https://example.com')){
try{Invoke-OffsiteBackupPull -HostName $hostName -SshKeyPath $sshKey -Destination $destination -TransportFactory $factory | Out-Null; throw 'unexpected success'}catch{if($_.Exception.Message -ne ${quote(failure)}){throw 'nonconstant error'}}}
try{Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination $destination -TransportFactory $factory | Out-Null; throw 'unexpected success'}catch{if($_.Exception.Message -ne ${quote(failure)}){throw 'nonconstant error'}}
$link=Join-Path $fixtureRoot 'redirected'; New-Item -ItemType Junction -Path $link -Target $destination | Out-Null
try{Invoke-OffsiteBackupPull -HostName 'fixture@example.com' -SshKeyPath $sshKey -Destination (Join-Path $link 'child') -TransportFactory $factory | Out-Null; throw 'unexpected success'}catch{if($_.Exception.Message -ne ${quote(failure)}){throw 'nonconstant error'}}
@{oldUnchanged=([System.IO.File]::ReadAllText((Join-Path $destination 'old.txt')) -eq 'synthetic-old-file'); noChild=(-not (Test-Path -LiteralPath (Join-Path $destination 'child')))} | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { oldUnchanged: true, noChild: true });
});
