#Requires -Version 7.0
[CmdletBinding()]
param([string]$HostName, [string]$SshKeyPath, [string]$Destination)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:OffsiteFailure = 'Better Life 离机备份拉取失败；未覆盖旧文件。'
$script:MaximumBackupBytes = 268435456
$script:MaximumKeyBytes = 8192
$script:OffsiteProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

# Fixed read-only remote program; no source, shell expansion, database access,
# deletion, free-text remote paths, model/SMS/payment keys or remote writes.
$script:OffsiteRemoteProgram = @'
import os, sys, stat, json, re, hashlib, shlex, base64
BACKUP_DIRECTORY = '/var/backups/better-life'
KEY_FILE = '/etc/better-life/backup.env'
MAXIMUM_BACKUP_BYTES = 268435456
MAXIMUM_KEY_BYTES = 8192
NAME = re.compile(r'better-life-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.blbk\Z')
def ancestors(path):
    parent = os.path.dirname(path)
    while True:
        info = os.lstat(parent)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022: raise ValueError()
        next_parent = os.path.dirname(parent)
        if next_parent == parent: break
        parent = next_parent
def open_private(path, maximum):
    ancestors(path)
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > maximum: raise ValueError()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    actual = os.fstat(fd)
    if actual.st_ino != info.st_ino or actual.st_dev != info.st_dev or actual.st_nlink != 1: os.close(fd); raise ValueError()
    return os.fdopen(fd, 'rb'), actual
try:
    info = os.lstat(BACKUP_DIRECTORY)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o077: raise ValueError()
    candidates = []
    for name in os.listdir(BACKUP_DIRECTORY):
        if NAME.fullmatch(name):
            path = os.path.join(BACKUP_DIRECTORY, name)
            item = os.lstat(path)
            if not stat.S_ISREG(item.st_mode) or stat.S_ISLNK(item.st_mode) or item.st_nlink != 1: raise ValueError()
            candidates.append((item.st_mtime_ns, name))
    if not candidates: raise ValueError()
    filename = max(candidates)[1]
    with open_private(KEY_FILE, 65536)[0] as key_file:
        source = key_file.read(65537)
    if len(source) > 65536: raise ValueError()
    allowed = ('MEMBERSHIP_AUTH_SECRET', 'MEMBERSHIP_BACKUP_ENCRYPTION_KEY')
    selected = {}
    for line in source.decode('utf-8').splitlines():
        name, separator, raw = line.partition('=')
        name = name.strip()
        if separator and name in allowed:
            if name in selected: raise ValueError()
            values = shlex.split(raw.strip(), comments=True, posix=True)
            if len(values) != 1: raise ValueError()
            selected[name] = values[0]
    if set(selected) != set(allowed): raise ValueError()
    auth, key = selected[allowed[0]], selected[allowed[1]]
    if not re.fullmatch(r'[A-Za-z0-9_+/=-]{48,4096}', auth) or len(set(auth)) < 16: raise ValueError()
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', key) or len(set(key)) < 16 or key == auth: raise ValueError()
    decoded = base64.urlsafe_b64decode(key + '=')
    if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode().rstrip('=') != key: raise ValueError()
    key_bytes = json.dumps(selected, separators=(',', ':'), sort_keys=True).encode('utf-8')
    if len(key_bytes) > MAXIMUM_KEY_BYTES: raise ValueError()
    backup, original = open_private(os.path.join(BACKUP_DIRECTORY, filename), MAXIMUM_BACKUP_BYTES)
    with backup:
        if original.st_size <= 33 or backup.read(5) != b'BLBK1': raise ValueError()
        backup.seek(0)
        digest = hashlib.sha256()
        while True:
            chunk = backup.read(65536)
            if not chunk: break
            digest.update(chunk)
        backup.seek(0)
        header = {'application':'better-life','version':1,'filename':filename,'bytes':original.st_size,'sha256':digest.hexdigest(),'keyBytes':len(key_bytes)}
        output = sys.stdout.buffer
        output.write(json.dumps(header, separators=(',', ':')).encode('ascii') + b'\n')
        output.write(key_bytes)
        while True:
            chunk = backup.read(65536)
            if not chunk: break
            output.write(chunk)
        after = os.fstat(backup.fileno())
        if (original.st_size, original.st_mtime_ns, original.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino): raise ValueError()
        output.flush()
except Exception:
    sys.exit(1)
'@

