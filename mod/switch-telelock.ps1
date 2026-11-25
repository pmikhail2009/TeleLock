param(
    [ValidateSet('Normal', 'Lab', 'Status')][string]$Edition,
    [string]$GameDirectory = 'D:/steam/steamapps/common/Deadlock',
    [string]$PackageDirectory = (Join-Path $PSScriptRoot 'build/telelock-versions'),
    [ValidateRange(0, 99)][int]$PackageNumber = 17
)
$ErrorActionPreference = 'Stop'
$name = 'pak{0:D2}_dir.vpk' -f $PackageNumber
$reservedLab = Join-Path $PackageDirectory "reserve/lab/$name"
if ($Edition -eq 'Lab') { throw "Telelock: тестовая версия в резерве: $reservedLab. Сначала восстановите её для разработки." }
$addons = Join-Path $GameDirectory 'game/citadel/addons'
$destination = Join-Path $addons $name
$sources = @{
    Normal = (Join-Path $PackageDirectory "normal/$name")
    Lab = $reservedLab
}
$hashes = @{}
foreach ($version in $sources.Keys) {
    if (Test-Path -LiteralPath $sources[$version] -PathType Leaf) {
        $hashes[$version] = (Get-FileHash -LiteralPath $sources[$version] -Algorithm SHA256).Hash
    } elseif ($version -eq 'Normal') { throw "Missing Telelock package: $($sources[$version])" }
}
if ($hashes.Normal -eq $hashes.Lab) { throw 'The two Telelock packages must be different.' }

$installed = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
$current = if ($installed -eq $hashes.Normal) { 'Normal' } elseif ($installed -eq $hashes.Lab) { 'Lab' }
if (!$current) { throw "Unrecognized VPK in $destination. The switch only replaces these two Telelock packages." }

$labels = @{ Normal = 'обычная'; Lab = 'тестовая' }
Write-Host ("Telelock — установлена {0} версия." -f $labels[$current])
if ($Edition -eq 'Status') { return }
if (!$Edition) {
    $Edition = 'Normal'
}
if ($Edition -eq $current) { return }
if (Get-Process deadlock -ErrorAction SilentlyContinue) { throw 'Закройте Deadlock перед переключением.' }

$temporary = Join-Path $addons ("telelock-{0}.tmp" -f [guid]::NewGuid())
try {
    Copy-Item -LiteralPath $sources[$Edition] -Destination $temporary
    if ((Get-FileHash -LiteralPath $temporary).Hash -ne $hashes[$Edition]) {
        throw 'The copied Telelock package failed verification.'
    }
    if ((Get-FileHash -LiteralPath $destination).Hash -ne $installed) {
        throw 'The installed package changed during the switch. Try again.'
    }
    $backup = $temporary + '.bak'
    [IO.File]::Replace($temporary, (Resolve-Path -LiteralPath $destination).Path, $backup)
    Remove-Item -LiteralPath $backup
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
Write-Host ("Telelock — выбрана {0} версия. Можно запускать Deadlock." -f $labels[$Edition])
