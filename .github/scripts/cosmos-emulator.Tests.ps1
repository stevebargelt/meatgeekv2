# HAR-190 — cosmos-emulator.ps1 removes the localhost certificates that crash
# the emulator's gateway at start-up, and warns if that crash still happens.
# These cases pin which certificates it removes, and what counts as the crash:
# the real .NET Runtime 1026 event from api-cosmos-emulator job 139411256607
# matches; its Application Error 1000 event, and the same event with any one
# marker changed, do not.
# Run: Invoke-Pester -Path .github/scripts/cosmos-emulator.Tests.ps1
BeforeAll {
  # Load the pure functions without running the script (it starts the emulator).
  $script = Join-Path $PSScriptRoot 'cosmos-emulator.ps1'
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$parseErrors)
  if ($parseErrors.Count) { throw "cosmos-emulator.ps1 does not parse: $($parseErrors -join '; ')" }
  foreach ($name in 'Test-SetCertificateAclFault', 'Get-LocalhostCertificateProblem', 'Read-CertificatePrivateKey') {
    $definition = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
      }, $true) | Select-Object -First 1
    if (-not $definition) { throw "cosmos-emulator.ps1 defines no $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
  }

  $fixtures = Join-Path $PSScriptRoot 'fixtures'
  $event1026 = Get-Content -Raw (Join-Path $fixtures 'cosmos-emulator-event-1026-har190.txt')
  $event1000 = Get-Content -Raw (Join-Path $fixtures 'cosmos-emulator-event-1000-har190.txt')
}

Describe 'Test-SetCertificateAclFault' {
  It 'matches the .NET Runtime 1026 event of job 139411256607' {
    Test-SetCertificateAclFault $event1026 | Should -BeTrue
  }

  It 'does not match the Application Error 1000 event alone (it names no exception)' {
    Test-SetCertificateAclFault $event1000 | Should -BeFalse
  }

  It 'does not match a different exception in StartupEntryPoint' {
    $other = $event1026 -replace 'System\.Security\.Cryptography\.CryptographicException', 'System.InvalidOperationException'
    Test-SetCertificateAclFault $other | Should -BeFalse
  }

  It 'does not match a CryptographicException outside SetCertificateAcl' {
    $other = $event1026 -replace 'AclCertificateUtil\.SetCertificateAcl', 'CertificateUtil.GetCertificateBySubject'
    Test-SetCertificateAclFault $other | Should -BeFalse
  }

  It 'does not match the same stack in another process' {
    $other = $event1026 -replace 'Microsoft\.Azure\.Cosmos\.StartupEntryPoint\.exe', 'Microsoft.Azure.Cosmos.Server.exe'
    Test-SetCertificateAclFault $other | Should -BeFalse
  }

  It 'does not match an empty message' {
    Test-SetCertificateAclFault '' | Should -BeFalse
  }
}

