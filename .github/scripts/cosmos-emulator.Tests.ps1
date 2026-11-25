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
  foreach ($name in 'Test-SetCertificateAclFault', 'Get-LocalhostCertificateProblem') {
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
  It 'removes the IIS Express Development Certificate as the runner image ships it (key gone)' {
    Get-LocalhostCertificateProblem $true $null 'Keyset does not exist' | Should -Match 'cannot be opened \(Keyset does not exist\)'
  }

  It 'removes a localhost certificate with no private key' {
    Get-LocalhostCertificateProblem $false $null $null | Should -Be 'it has no private key'
  }

  It 'removes a localhost certificate whose key is held by a legacy CSP' {
    Get-LocalhostCertificateProblem $true 'Microsoft Enhanced Cryptographic Provider v1.0' $null | Should -Match 'legacy CSP'
    Get-LocalhostCertificateProblem $true 'Microsoft Enhanced RSA and AES Cryptographic Provider' $null | Should -Match 'legacy CSP'
  }

  It "keeps the emulator's own certificates (CNG keys in the software key storage provider)" {
    Get-LocalhostCertificateProblem $true 'Microsoft Software Key Storage Provider' $null | Should -BeNullOrEmpty
  }
}
