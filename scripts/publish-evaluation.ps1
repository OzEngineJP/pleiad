# The Evaluation release workflow builds each platform in its own job, in parallel, and publishes them together:
#   -BuildOnly      the windows job: build and sign Windows, and leave the Windows assets in release-assets (uploaded as an artifact).
#   -WindowsAssets  the publish job: the Windows assets from the windows job, used instead of building here.
#   -MacAssets      the publish job: the signed and notarized macOS build (dmg, zip, blockmap, latest-mac.yml), merged by scripts/release-mac-merge.mjs.
# Without -BuildOnly or -WindowsAssets the script builds Windows itself and publishes, as one step.
# Both platforms go into one draft and are published together; a published release cannot take assets later (immutable releases).
param([Parameter(Mandatory = $true)][string]$Tag, [string]$MacAssets = $env:PLY_MAC_ASSETS, [string]$WindowsAssets = $env:PLY_WINDOWS_ASSETS, [switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
if ($BuildOnly -and ($MacAssets -or $WindowsAssets)) { throw 'BuildOnly builds Windows only; it does not take prebuilt assets.' }
$package = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
if ($Tag -notmatch '^v\d+\.\d+\.\d+(-beta\.\d+)?$' -or $Tag -cne "v$($package.version)") { throw 'Evaluation tag must match the package version (vX.Y.Z or vX.Y.Z-beta.N).' }
if (!$env:GH_TOKEN -or !$env:GITHUB_REPOSITORY) { throw 'Run from the evaluation release workflow.' }
$env:RELEASE_TAG = $Tag
$env:GH_REPO = $env:GITHUB_REPOSITORY
if (git status --porcelain --untracked-files=no) { throw 'Tracked source files must be clean before packaging.' }
$source = (& git rev-parse HEAD).Trim()
$tagSource = (& git rev-parse "$Tag^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $source -ne $tagSource) { throw 'Checkout must match the source tag.' }
if (Test-Path -LiteralPath release-assets) { throw 'Use a fresh release checkout.' }
$unsigned = $env:PLY_WINDOWS_SIGNING -eq 'none'
# Users can install an unsigned update only from a version whose desktop/update-trust.json accepts unsigned updates (ADR 0209)
if ($unsigned) {
  & node.exe scripts/release-unsigned-guard.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Unsigned release blocked: publish a signed bridge release first.' }
}
if (!$WindowsAssets) {
  & "$PSScriptRoot/build-evaluation.ps1" -OutputDirectory dist-desktop
  if ($LASTEXITCODE -ne 0) { throw 'Evaluation build failed.' }
  $WindowsAssets = 'dist-desktop'
}
New-Item -ItemType Directory -Path release-assets | Out-Null
$names = Get-ChildItem -LiteralPath $WindowsAssets -File | Where-Object { $_.Name -match '\.(exe|blockmap)$' -or $_.Name -in @('latest.yml','Pleiad-Evaluation.cer','evaluation-certificate.ps1','SIGNING-INFO.json') }
foreach ($file in $names) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path release-assets $file.Name) }
if (!(Test-Path -LiteralPath release-assets/latest.yml) -or !(Get-ChildItem -LiteralPath release-assets -Filter '*.exe')) { throw 'Windows assets are missing the installer or latest.yml.' }
# The windows job and the publish job read PLY_WINDOWS_SIGNING separately; the assets must match what this job writes into BUILD-INFO.json
if ($unsigned -eq (Test-Path -LiteralPath release-assets/SIGNING-INFO.json)) { throw 'Windows assets do not match PLY_WINDOWS_SIGNING.' }
if ($BuildOnly) {
  Write-Output 'Windows assets are ready in release-assets.'
  return
}
$platforms = 'windows'
if ($MacAssets) {
  $macFiles = @(Get-ChildItem -LiteralPath $MacAssets -File | Where-Object { $_.Name -match '\.(dmg|zip|blockmap)$' -or $_.Name -eq 'latest-mac.yml' })
  if (!($macFiles | Where-Object Name -eq 'latest-mac.yml')) { throw 'macOS assets are missing latest-mac.yml.' }
  foreach ($file in $macFiles) {
    $destination = Join-Path release-assets $file.Name
    if (Test-Path -LiteralPath $destination) { throw "macOS asset collides with a Windows asset: $($file.Name)" }
    Copy-Item -LiteralPath $file.FullName -Destination $destination
  }
  $platforms = 'all'
}
$trust = Get-Content -LiteralPath desktop/update-trust.json -Raw | ConvertFrom-Json
$buildInfo = [ordered]@{ version = $package.version; sourceCommit = $source; signing = $(if ($unsigned) { 'unsigned' } else { 'self-signed evaluation' }); updateAcceptsUnsigned = ($trust.unsigned -eq 'accept'); platforms = $platforms }
if ($MacAssets) { $buildInfo.macSigning = 'Developer ID, notarized' }
$buildInfo.runUrl = "https://github.com/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"
$buildInfo | ConvertTo-Json | Set-Content -LiteralPath release-assets/BUILD-INFO.json -Encoding UTF8
& node.exe scripts/release-artifacts.mjs release-assets $package.version 100 temporary/release-notes.md $platforms
if ($LASTEXITCODE -ne 0) { throw 'Release integrity check failed.' }
& node.exe scripts/release-publish.mjs draft release-assets
if ($LASTEXITCODE -ne 0) { throw 'Draft creation failed.' }
# Verify the uploaded bytes before exposing this version to the updater.
& gh.exe release download $Tag --repo $env:GH_REPO --dir release-download
if ($LASTEXITCODE -ne 0) { throw 'Uploaded release could not be downloaded for verification.' }
foreach ($file in (Get-ChildItem -LiteralPath release-assets -File)) {
  $download = Join-Path release-download $file.Name
  if (!(Test-Path -LiteralPath $download) -or (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw "Uploaded bytes differ: $($file.Name)" }
}
& node.exe scripts/release-publish.mjs publish release-assets
if ($LASTEXITCODE -ne 0) { throw 'Publication failed; inspect the draft before retrying.' }
Write-Output "Published https://github.com/$env:GH_REPO/releases/tag/$Tag"
