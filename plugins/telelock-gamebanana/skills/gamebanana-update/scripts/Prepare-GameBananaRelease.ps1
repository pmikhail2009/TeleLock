[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$VpkPath,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-zA-Z][0-9a-zA-Z.+-]{0,39}\z')][string]$Version,
    [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$vpk = Get-Item -LiteralPath $VpkPath
if ($vpk -isnot [IO.FileInfo] -or $vpk.Name -notmatch '^pak[0-9]{2}_dir\.vpk$') {
    throw 'Select the built Telelock pakNN_dir.vpk file.'
}

$source = [IO.File]::OpenRead($vpk.FullName)
$temporaryZip = $null
try {
    $header = [IO.BinaryReader]::new($source, [Text.Encoding]::UTF8, $true)
    try {
        if ($source.Length -lt 12 -or $header.ReadUInt32() -ne 0x55AA1234) {
            throw 'The input does not have a VPK header.'
        }
        $format = $header.ReadUInt32()
        $treeSize = $header.ReadUInt32()
        $headerSize = switch ($format) {
            1 { 12 }
            2 { 28 }
            default { throw "Unsupported VPK format: $format." }
        }
        if ($treeSize -eq 0 -or $source.Length -lt ($headerSize + $treeSize)) {
            throw 'The VPK directory is empty or truncated.'
        }
    } finally {
        $header.Dispose()
    }

    $source.Position = 0
    $hash = (Get-FileHash -InputStream $source -Algorithm SHA256).Hash.ToLowerInvariant()
    $source.Position = 0
    $releaseVersion = $Version.ToLowerInvariant() -replace '[.+-]', '_'
    $directory = [IO.Directory]::CreateDirectory(
        $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
    )
    $zipPath = Join-Path $directory.FullName "telelock_${releaseVersion}_$($hash.Substring(0, 12)).zip"

    if (-not [IO.File]::Exists($zipPath)) {
        $temporaryZip = Join-Path $directory.FullName "$([guid]::NewGuid()).tmp"
        $archive = [IO.Compression.ZipFile]::Open($temporaryZip, [IO.Compression.ZipArchiveMode]::Create)
        try {
            $entry = $archive.CreateEntry($vpk.Name)
            $entryStream = $entry.Open()
            try {
                $source.CopyTo($entryStream)
            } finally {
                $entryStream.Dispose()
            }
        } finally {
            $archive.Dispose()
        }
        try {
            [IO.File]::Move($temporaryZip, $zipPath)
        } catch [IO.IOException] {
            if (-not [IO.File]::Exists($zipPath)) { throw }
        }
    }

    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entry = $archive.GetEntry($vpk.Name)
        if ($archive.Entries.Count -ne 1 -or $null -eq $entry -or $entry.Length -ne $source.Length) {
            throw 'The release ZIP does not contain exactly the expected VPK.'
        }
        $entryStream = $entry.Open()
        try {
            if ((Get-FileHash -InputStream $entryStream -Algorithm SHA256).Hash -ne $hash) {
                throw 'The VPK inside the release ZIP does not match the input.'
            }
        } finally {
            $entryStream.Dispose()
        }
    } finally {
        $archive.Dispose()
    }

    [pscustomobject]@{
        version = $Version
        zipPath = $zipPath
        vpkName = $vpk.Name
        vpkSha256 = $hash
    } | ConvertTo-Json
} finally {
    $source.Dispose()
    if ($temporaryZip) { [IO.File]::Delete($temporaryZip) }
}
