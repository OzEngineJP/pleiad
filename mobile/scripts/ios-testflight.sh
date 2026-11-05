#!/bin/bash
# TestFlight へ署名した archive を上げる（.github/workflows/ios-testflight.yml、docs/ios.md「TestFlight への自動の配布」）。
# 秘密はランナーの一時領域だけに復元し、終了時に消す。
# 版は IOS_BUILD_NUMBER（CFBundleVersion。Android の versionCode と同じ git rev-list --count HEAD）と
# IOS_MARKETING_VERSION（CFBundleShortVersionString。mobile/package.json の version）で渡す。
#
# プロファイルは 2 つ（本体 dev.pleiad.app と通知拡張 <本体>.notify）。毎回 ASC API から名前
# （"Pleiad <bundle>" / "Pleiad <bundle>.notify"。mobile/scripts/asc-provision.mjs と同じ規則）で取り、
# 取れなければ Secrets（IOS_PROVISION_PROFILE_BASE64・IOS_NSE_PROVISION_PROFILE_BASE64）に戻る。
# ターゲットごとの署名は xcodebuild 全ターゲットへの上書きでは掛けられないので、PLEIAD_* の変数で渡す
# （既定値は mobile/ios/pleiad.xcconfig）。
set -euo pipefail
: "${IOS_BUILD_NUMBER:?IOS_BUILD_NUMBER is required}" "${IOS_MARKETING_VERSION:?IOS_MARKETING_VERSION is required}"
umask 077
work=$(mktemp -d "$RUNNER_TEMP/pleiad-ios.XXXXXX")
keychain="$work/signing.keychain-db"
profile_paths=()
# 検索リストに一時の Keychain を足し、終わったら元のリストに戻す（手元の Mac で流しても利用者の設定を残さない）
original_keychains=()
while IFS= read -r line; do
  line=${line#"${line%%[![:space:]]*}"}; line=${line#\"}; line=${line%\"}
  [ -n "$line" ] && original_keychains+=("$line")
done < <(security list-keychains -d user)
cleanup() {
  if [ ${#original_keychains[@]} -gt 0 ]; then security list-keychains -d user -s "${original_keychains[@]}" || true; fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  for p in ${profile_paths[@]+"${profile_paths[@]}"}; do rm -f "$p"; done
  rm -rf "$work"
}
trap cleanup EXIT
export IOS_SIGNING_WORK="$work"
python3 - <<'PY'
import base64, os
from pathlib import Path
work = Path(os.environ['IOS_SIGNING_WORK'])
for env, name in [('IOS_DISTRIBUTION_P12_BASE64', 'distribution.p12'),
                  ('ASC_PRIVATE_KEY_BASE64', 'AuthKey.p8')]:
    (work / name).write_bytes(base64.b64decode(os.environ[env], validate=True))
PY
# プロファイル: まず ASC API で名前で取る（App Manager 以上の鍵）。取れなければ Secrets の代替
mkdir -p "$work/profiles"
: "${IOS_BUNDLE_ID:?IOS_BUNDLE_ID is required}"
if ! node mobile/scripts/asc-provision.mjs --bundle-id "$IOS_BUNDLE_ID" --fetch --out-dir "$work/profiles" 2>"$work/fetch.log"; then
  cat "$work/fetch.log" >&2
  python3 - <<'PY'
import base64, os
from pathlib import Path
work = Path(os.environ['IOS_SIGNING_WORK'])
missing = [e for e in ('IOS_PROVISION_PROFILE_BASE64', 'IOS_NSE_PROVISION_PROFILE_BASE64') if not os.environ.get(e)]
if missing:
    raise SystemExit('Fetching profiles from App Store Connect failed and the fallback secrets are empty: ' + ' '.join(missing)
                     + '. Run the ios-provision workflow or store the two .mobileprovision files (docs/ios.md)')
for env, name in [('IOS_PROVISION_PROFILE_BASE64', 'app.mobileprovision'),
                  ('IOS_NSE_PROVISION_PROFILE_BASE64', 'nse.mobileprovision')]:
    (work / 'profiles' / name).write_bytes(base64.b64decode(os.environ[env], validate=True))
PY
fi
for tag in app nse; do
  security cms -D -i "$work/profiles/$tag.mobileprovision" > "$work/profiles/$tag.plist"
done
# 本体は App Store のプロファイル（aps-environment=production）、通知拡張は <本体>.notify。
# どちらもワイルドカード不可・チームは一致
python3 - <<'PY'
import json, os, plistlib, shlex
from pathlib import Path
p = Path(os.environ['IOS_SIGNING_WORK'])
team = os.environ['IOS_TEAM_ID']
app_bundle = os.environ['IOS_BUNDLE_ID']
nse_bundle = app_bundle + '.notify'
def check(tag, want):
    profile = plistlib.loads((p / 'profiles' / f'{tag}.plist').read_bytes())
    app = profile['Entitlements']['application-identifier']
    prefix = profile['ApplicationIdentifierPrefix'][0] + '.'
    if not app.startswith(prefix) or '*' in app:
        raise SystemExit(f'Use a profile for an explicit Bundle ID ({tag})')
    bundle = app[len(prefix):]
    if bundle != want:
        raise SystemExit(f'The {tag} profile is for {bundle}, not {want}')
    if team not in profile['TeamIdentifier']:
        raise SystemExit(f'{tag} profile team mismatch')
    return profile
app = check('app', app_bundle)
if app['Entitlements'].get('aps-environment') != 'production':
    raise SystemExit('The app profile must have aps-environment=production. Use an App Store profile, not a development one')
nse = check('nse', nse_bundle)
vars_ = {'APP_BUNDLE': app_bundle, 'APP_PROFILE': app['Name'], 'NSE_BUNDLE': nse_bundle, 'NSE_PROFILE': nse['Name']}
(p / 'vars.sh').write_text('\n'.join(f'{k}={shlex.quote(v)}' for k, v in vars_.items()))
(p / 'ExportOptions.plist').write_bytes(plistlib.dumps({
    'method': 'app-store-connect', 'destination': 'upload', 'teamID': team,
    'signingStyle': 'manual', 'signingCertificate': 'Apple Distribution',
    'provisioningProfiles': {app_bundle: app['Name'], nse_bundle: nse['Name']},
    'manageAppVersionAndBuildNumber': False, 'uploadSymbols': True,
}))
PY
profile_dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profile_dir"
for tag in app nse; do
  uuid=$(/usr/libexec/PlistBuddy -c 'Print UUID' "$work/profiles/$tag.plist")
  dst="$profile_dir/$uuid.mobileprovision"
  cp "$work/profiles/$tag.mobileprovision" "$dst"
  profile_paths+=("$dst")
done
keychain_password=$(openssl rand -hex 24)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/distribution.p12" -k "$keychain" -P "$IOS_DISTRIBUTION_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" ${original_keychains[@]+"${original_keychains[@]}"}
. "$work/vars.sh"
xcodebuild archive -project mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' -archivePath "$work/App.xcarchive" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' \
  DEVELOPMENT_TEAM="$IOS_TEAM_ID" \
  PLEIAD_APP_BUNDLE="$APP_BUNDLE" PLEIAD_NSE_BUNDLE="$NSE_BUNDLE" \
  PLEIAD_APP_PROFILE="$APP_PROFILE" PLEIAD_NSE_PROFILE="$NSE_PROFILE" \
  CURRENT_PROJECT_VERSION="$IOS_BUILD_NUMBER" MARKETING_VERSION="$IOS_MARKETING_VERSION"
xcodebuild -exportArchive -archivePath "$work/App.xcarchive" -exportOptionsPlist "$work/ExportOptions.plist" \
  -exportPath "$work/export" -allowProvisioningUpdates \
  -authenticationKeyPath "$work/AuthKey.p8" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