Describe 'Get-LocalhostCertificateProblem' {
  # The read-back cases build a real certificate and read it through
  # Read-CertificatePrivateKey, the path the script takes. The other cases pass
  # a real key object of the type GetRSAPrivateKey / GetECDsaPrivateKey yields.
  # CNG and CSP key containers exist only on Windows, so those cases run there
  # (CI's api-cosmos-emulator job runs this file on windows-2025).
  BeforeAll {
    function New-LocalhostCertificate([System.Security.Cryptography.RSA]$Key) {
      $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=localhost', $Key, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $request.CreateSelfSigned([datetimeoffset]::new(2026, 1, 1, 0, 0, 0, [timespan]::Zero), [datetimeoffset]::new(2027, 1, 1, 0, 0, 0, [timespan]::Zero))
    }
    function Read-Key($Key) { [pscustomobject]@{ Key = $Key; Error = $null; KeyFile = $null; KeyFileExists = $false } }
  }

  It 'removes the IIS Express Development Certificate as the runner image ships it (key gone)' {
    $read = [pscustomobject]@{ Key = $null; Error = 'Keyset does not exist'; KeyFile = $null; KeyFileExists = $false }
    Get-LocalhostCertificateProblem $true $read | Should -Be 'its private key cannot be opened (Keyset does not exist)'
  }

  It 'removes a localhost certificate with no private key' {
    $withKey = New-LocalhostCertificate ([System.Security.Cryptography.RSA]::Create(2048))
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($withKey.RawData)
    $read = Read-CertificatePrivateKey $cert
    $read.Key | Should -BeNullOrEmpty
    Get-LocalhostCertificateProblem $cert.HasPrivateKey $read | Should -Be 'it has no private key'
  }

  It 'removes a localhost certificate with a private key that is neither RSA nor ECDsa' {
    Get-LocalhostCertificateProblem $true (Read-Key $null) | Should -Be 'its private key is neither an RSA nor an ECDsa key'
  }

  It 'removes a localhost certificate whose key opens as RSACryptoServiceProvider (a CSP key CNG cannot open)' {
    $key = [System.Security.Cryptography.RSACryptoServiceProvider]::new(2048)
    try {
      Get-LocalhostCertificateProblem $true (Read-Key $key) | Should -Be 'its private key is held by a legacy CSP that CNG cannot open (RSACryptoServiceProvider)'
    } finally { $key.Dispose() }
  }

  It 'removes a certificate whose key is not a CNG key, read back through Read-CertificatePrivateKey' -Skip:$IsWindows {
    # Off Windows a certificate's key reads back as the platform's RSA.
    $cert = New-LocalhostCertificate ([System.Security.Cryptography.RSA]::Create(2048))
    $read = Read-CertificatePrivateKey $cert
    $read.Key | Should -Not -BeNullOrEmpty
    Get-LocalhostCertificateProblem $cert.HasPrivateKey $read | Should -Match '^its private key opens as \S+, not as a CNG key$'
  }

  It "keeps a certificate whose CNG key is a machine key in the software key storage provider, as the emulator's own are" -Skip:(-not $IsWindows) {
    $parameters = [System.Security.Cryptography.CngKeyCreationParameters]::new()
    $parameters.Provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
    $parameters.KeyCreationOptions = [System.Security.Cryptography.CngKeyCreationOptions]::MachineKey
    $parameters.Parameters.Add([System.Security.Cryptography.CngProperty]::new('Length', [BitConverter]::GetBytes(2048), [System.Security.Cryptography.CngPropertyOptions]::None))
    $cng = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::Rsa, "har190-test-$([guid]::NewGuid())", $parameters)
    try {
      $cert = New-LocalhostCertificate ([System.Security.Cryptography.RSACng]::new($cng))
      $read = Read-CertificatePrivateKey $cert
      $read.Key | Should -BeOfType [System.Security.Cryptography.RSACng]
      $read.KeyFile | Should -BeLike "$([Environment]::GetFolderPath('CommonApplicationData'))\Microsoft\Crypto\Keys\*"
      $read.KeyFileExists | Should -BeTrue
      Get-LocalhostCertificateProblem $cert.HasPrivateKey $read | Should -BeNullOrEmpty
    } finally { $cng.Delete() }
  }

  It 'removes a certificate whose CNG key has no file where the emulator looks (an ephemeral key)' -Skip:(-not $IsWindows) {
    $key = [System.Security.Cryptography.RSACng]::new(2048)
    try {
      $cert = New-LocalhostCertificate $key
      $read = Read-CertificatePrivateKey $cert
      $read.Key | Should -BeOfType [System.Security.Cryptography.RSACng]
      $read.KeyFileExists | Should -BeFalse
      Get-LocalhostCertificateProblem $cert.HasPrivateKey $read | Should -Match '^its CNG key has no file where the emulator looks for it'
    } finally { $key.Dispose() }
  }

  It 'removes a certificate whose key is in a software CSP container, read back through Read-CertificatePrivateKey' -Skip:(-not $IsWindows) {
    # CNG opens a software CSP key, so it reads back as RSACng (job
    # 139605737919), in pwsh as in the emulator's .NET Framework; but its file
    # is not where the emulator looks for a CNG key.
    $csp = [System.Security.Cryptography.CspParameters]::new(24, 'Microsoft Enhanced RSA and AES Cryptographic Provider', "har190-test-$([guid]::NewGuid())")
    $key = [System.Security.Cryptography.RSACryptoServiceProvider]::new(2048, $csp)
    try {
      $key.PersistKeyInCsp = $true
      $cert = New-LocalhostCertificate $key
      $read = Read-CertificatePrivateKey $cert
      $read.Error | Should -BeNullOrEmpty
      $read.KeyFileExists | Should -BeFalse
      Get-LocalhostCertificateProblem $cert.HasPrivateKey $read | Should -Not -BeNullOrEmpty
    } finally {
      $key.PersistKeyInCsp = $false
      $key.Clear()
    }
  }

  It 'keeps a localhost certificate with an ECDsaCng key whose file is where the emulator looks' -Skip:(-not $IsWindows) {
    $key = [System.Security.Cryptography.ECDsaCng]::new(256)
    try {
      $read = [pscustomobject]@{ Key = $key; Error = $null; KeyFile = 'C:\ProgramData\Microsoft\Crypto\Keys\k'; KeyFileExists = $true }
      Get-LocalhostCertificateProblem $true $read | Should -BeNullOrEmpty
    } finally { $key.Dispose() }
  }
}