function Initialize-OffsiteWindowsTypes {
    if (-not $IsWindows) { throw $script:OffsiteFailure }
    if (-not ('BetterLifeOffsiteFiles' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BetterLifeOffsiteFiles {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint sharing, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    public static FileStream OpenRead(string path) {
        var handle = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        Info info;
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x410) != 0 || info.Links != 1) {
            handle.Dispose(); throw new IOException("Better Life private file rejected.");
        }
        return new FileStream(handle, FileAccess.Read);
    }
}
'@ -ErrorAction Stop
    }
}
function Assert-OffsitePath([string]$Path) {
    if (-not $Path -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[\x00-\x1f]' -or $Path.Substring(2).Contains(':')) { throw $script:OffsiteFailure }
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full -match '(?i)[\\/](?:public|dist|image[_-]?2(?:[-_.][^\\/]*)?)(?:[\\/]|$)') { throw $script:OffsiteFailure }
    $part = $full
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw $script:OffsiteFailure }
        }
        $parent = [System.IO.Path]::GetDirectoryName($part)
        if ($parent -eq $part) { break }; $part = $parent
    }
    return $full
}
function New-OffsiteAcl([bool]$Directory) {
    $acl = if ($Directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $acl.SetOwner($user); $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($user, $system)) {
        $inheritance = if ($Directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    return $acl
}
function Assert-OffsiteAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user) { throw $script:OffsiteFailure }
    $seen = @{}
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -notin @($user, 'S-1-5-18')) { throw $script:OffsiteFailure }
        $seen[$rule.IdentityReference.Value] = $true
    }
    if (-not $seen.ContainsKey($user) -or -not $seen.ContainsKey('S-1-5-18')) { throw $script:OffsiteFailure }
}
function Get-OffsitePrivateDirectory([string]$Path) {
    $full = Assert-OffsitePath $Path
    if (-not (Test-Path -LiteralPath $full)) {
        $parent = [System.IO.Path]::GetDirectoryName($full)
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw $script:OffsiteFailure }
        [System.IO.FileSystemAclExtensions]::Create([System.IO.DirectoryInfo]::new($full), (New-OffsiteAcl $true)) | Out-Null
    }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw $script:OffsiteFailure }
    Assert-OffsiteAcl $full
    return $full
}
function New-OffsitePrivateFile([string]$Path) {
    $full = Assert-OffsitePath $Path
    return [System.IO.FileSystemAclExtensions]::Create([System.IO.FileInfo]::new($full), [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None, 65536, [System.IO.FileOptions]::WriteThrough, (New-OffsiteAcl $false))
}
function Read-OffsiteExactly([System.IO.Stream]$Stream, [byte[]]$Bytes, [int]$Count, [System.Threading.CancellationToken]$Token) {
    $position = 0
    while ($position -lt $Count) {
        $read = $Stream.ReadAsync($Bytes, $position, $Count - $position, $Token).GetAwaiter().GetResult()
        if ($read -le 0) { throw $script:OffsiteFailure }; $position += $read
    }
}
function New-OffsiteSshTransport([string]$HostName, [string]$SshKeyPath) {
    $ssh = Get-Command ssh.exe -CommandType Application -ErrorAction Stop
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $ssh.Source; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($argument in @('-T', '-F', 'NUL', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'LogLevel=ERROR', '-i', $SshKeyPath, '--', $HostName, '/usr/bin/python3', '-')) { $info.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::new(); $process.StartInfo = $info
    if (-not $process.Start()) { throw $script:OffsiteFailure }
    try {
        $drain = $process.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
        $program = [System.Text.UTF8Encoding]::new($false).GetBytes($script:OffsiteRemoteProgram + "`n")
        $process.StandardInput.BaseStream.Write($program, 0, $program.Length); $process.StandardInput.Close()
        $complete = { param($token) $process.WaitForExitAsync($token).GetAwaiter().GetResult(); $drain.GetAwaiter().GetResult(); if ($process.ExitCode -ne 0) { throw $script:OffsiteFailure } }.GetNewClosure()
        $dispose = { if (-not $process.HasExited) { $process.Kill($true) }; $process.Dispose() }.GetNewClosure()
        return @{ Stream = $process.StandardOutput.BaseStream; Complete = $complete; Dispose = $dispose }
    } catch { if (-not $process.HasExited) { $process.Kill($true) }; $process.Dispose(); throw $script:OffsiteFailure }
}

function Invoke-OffsiteBackupPull {
    [CmdletBinding()]
    param([string]$HostName, [string]$SshKeyPath, [string]$Destination, [scriptblock]$TransportFactory)
    $transport = $null; $target = $null; $keyBytes = $null; $protected = $null; $unprotected = $null; $cancel = $null
    $created = [System.Collections.Generic.List[string]]::new()
    try {
        Initialize-OffsiteWindowsTypes
        # Public parameters are data, never a shell command, remote path or URL.
        if ($HostName -cnotmatch '^(?:[a-z_][a-z0-9_-]{0,31}@)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{1,63}$' -or $HostName.Length -gt 286) { throw $script:OffsiteFailure }
        $keyPath = Assert-OffsitePath $SshKeyPath
        $keyCheck = [BetterLifeOffsiteFiles]::OpenRead($keyPath); $keyCheck.Dispose() # No SSH key bytes read.
        $root = Assert-OffsitePath $Destination
        if ($root.Equals($script:OffsiteProjectRoot, [StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($script:OffsiteProjectRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw $script:OffsiteFailure }
        $root = Get-OffsitePrivateDirectory $root
        $cipherDirectory = Get-OffsitePrivateDirectory (Join-Path $root 'ciphertext')
        $escrowDirectory = Get-OffsitePrivateDirectory (Join-Path $root 'key-escrow')
        $cancel = [System.Threading.CancellationTokenSource]::new(); $cancel.CancelAfter(180000)
        $transport = if ($TransportFactory) { & $TransportFactory $HostName $keyPath } else { New-OffsiteSshTransport $HostName $keyPath }
        if (-not $transport -or $transport.Stream -isnot [System.IO.Stream]) { throw $script:OffsiteFailure }
        $stream = $transport.Stream; $line = [System.Collections.Generic.List[byte]]::new(); $single = [byte[]]::new(1)
        while ($true) { Read-OffsiteExactly $stream $single 1 $cancel.Token; if ($single[0] -eq 10) { break }; if ($line.Count -ge 4096) { throw $script:OffsiteFailure }; $line.Add($single[0]) }
        $encoding = [System.Text.UTF8Encoding]::new($false, $true)
        $header = $encoding.GetString($line.ToArray()) | ConvertFrom-Json -AsHashtable
        if ((($header.Keys | Sort-Object) -join ',') -ne 'application,bytes,filename,keyBytes,sha256,version' -or $header.application -ne 'better-life' -or $header.version -ne 1 -or
            $header.filename -cnotmatch '^better-life-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.blbk$' -or
            $header.bytes -isnot [long] -and $header.bytes -isnot [int] -or $header.bytes -le 33 -or $header.bytes -gt $script:MaximumBackupBytes -or
            $header.keyBytes -isnot [long] -and $header.keyBytes -isnot [int] -or $header.keyBytes -le 0 -or $header.keyBytes -gt $script:MaximumKeyBytes -or
            $header.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw $script:OffsiteFailure }
        $keyBytes = [byte[]]::new([int]$header.keyBytes); Read-OffsiteExactly $stream $keyBytes $keyBytes.Length $cancel.Token
        $keyObject = $encoding.GetString($keyBytes) | ConvertFrom-Json -AsHashtable
        if ((($keyObject.Keys | Sort-Object) -join ',') -ne 'MEMBERSHIP_AUTH_SECRET,MEMBERSHIP_BACKUP_ENCRYPTION_KEY' -or
            $keyObject.MEMBERSHIP_AUTH_SECRET -notmatch '^[A-Za-z0-9_+/=-]{48,4096}$' -or $keyObject.MEMBERSHIP_BACKUP_ENCRYPTION_KEY -notmatch '^[A-Za-z0-9_-]{43}$') { throw $script:OffsiteFailure }
        $decodedKey = [Convert]::FromBase64String($keyObject.MEMBERSHIP_BACKUP_ENCRYPTION_KEY.Replace('-', '+').Replace('_', '/') + '=')
        if ($decodedKey.Length -ne 32 -or [Convert]::ToBase64String($decodedKey).TrimEnd('=').Replace('+', '-').Replace('/', '_') -cne $keyObject.MEMBERSHIP_BACKUP_ENCRYPTION_KEY -or
            @($keyObject.MEMBERSHIP_AUTH_SECRET.ToCharArray() | Select-Object -Unique).Count -lt 16 -or @($keyObject.MEMBERSHIP_BACKUP_ENCRYPTION_KEY.ToCharArray() | Select-Object -Unique).Count -lt 16 -or
            $keyObject.MEMBERSHIP_AUTH_SECRET -ceq $keyObject.MEMBERSHIP_BACKUP_ENCRYPTION_KEY) { throw $script:OffsiteFailure }
        [Array]::Clear($decodedKey, 0, $decodedKey.Length); $decodedKey = $null
        $keyObject = $null
        $protected = [System.Security.Cryptography.ProtectedData]::Protect($keyBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $cipherFinal = Join-Path $cipherDirectory $header.filename
        $escrowFinal = Join-Path $escrowDirectory ($header.filename + '.keys.dpapi')
        $alreadyPresent = Test-Path -LiteralPath $cipherFinal
        if ($alreadyPresent -ne (Test-Path -LiteralPath $escrowFinal)) { throw $script:OffsiteFailure }
        if ($alreadyPresent) {
            Assert-OffsitePath $cipherFinal | Out-Null; Assert-OffsiteAcl $cipherFinal
            $existingCipher = [BetterLifeOffsiteFiles]::OpenRead($cipherFinal)
            try { if ($existingCipher.Length -ne $header.bytes -or [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($existingCipher)).ToLowerInvariant() -ne $header.sha256) { throw $script:OffsiteFailure } } finally { $existingCipher.Dispose() }
            Assert-OffsitePath $escrowFinal | Out-Null; Assert-OffsiteAcl $escrowFinal
            $existingEscrow = [BetterLifeOffsiteFiles]::OpenRead($escrowFinal)
            try { if ($existingEscrow.Length -gt 16384 -or $existingEscrow.Length -lt 1) { throw $script:OffsiteFailure }; $existingProtected = [byte[]]::new([int]$existingEscrow.Length); Read-OffsiteExactly $existingEscrow $existingProtected $existingProtected.Length $cancel.Token } finally { $existingEscrow.Dispose() }
            $unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($existingProtected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
            if (-not [System.Security.Cryptography.CryptographicOperations]::FixedTimeEquals($keyBytes, $unprotected)) { throw $script:OffsiteFailure }
        } else {
            $partial = Join-Path $cipherDirectory ('.pull-' + [Guid]::NewGuid().ToString('N') + '.partial')
            $target = New-OffsitePrivateFile $partial; $created.Add($partial)
        }
        $hash = [System.Security.Cryptography.IncrementalHash]::CreateHash([System.Security.Cryptography.HashAlgorithmName]::SHA256)
        try {
            $buffer = [byte[]]::new(65536); [long]$remaining = $header.bytes; $first = $true
            while ($remaining -gt 0) {
                $count = [int][Math]::Min($buffer.Length, $remaining); Read-OffsiteExactly $stream $buffer $count $cancel.Token
                if ($first -and [System.Text.Encoding]::ASCII.GetString($buffer, 0, 5) -ne 'BLBK1') { throw $script:OffsiteFailure }; $first = $false
                $hash.AppendData($buffer, 0, $count); if ($target) { $target.Write($buffer, 0, $count) }; $remaining -= $count
            }
            if ([Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant() -ne $header.sha256) { throw $script:OffsiteFailure }
        } finally { $hash.Dispose() }
        if ($stream.ReadAsync($single, 0, 1, $cancel.Token).GetAwaiter().GetResult() -ne 0) { throw $script:OffsiteFailure }
        & $transport.Complete $cancel.Token | Out-Null
        if (-not $alreadyPresent) {
            $target.Flush($true); $target.Dispose(); $target = $null
            $escrow = New-OffsitePrivateFile $escrowFinal; $created.Add($escrowFinal)
            try { $escrow.Write($protected, 0, $protected.Length); $escrow.Flush($true) } finally { $escrow.Dispose() }
            # File.Move without overwrite retains exclusive publication semantics.
            Assert-OffsitePath $cipherDirectory | Out-Null; Assert-OffsitePath $escrowDirectory | Out-Null
            [System.IO.File]::Move($partial, $cipherFinal); $created.Remove($partial) | Out-Null; $created.Add($cipherFinal)
        }
        return @{ application = 'better-life'; version = 1; status = 'stored'; alreadyPresent = [bool]$alreadyPresent; cipherSha256Matched = $true; keyEscrow = 'DPAPI-CurrentUser'; restorationVerified = $false }
    } catch {
        if ($target) { $target.Dispose(); $target = $null }
        # Only paths exclusively created by this invocation may be removed.
        foreach ($file in $created) {
            try { $safe = Assert-OffsitePath $file; if ($safe.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $safe -PathType Leaf)) { Remove-Item -LiteralPath $safe -Force } } catch { }
        }
        throw $script:OffsiteFailure
    } finally {
        if ($transport) { try { & $transport.Dispose } catch { } }
        if ($cancel) { $cancel.Dispose() }
        foreach ($bytes in @($keyBytes, $protected, $unprotected)) { if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) } }
    }
}

# Dot-source exposes functions for synthetic tests; only direct invocation uses SSH.
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-OffsiteBackupPull -HostName $HostName -SshKeyPath $SshKeyPath -Destination $Destination | ConvertTo-Json -Compress; exit 0 }
    catch { [Console]::Error.WriteLine($script:OffsiteFailure); exit 1 }
}
