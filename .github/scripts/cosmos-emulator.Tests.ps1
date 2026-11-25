# HAR-190 — cosmos-emulator.ps1 restarts the emulator for one start-up fault
# only. These cases pin what counts as that fault: the real .NET Runtime 1026
# event from api-cosmos-emulator job 139411256607 matches; its Application
# Error 1000 event, and the same event with any one marker changed, do not.
# Run: Invoke-Pester -Path .github/scripts/cosmos-emulator.Tests.ps1
BeforeAll {
  # Load the one function without running the script (it starts the emulator).
  $script = Join-Path $PSScriptRoot 'cosmos-emulator.ps1'
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$parseErrors)
  if ($parseErrors.Count) { throw "cosmos-emulator.ps1 does not parse: $($parseErrors -join '; ')" }
  $definition = $ast.FindAll({
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq 'Test-SetCertificateAclFault'
    }, $true) | Select-Object -First 1
  if (-not $definition) { throw 'cosmos-emulator.ps1 defines no Test-SetCertificateAclFault' }
  . ([scriptblock]::Create($definition.Extent.Text))

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
