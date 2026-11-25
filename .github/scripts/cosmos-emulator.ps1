# HAR-113 — the Azure Cosmos DB emulator as ci.yml's api-cosmos-emulator job and
# test-repeat.yml's repeat-emulator job use it: the Windows-native emulator that
# ships on the windows-2025 runner image. One script so both jobs start,
# measure and diagnose it the same way.
#
# Why Windows: the classic Linux emulator image (2.14.28 in HAR-113) dies with a
# native fault in its SQLPAL HTTP/socket layer ("Last Chance", Reason
# 0x00000006, stack through Http.sys and AfdWsk.sys) within minutes of the
# tier's load: exit 1, OOMKilled=false, 1.2 GB of 15.6 GB used. Partition count
# does not change it. The Windows build runs the same engine on the real
# Windows network stack. See docs/development/ci-cd.md (Cosmos emulator tier).
#
#   cosmos-emulator.ps1 start <cert-file>
#       Checks the installed emulator is the pinned version, starts it with the
#       partition count below, waits (bounded, 300 s) until it reports Running
#       and its gateway answers, writes the certificate the gateway presents to
#       <cert-file> (PEM) and reports the start-up time with the partition
#       count, as a notice and in the job summary. If, and only if, the start
#       hits the SetCertificateAcl fault (below), it stops the emulator and
#       starts it once more, with its own 300 s bound, and says so in a notice.
#
#   cosmos-emulator.ps1 sample <file>
#       Every 10 s until killed, appends one timestamped line: the emulator's
#       processes (count, working set, CPU seconds) and the host's free memory.
#       A record, never a gate.
#
#   cosmos-emulator.ps1 diagnose <dir>
#       For a failed step: the emulator's status, its processes, the error
#       events Windows logged in the last hour (a crash lands there) and the
#       emulator's own log files, into <dir>. Never fails the job itself.
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('start', 'sample', 'diagnose')][string]$Command,
  [Parameter(Mandatory = $true, Position = 1)][string]$Path
)
$ErrorActionPreference = 'Stop'

# The runner image pins the emulator; fail loudly if an image update moves it
# to a build nobody has re-verified this tier on. GitHub rolls a new runner
# image out over days, so while it does both builds are live: win25-vs2026
# 20261116.315.1 ships 2.14.28.0 and 20261123.321.1 ships 2.14.29.0 (HAR-185).
# 2.14.28.0 has passed test-repeat's repeat-emulator job in full: 50 runs in a
# row and 8 concurrent copies (HAR-113, HAR-185). 2.14.29.0 has passed the
# 8-copy pass and api-cosmos-emulator; its 50-run serial pass is outstanding
# (HAR-186). HAR-186 runs it and drops 2.14.28.0 once no runner reports it.
$PinnedVersions = @('2.14.28.0', '2.14.29.0')
# One partition per Terraform container the tier creates (7, in one shared
# database) plus headroom. Each container gets one partition, as a container in
# the deployed 400 RU/s shared database has one physical partition.
$PartitionCount = 10
$DefaultPartitionCount = 1

$InstallDir = Join-Path $env:ProgramFiles 'Azure Cosmos DB Emulator'
$DataPath = Join-Path $env:LOCALAPPDATA 'CosmosDBEmulator'
$ProcessPattern = '^(Microsoft\.Azure\.Cosmos|CosmosDB\.|Microsoft\.Azure\.Documents)'

function Write-Summary([string]$line) {
  if ($env:GITHUB_STEP_SUMMARY) { Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $line }
}

# HAR-190 — the one start-up fault this script restarts the emulator for. On
# 2.14.29.0 an emulator service's StartupEntryPoint (the gateway's, in job
# 139411256607) can die about a minute into the start with an unhandled
# CryptographicException in AclCertificateUtil.SetCertificateAcl. The emulator
# starts its services together, and the StartupEntryPoint of each of its
# gateway, controller and background-task services opens the private key of
# the emulator's own CosmosEmulatorSecrets certificate (a CNG key) to add its
# service group to the key file's ACL. It opens the key before taking the
# cross-process mutex the emulator uses for that ACL change, so the services'
# opens and ACL writes on the one key file overlap. When .NET Framework's GetRSAPrivateKey cannot
# acquire the CNG key, for whatever reason, it falls back to the legacy CSP
# path (RSACryptoServiceProvider), which cannot open a CNG key and throws; the
# CNG error itself is lost. Windows logs .NET Runtime event 1026 with the
# stack, then Application Error 1000. Service Fabric relaunches the service
# minutes later, too late for the 300 s bound. All of this happens inside the
# emulator's own processes, on a key it owns, after Start-CosmosDbEmulator
# returns, so nothing can be prepared from outside: a clean stop and one more
# start is the remedy.
function Test-SetCertificateAclFault([string]$Message) {
  # Every marker of this fault in the .NET Runtime 1026 event's text, and only
  # this fault: a different crash, or a different exception, does not match.
  return ($Message -match 'Microsoft\.Azure\.Cosmos\.StartupEntryPoint\.exe') -and
    ($Message -match 'System\.Security\.Cryptography\.CryptographicException') -and
    ($Message -match 'AclCertificateUtil\.SetCertificateAcl')
}

