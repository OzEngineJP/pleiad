# Hand check of desktop/update-signature.cjs (ADR 0209) with the real koffi and the real electron-updater publisher check on this Windows PC.
# Builds a tiny unsigned exe, signs a copy with a throw-away self-signed code-signing certificate in CurrentUser\My (NOT trusted by Windows),
# and checks the update verifier against: unsigned (policy accept / reject), sha512 mismatch with latest.yml, pinned / unpinned self-signed,
# a 1-byte-modified signed copy, and a Windows-trusted signature (node.exe) with an unlisted / listed publisher. Optionally a real installer.
# Removes the certificate (Set-AuthenticodeSignature also caches it in CurrentUser\CA; removed too) and the copies when done.
# Never touches CurrentUser\Root or any existing certificate.
#   powershell -File scripts/verify-update-signature.ps1 [-Installer <path to a real release installer>]
param([string]$Installer = '')
$ErrorActionPreference = 'Stop'
$work = Join-Path ([IO.Path]::GetTempPath()) ('ply-sigcheck-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$cert = $null
function Check([string]$file, [string[]]$options) {
  $json = & node (Join-Path $PSScriptRoot 'update-signature-check.cjs') $file @options
  if ($LASTEXITCODE -ne 0) { throw "check failed for $file" }
  return $json | ConvertFrom-Json
}
function Show([string]$label, $r, [bool]$expectAccepted) {
  $accepted = ($null -eq $r.result)
  $ok = ($accepted -eq $expectAccepted)
  Write-Output ("{0}: {1} (expected {2}) -> {3}; WinVerifyTrust={4}; reason={5}" -f $label, $(if ($accepted) { 'accepted' } else { 'rejected' }), $(if ($expectAccepted) { 'accepted' } else { 'rejected' }), $(if ($ok) { 'PASS' } else { 'FAIL' }), $r.hresult, $r.result)
  if (!$ok) { $script:failed = $true }
}
$failed = $false
try {
  $source = Join-Path $work 'tiny.cs'
  Set-Content -LiteralPath $source -Value 'class P { static void Main() { System.Console.WriteLine("ply"); } }' -Encoding ASCII
  $exe = Join-Path $work 'unsigned.exe'
  Add-Type -TypeDefinition (Get-Content -LiteralPath $source -Raw) -OutputAssembly $exe -OutputType ConsoleApplication
  $other = Join-Path $work 'other.exe'
  Set-Content -LiteralPath (Join-Path $work 'other.cs') -Value 'class Q { static void Main() { System.Console.WriteLine("other"); } }' -Encoding ASCII
  Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $work 'other.cs') -Raw) -OutputAssembly $other -OutputType ConsoleApplication

  Show 'unsigned + policy accepts unsigned' (Check $exe @('--unsigned', 'accept')) $true
  Show 'unsigned + policy rejects unsigned' (Check $exe @('--unsigned', 'reject', '--publisher', 'Example Publisher')) $false
  Show 'unsigned + sha512 differs from latest.yml' (Check $exe @('--unsigned', 'accept', '--expect', $other)) $false

  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject ('CN=Ply Update Signature Test ' + [guid]::NewGuid().ToString('N').Substring(0, 8)) -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(2)
  $thumb = $cert.Thumbprint
  Write-Output "test certificate: $thumb"
  $signed = Join-Path $work 'signed.exe'
  Copy-Item -LiteralPath $exe -Destination $signed
  Set-AuthenticodeSignature -FilePath $signed -Certificate $cert -HashAlgorithm SHA256 | Out-Null
  Write-Output "Get-AuthenticodeSignature status after signing: $((Get-AuthenticodeSignature -LiteralPath $signed).Status)"
  Show 'self-signed + fingerprint pinned' (Check $signed @('--unsigned', 'accept', '--signer', $thumb)) $true
  Show 'self-signed + lowercase fingerprint pinned' (Check $signed @('--unsigned', 'reject', '--signer', $thumb.ToLower())) $true
  Show 'self-signed + fingerprint NOT pinned (unsigned accepted)' (Check $signed @('--unsigned', 'accept', '--signer', 'BCEE9BE88BEE6BB94909FC74C0622420CAE50910')) $false
  $tampered = Join-Path $work 'tampered.exe'
  $bytes = [IO.File]::ReadAllBytes($signed)
  $bytes[200] = $bytes[200] -bxor 0xFF   # inside the PE headers, covered by the digest
  [IO.File]::WriteAllBytes($tampered, $bytes)
  Show 'self-signed + 1 byte modified (sha512 matches)' (Check $tampered @('--unsigned', 'accept', '--signer', $thumb)) $false

  # A signature Windows trusts: node.exe (embedded Authenticode). Accepted only when its publisher is listed
  $node = (Get-Command node).Source
  $nodeSignature = Get-AuthenticodeSignature -LiteralPath $node
  if ($nodeSignature.Status -eq 'Valid') {
    $cn = ($nodeSignature.SignerCertificate.Subject -split ', ' | Where-Object { $_ -like 'CN=*' } | Select-Object -First 1).Substring(3).Trim('"')
    Write-Output "trusted signature: $node ($cn)"
    Show 'trusted signature + publisher NOT listed (unsigned accepted)' (Check $node @('--unsigned', 'accept')) $false
    Show 'trusted signature + publisher listed' (Check $node @('--unsigned', 'reject', '--publisher', $cn)) $true
  } else {
    Write-Output "skipped the trusted signature cases: node.exe is $($nodeSignature.Status)"
  }

  if ($Installer) {
    Show "real installer with desktop/update-trust.json ($((Get-AuthenticodeSignature -LiteralPath $Installer).Status))" (Check $Installer @()) $true
  }
} finally {
  if ($cert) { foreach ($store in 'My', 'CA') { Remove-Item -LiteralPath ("Cert:\CurrentUser\$store\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue } }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failed) { Write-Output 'RESULT: FAIL'; exit 1 }
Write-Output 'RESULT: PASS'
