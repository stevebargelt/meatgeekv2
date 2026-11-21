# HAR-113 — the Azure Cosmos DB emulator as ci.yml's api-cosmos-emulator job and
# test-repeat.yml's repeat-emulator job use it: the Windows-native emulator that
# ships on the windows-2025 runner image. One script so both jobs start,
# measure and diagnose it the same way.
#
# Why Windows: the classic Linux emulator image (same 2.14.28 build) dies with a
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
#       count, as a notice and in the job summary.
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

# The runner image pins the emulator; fail loudly if an image update moves it.
$PinnedVersion = '2.14.28.0'
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
    if ($version -ne $PinnedVersion) {
      throw "Expected Cosmos emulator $PinnedVersion, found $version (runner image changed)."
    }
    Import-Module (Join-Path $InstallDir 'PSModules\Microsoft.Azure.CosmosDB.Emulator')
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    Start-CosmosDbEmulator -NoUI -NoTelemetry -NoWait `
      -PartitionCount $PartitionCount -DefaultPartitionCount $DefaultPartitionCount
    $pem = $null
    while ($clock.Elapsed.TotalSeconds -lt 300) {
      if ((Get-CosmosDbEmulatorStatus) -eq 'Running') {
        try {
          $pem = Get-GatewayCertificatePem
          break
        } catch {
          # Running but the gateway is not accepting TLS yet.
        }
      }
      Start-Sleep -Seconds 2
    }
    if (-not $pem) {
      Write-Host "::error::Cosmos emulator not ready within 300s (status: $(Get-CosmosDbEmulatorStatus))"
      exit 1
    }
    [System.IO.File]::WriteAllText($Path, $pem)
    $seconds = [int]$clock.Elapsed.TotalSeconds
    $line = "Cosmos emulator $version started in ${seconds}s (PartitionCount=$PartitionCount, DefaultPartitionCount=$DefaultPartitionCount)"
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