function Find-SetCertificateAclFault([datetime]$Since) {
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = '.NET Runtime'; Id = 1026; StartTime = $Since } -ErrorAction SilentlyContinue |
    Where-Object { Test-SetCertificateAclFault $_.Message } |
    Select-Object -First 1
}

function Write-CertSnapshot([string]$Label) {
  # HAR-190 experiment: the certificates the emulator's ACL code enumerates,
  # and whether their private keys open from this (admin) process.
  Write-Host "----- LocalMachine\My certificates ($Label) -----"
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'LocalMachine')
  $store.Open('ReadOnly')
  try {
    foreach ($c in $store.Certificates) {
      $key = 'no private key'
      if ($c.HasPrivateKey) {
        try {
          $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c)
          if ($rsa -is [System.Security.Cryptography.RSACng]) { $key = "RSACng $($rsa.Key.Provider.Provider) $($rsa.Key.UniqueName)" }
          elseif ($rsa) { $key = "RSA $($rsa.GetType().Name) $($rsa.CspKeyContainerInfo.ProviderName) $($rsa.CspKeyContainerInfo.UniqueKeyContainerName)" }
          else {
            $ec = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($c)
            $key = if ($ec -is [System.Security.Cryptography.ECDsaCng]) { "ECDsaCng $($ec.Key.Provider.Provider) $($ec.Key.UniqueName)" } else { "other: $($ec.GetType().Name)" }
          }
        } catch { $key = "KEY OPEN FAILED: $($_.Exception.GetType().Name): $($_.Exception.Message)" }
      }
      Write-Host ("{0} | {1} | friendly={2} | notBefore={3:o} | {4}" -f $c.Thumbprint, $c.Subject, $c.FriendlyName, $c.NotBefore, $key)
    }
  } finally { $store.Close() }
}

function Write-StartEvents([datetime]$Since) {
  Write-Host "----- .NET Runtime 1026 / Application Error 1000 since $($Since.ToString('HH:mm:ss')) -----"
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1026, 1000; StartTime = $Since } -ErrorAction SilentlyContinue |
    Sort-Object TimeCreated |
    ForEach-Object {
      $frames = ($_.Message -split "`n" | Where-Object { $_ -match 'SetupCommand\.|ServiceSetupHelper\.|Exception Info|Faulting application path' } | ForEach-Object { $_.Trim() }) -join ' <- '
      Write-Host ("{0:HH:mm:ss} {1} {2} +{3}s {4}" -f $_.TimeCreated, $_.ProviderName, $_.Id, [int]($_.TimeCreated - $Since).TotalSeconds, $frames)
    }
  Write-Host '----- emulator processes -----'
  Get-Process | Where-Object { $_.ProcessName -match $ProcessPattern -or $_.ProcessName -match 'StartupEntryPoint|Fabric' } |
    ForEach-Object { Write-Host ("{0} pid={1} started +{2}s" -f $_.ProcessName, $_.Id, [int]($_.StartTime - $Since).TotalSeconds) }
}

function Start-Emulator {
  # One start, bounded at 300 s. Returns the PEM once the emulator is Running
  # and its gateway completes a TLS handshake. HAR-190 experiment: records the
  # first SetCertificateAcl fault seen, but keeps waiting.
  $since = Get-Date
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  Start-CosmosDbEmulator -NoUI -NoTelemetry -NoWait `
    -PartitionCount $PartitionCount -DefaultPartitionCount $DefaultPartitionCount
  $faultAt = $null
  $result = @{ Pem = $null; Fault = $null; Seconds = 0 }
  while ($clock.Elapsed.TotalSeconds -lt 300) {
    if ((Get-CosmosDbEmulatorStatus) -eq 'Running') {
      try {
        $result.Pem = Get-GatewayCertificatePem
        break
      } catch {
        # Running but the gateway is not accepting TLS yet.
      }
    }
    if (-not $faultAt -and (Find-SetCertificateAclFault $since)) {
      $faultAt = [int]$clock.Elapsed.TotalSeconds
      Write-Host "HAR-190 experiment: SetCertificateAcl fault seen at ${faultAt}s; still waiting."
    }
    Start-Sleep -Seconds 2
  }
  $result.Seconds = [int]$clock.Elapsed.TotalSeconds
  Write-StartEvents $since
  return $result
}

function Get-GatewayCertificatePem {
  # The certificate the gateway actually presents: what Node has to trust.
  $tcp = [System.Net.Sockets.TcpClient]::new('localhost', 8081)
  try {
    $ssl = [System.Net.Security.SslStream]::new($tcp.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient('localhost')
    $raw = $ssl.RemoteCertificate.GetRawCertData()
    $b64 = [Convert]::ToBase64String($raw, [Base64FormattingOptions]::InsertLineBreaks)
    return "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----`n"
  } finally {
    $tcp.Dispose()
  }
}

