# Builds the debug APK and copies it to the test phone over SSH (Termux), into Download/Raincheck.apk.
# Install it on the phone from My Files > Download. Saved data is kept on update.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-termux.ps1            # build + install
#   powershell -ExecutionPolicy Bypass -File scripts\install-termux.ps1 -NoBuild   # install the last build
param(
  [string]$PhoneHost = "10.0.99.103",
  [int]$Port = 8022,
  [string]$Key = "$env:USERPROFILE\.ssh\id_ed25519_termux",
  [switch]$NoBuild,
  [switch]$OpenInstaller
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$env:JAVA_HOME = (Get-ChildItem "C:\Program Files\Microsoft" -Directory -Filter "jdk-21*" | Select-Object -First 1).FullName
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path = "C:\Program Files\nodejs;$env:JAVA_HOME\bin;$env:Path"

$apk = Join-Path $root "android\app\build\outputs\apk\debug\app-debug.apk"
if (-not $NoBuild) {
  Write-Host "Building..."
  node scripts/build-web.mjs
  node node_modules/@capacitor/cli/bin/capacitor sync android | Out-Null
  Push-Location android
  & .\gradlew.bat assembleDebug --console=plain -q
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "Gradle build failed ($code)" }
}
if (-not (Test-Path $apk)) { throw "No APK at $apk. Run without -NoBuild." }

$version = ([regex]::Match((Get-Content android\app\build.gradle -Raw), 'versionName "([^"]+)"')).Groups[1].Value
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$remote = "raincheck/Raincheck-$version-$stamp.apk"
$sshArgs = @("-i", $Key, "-p", $Port, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10")

Write-Host "Copying to phone as ~/$remote ..."
& ssh @sshArgs $PhoneHost "mkdir -p ~/raincheck && find ~/raincheck -name 'Raincheck-*.apk' -mtime +2 -delete"
& scp -i $Key -P $Port -o BatchMode=yes $apk "${PhoneHost}:$remote"
if ($LASTEXITCODE -ne 0) { throw "Copy failed" }

# Put a copy in the phone's Download folder under a fixed name, replacing the previous build.
& ssh @sshArgs $PhoneHost "cp ~/$remote /sdcard/Download/Raincheck.apk && ls -l /sdcard/Download/Raincheck.apk"
if ($LASTEXITCODE -ne 0) { throw "Couldn't copy to Download" }

if ($OpenInstaller) {
  # Asks Android's installer to open the APK. On the Galaxy Note 8 (Android 9) test phone the installer
  # closes immediately when opened this way, so it's off by default.
  & ssh @sshArgs $PhoneHost "termux-open --content-type application/vnd.android.package-archive ~/$remote"
}
Write-Host "Done. On the phone: My Files > Download > Raincheck.apk > Install / Update."
