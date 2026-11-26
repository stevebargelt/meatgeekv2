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
#       count, as a notice and in the job summary. First it removes the runner
#       image's localhost certificates that crash the emulator's gateway at
#       start-up (HAR-190, below), and afterwards it warns if that crash still
#       happened.
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

# HAR-190 — why the gateway crashed at start-up, and what removes the cause.
# The emulator's secrets certificate is CN=localhost (friendly name
# CosmosEmulatorSecrets). At each start, the StartupEntryPoint of its gateway
# (and controller and background-task services) calls
# AclCertificateUtil.SetCertificateAclByCommonName('localhost'), which finds
# certificates in LocalMachine\My with X509FindType.FindBySubjectName: a
# substring match, so every certificate whose subject contains "localhost". For
# each one it opens the private key as a CNG key, to add its service group to
# the key file's ACL, and it throws if any one of them has no private key,
# has one that cannot be opened or does not open as an RSACng or ECDsaCng key,
# or has no key file where it looks. The windows-2025 runner image ships an
# "IIS Express Development Certificate", CN=localhost, whose private key is
# gone ("Keyset does not exist"). So the gateway's StartupEntryPoint dies with a
# CryptographicException in SetCertificateAcl at every start, on 2.14.28.0 and
# 2.14.29.0 alike. Windows logs it as .NET Runtime event 1026, then Application
# Error 1000. The start succeeds only if Service Fabric starts the gateway
# again soon enough. It usually does, but on 2.14.29.0 it once took 170 s, and
# the 300 s bound ran out (job 139411256607). Removing such certificates before
# the start removes the crash. None of them is the emulator's own: it creates
# its certificates during the start, with CNG keys.
function Read-CertificatePrivateKey($Certificate) {
  # The certificate's private key as the emulator's AclCertificateUtil reads
  # it: GetRSAPrivateKey, or GetECDsaPrivateKey, which try CNG first, in
  # .NET Framework as in pwsh's .NET. They return an RSACng/ECDsaCng for a key
  # CNG can open, including a software CSP key, and an RSACryptoServiceProvider
  # for a CSP key it cannot. Also where the emulator looks for a CNG key's file
  # (GetPrivateKeyFileInfo) and whether that file exists.
  $key = $null
  $keyError = $null
  $keyFile = $null
  if ($Certificate.HasPrivateKey) {
    try {
      $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
      if (-not $key) { $key = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($Certificate) }
    } catch {
      $keyError = $_.Exception.InnerException.Message
      if (-not $keyError) { $keyError = $_.Exception.Message }
    }
  }
  if (($key -is [System.Security.Cryptography.RSACng] -or $key -is [System.Security.Cryptography.ECDsaCng]) -and $key.Key.UniqueName) {
    $folder = if ($key.Key.Provider -eq [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider) { 'Microsoft\Crypto\Keys' } else { 'Microsoft\Crypto\RSA\MachineKeys' }
    $keyFile = [System.IO.Path]::Combine([Environment]::GetFolderPath('CommonApplicationData'), $folder, $key.Key.UniqueName)
  }
  [pscustomobject]@{ Key = $key; Error = $keyError; KeyFile = $keyFile; KeyFileExists = [bool]($keyFile -and [System.IO.File]::Exists($keyFile)) }
}

function Get-LocalhostCertificateProblem([bool]$HasPrivateKey, $Read) {
  # Why the emulator's ACL step would throw on this certificate, or $null if
  # it would not. $Read is what Read-CertificatePrivateKey returned. The steps
  # follow AclCertificateUtil.SetCertificateAcl: the key must open, be an
  # RSACng or ECDsaCng key, and have its file where the emulator looks.
  if (-not $HasPrivateKey) { return 'it has no private key' }
  if ($Read.Error) { return "its private key cannot be opened ($($Read.Error))" }
  if ($null -eq $Read.Key) { return 'its private key is neither an RSA nor an ECDsa key' }
  if (-not ($Read.Key -is [System.Security.Cryptography.RSACng] -or $Read.Key -is [System.Security.Cryptography.ECDsaCng])) {
    $type = $Read.Key.GetType().Name
    if ($type -match 'CryptoServiceProvider$') { return "its private key is held by a legacy CSP that CNG cannot open ($type)" }
    return "its private key opens as $type, not as a CNG key"
  }
  if (-not $Read.KeyFileExists) { return "its CNG key has no file where the emulator looks for it ($(if ($Read.KeyFile) { $Read.KeyFile } else { 'an ephemeral key' }))" }
  return $null
}

function Remove-LocalhostCertificatesTheEmulatorCannotUse {
  # The certificates SetCertificateAclByCommonName('localhost') would find, and
  # the removal of each one it would fail on, logged as a notice.
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'LocalMachine')
  $store.Open('ReadWrite')
  try {
    $found = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindBySubjectName, 'localhost', $false)
    foreach ($cert in $found) {
      $read = Read-CertificatePrivateKey $cert
      $problem = Get-LocalhostCertificateProblem $cert.HasPrivateKey $read
      $what = "$($cert.Subject) '$($cert.FriendlyName)' ($($cert.Thumbprint))"
      if ($problem) {
        $store.Remove($cert)
        Write-Host "::notice title=Removed a localhost certificate (HAR-190)::Removed $what from LocalMachine\My before starting the emulator: $problem, which would crash the emulator's gateway at start-up."
      } else {
        Write-Host "Kept $what in LocalMachine\My: its private key is a CNG key ($($read.Key.Key.Provider.Provider), $($read.KeyFile))."
      }
    }
  } finally {
    $store.Close()
  }
}

function Test-SetCertificateAclFault([string]$Message) {
  # Every marker of the HAR-190 crash in the .NET Runtime 1026 event's text,
  # and only that crash: a different exception or process does not match.
  return ($Message -match 'Microsoft\.Azure\.Cosmos\.StartupEntryPoint\.exe') -and
    ($Message -match 'System\.Security\.Cryptography\.CryptographicException') -and
    ($Message -match 'AclCertificateUtil\.SetCertificateAcl')
}

function Find-SetCertificateAclFault([datetime]$Since) {
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = '.NET Runtime'; Id = 1026; StartTime = $Since } -ErrorAction SilentlyContinue |
    Where-Object { Test-SetCertificateAclFault $_.Message } |
    Select-Object -First 1
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
    Remove-LocalhostCertificatesTheEmulatorCannotUse
    $since = Get-Date
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
    # The removal above should leave nothing for this to find; say so if not.
    $fault = Find-SetCertificateAclFault $since
    if ($fault) {
      Write-Host "::warning title=Cosmos emulator SetCertificateAcl crash (HAR-190)::StartupEntryPoint died with a CryptographicException in AclCertificateUtil.SetCertificateAcl at $($fault.TimeCreated.ToString('HH:mm:ss')), during this start."
      Write-Host $fault.Message
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