switch ($Command) {
  'start' {
    $exe = Get-Item (Join-Path $InstallDir 'Microsoft.Azure.Cosmos.Emulator.exe')
    $version = $exe.VersionInfo.FileVersion
    Write-Host "Runner image: $env:ImageOS $env:ImageVersion; Cosmos emulator: $version"
    if ($version -notin $PinnedVersions) {
      throw "Expected Cosmos emulator $($PinnedVersions -join ' or '), found $version (runner image changed)."
    }
    Import-Module (Join-Path $InstallDir 'PSModules\Microsoft.Azure.CosmosDB.Emulator')
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    Write-CertSnapshot 'before start'
    $attempt = Start-Emulator
    Write-CertSnapshot 'after start'
    $restarted = ''
    if (-not $attempt.Pem) {
      Write-Host "::error::Cosmos emulator not ready within 300s (status: $(Get-CosmosDbEmulatorStatus))"
      exit 1
    }
    [System.IO.File]::WriteAllText($Path, $attempt.Pem)
    $seconds = [int]$clock.Elapsed.TotalSeconds
    $line = "Cosmos emulator $version started in ${seconds}s (PartitionCount=$PartitionCount, DefaultPartitionCount=$DefaultPartitionCount$restarted)"
    Write-Host "::notice title=Cosmos emulator start-up::$line"
    Write-Summary $line
  }

  'sample' {
    New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
    while ($true) {
      $procs = @(Get-Process | Where-Object { $_.ProcessName -match $ProcessPattern })
      $ws = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum
      $cpu = ($procs | Measure-Object -Property CPU -Sum).Sum
      $free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB
      $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      Add-Content -Path $Path -Value ("{0} procs={1} ws={2:N0}MB cpu={3:N0}s host_free={4:N0}MB" -f `
          $stamp, $procs.Count, ($ws / 1MB), $cpu, ($free / 1MB))
      Start-Sleep -Seconds 10
    }
  }

  'diagnose' {
    $ErrorActionPreference = 'Continue'
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    try {
      Import-Module (Join-Path $InstallDir 'PSModules\Microsoft.Azure.CosmosDB.Emulator')
      $status = Get-CosmosDbEmulatorStatus
    } catch {
      $status = "unknown: $_"
    }
    "status: $status" | Set-Content (Join-Path $Path 'status.txt')
    Get-Process | Where-Object { $_.ProcessName -match $ProcessPattern } |
      Format-Table Id, ProcessName, StartTime, CPU, WorkingSet64 -AutoSize | Out-String -Width 200 |
      Set-Content (Join-Path $Path 'processes.txt')
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 1, 2; StartTime = (Get-Date).AddHours(-1) } -ErrorAction SilentlyContinue |
      Format-List TimeCreated, ProviderName, Id, Message | Out-String -Width 300 |
      Set-Content (Join-Path $Path 'application-errors.txt')
    if (Test-Path $DataPath) {
      $logs = Join-Path $Path 'emulator-logs'
      Get-ChildItem $DataPath -Recurse -File -Include *.log, *.txt, *.trace, *.json -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -lt 50MB } |
        ForEach-Object {
          $dest = Join-Path $logs ($_.FullName.Substring($DataPath.Length).TrimStart('\'))
          New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
          Copy-Item $_.FullName $dest
        }
    }
    Write-Host "----- Cosmos emulator status: $status -----"
    Get-Content (Join-Path $Path 'processes.txt')
    Write-Host '----- Windows Application errors, last hour (full list in the artifact) -----'
    Get-Content (Join-Path $Path 'application-errors.txt') -TotalCount 120
    Write-Host '----- end of Cosmos emulator diagnostics -----'
    exit 0
  }
}
