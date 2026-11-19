param(
    [Parameter(Mandatory)][uri]$PanelUrl,
    [Parameter(Mandatory)][string]$GameDirectory,
    [Parameter(Mandatory)][string]$Viewer,
    [Parameter(Mandatory)][string]$Modlock,
    [string]$EscapeMenuArchive,
    [ValidateRange(0,99)][int]$PackageNumber = 1,
    [switch]$DiagnosticOnly
)
$ErrorActionPreference = 'Stop'
if ($PanelUrl.Scheme -ne 'https' -or $PanelUrl.Query -or $PanelUrl.Fragment -or $PanelUrl.UserInfo) { throw 'Expected an HTTPS panel URL without query or fragment' }
$repo = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $repo ('mod/build/' + [guid]::NewGuid())
$layout = New-Item -ItemType Directory -Path "$stage/content/panorama/layout" -Force
$scripts = New-Item -ItemType Directory -Path "$stage/content/panorama/scripts" -Force
$package = New-Item -ItemType Directory -Path "$stage/package" -Force
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stock = Join-Path $GameDirectory 'game/citadel/pak01_dir.vpk'
foreach ($item in @(
    @('hud_escape_menu','CitadelHudEscapeMenu','KatkaSettings','width: 2px; height: 2px; opacity: 0.01; visibility: visible;'),
    @('base_dashboard','Panel','KatkaCommands','width: 2px; height: 2px; opacity: 0.01; visibility: visible;')
)) {
    $name,$rootTag,$frameId,$style = $item
    $source = Join-Path $stage ($name+'.xml')
    $archive = $stock
    if ($name -eq 'hud_escape_menu' -and $EscapeMenuArchive) { $archive = $EscapeMenuArchive }
    & $Viewer -i $archive -d -f "panorama/layout/$name.vxml_c" -o $source | Out-Null
    if ($LASTEXITCODE -or !(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Could not extract $name" }
    $doc = New-Object xml
    $doc.PreserveWhitespace = $true
    $doc.Load($source)
    $parent = $doc.SelectSingleNode("/root/$rootTag")
    if (!$parent) { throw "Changed layout root: $name" }
    $includes = $doc.SelectSingleNode('/root/scripts')
    if (!$includes) { $includes = $doc.CreateElement('scripts'); [void]$parent.ParentNode.InsertBefore($includes,$parent) }
    $include = $doc.CreateElement('include')
    $include.SetAttribute('src','s2r://panorama/scripts/katka.vjs')
    [void]$includes.AppendChild($include)
    $frame = $doc.CreateElement('CitadelHTMLPanel')
    $frame.SetAttribute('id',$frameId)
    $frame.SetAttribute('style',$style)
    if ($frameId -eq 'KatkaSettings') {
        $placeholder = New-Object xml
        $placeholder.Load((Join-Path $PSScriptRoot 'panorama/settings.xml'))
        if ($DiagnosticOnly) {
            $probeButton = $placeholder.CreateElement('TextButton')
            $probeButton.SetAttribute('id','KatkaDiagnose')
            $probeButton.SetAttribute('text','Проверить управление без поиска')
            $probeButton.SetAttribute('class','PopupButton')
            $probeButton.SetAttribute('style','margin-top: 8px;')
            [void]$placeholder.DocumentElement.AppendChild($probeButton)
        }
        [void]$parent.AppendChild($doc.ImportNode($placeholder.DocumentElement,$true))
    }
    $frame.SetAttribute('hittest','false'); $frame.SetAttribute('acceptsfocus','false')
    [void]$parent.AppendChild($frame)
    if ($frameId -eq 'KatkaCommands') {
        if ($DiagnosticOnly) {
            $diagnostic = $doc.CreateElement('Label')
            $diagnostic.SetAttribute('id','KatkaCommandDiagnostics')
            $diagnostic.SetAttribute('style','horizontal-align: left; vertical-align: bottom; margin: 16px; width: 850px; color: #fff4cb; font-size: 17px; background-color: #20221efa; padding: 8px; z-index: 999;')
            [void]$parent.AppendChild($diagnostic)
        }
        $reporter = $frame.CloneNode($false)
        $reporter.SetAttribute('id','KatkaMatchReport')
        [void]$parent.AppendChild($reporter)
        $commandReporter = $frame.CloneNode($false)
        $commandReporter.SetAttribute('id','KatkaCommandReport')
        [void]$parent.AppendChild($commandReporter)
    }
    [IO.File]::WriteAllText((Join-Path $layout.FullName ($name+'.xml')), $doc.OuterXml, $utf8)
}
$rosterSource = Join-Path $stage 'roster.xml'
& $Viewer -i $stock -d -f 'panorama/layout/popups/citadel_popup_roster_select.vxml_c' -o $rosterSource | Out-Null
if ($LASTEXITCODE -or !(Test-Path -LiteralPath $rosterSource)) { throw 'Could not extract roster popup' }
$roster = New-Object xml
$roster.Load($rosterSource)
$rosterRoot = $roster.SelectSingleNode('/root/CitadelPopupRosterSelect')
$confirmButton = if ($rosterRoot) { $rosterRoot.SelectSingleNode('.//*[@id="ConfirmButton"]') } else { $null }
if (!$confirmButton -or $confirmButton.GetAttribute('onactivate') -notmatch '\bCitadelRosterSelectConfirm\s*\(\s*\)') {
    throw 'Changed roster confirmation handler: expected stock CitadelRosterSelectConfirm() on ConfirmButton'
}
$rosterRoot.SetAttribute('class', ($rosterRoot.GetAttribute('class') + ' KatkaRosterSelect'))
$rosterIncludes = $roster.CreateElement('scripts')
$rosterInclude = $roster.CreateElement('include')
$rosterInclude.SetAttribute('src','s2r://panorama/scripts/katka_roster.vjs')
[void]$rosterIncludes.AppendChild($rosterInclude)
[void]$roster.DocumentElement.InsertBefore($rosterIncludes,$rosterRoot)
if ($DiagnosticOnly) {
    $rosterDiagnostic = $roster.CreateElement('Label')
    $rosterDiagnostic.SetAttribute('id','KatkaRosterDiagnostics')
    $rosterDiagnostic.SetAttribute('style','horizontal-align: center; vertical-align: top; margin-top: 8px; width: 1100px; color: #fff4cb; font-size: 17px; background-color: #20221efa; padding: 8px; z-index: 999;')
    [void]$rosterRoot.AppendChild($rosterDiagnostic)
}
$rosterTransport = $roster.CreateElement('CitadelHTMLPanel')
$rosterTransport.SetAttribute('id','KatkaRosterTransport')
$rosterTransport.SetAttribute('style','width: 2px; height: 2px; opacity: 0.01; visibility: visible;')
$rosterTransport.SetAttribute('hittest','false')
$rosterTransport.SetAttribute('acceptsfocus','false')
[void]$rosterRoot.AppendChild($rosterTransport)
$popups = New-Item -ItemType Directory -Path "$stage/content/panorama/layout/popups" -Force
[IO.File]::WriteAllText((Join-Path $popups.FullName 'citadel_popup_roster_select.xml'), $roster.OuterXml, $utf8)
$js = [IO.File]::ReadAllText((Join-Path $repo 'mod/panorama/scripts/katka.js'))
$diagnosticLiteral = if ($DiagnosticOnly) { '"true"' } else { '"false"' }
$js = $js.Replace('"KATKA_DIAGNOSTIC_ONLY"',$diagnosticLiteral).Replace('"KATKA_PANEL_URL"',(ConvertTo-Json $PanelUrl.AbsoluteUri -Compress))
[IO.File]::WriteAllText((Join-Path $scripts.FullName 'katka.js'), $js, $utf8)
$rosterJs = [IO.File]::ReadAllText((Join-Path $repo 'mod/panorama/scripts/katka_roster.js')).Replace('"KATKA_DIAGNOSTIC_ONLY"',$diagnosticLiteral).Replace('"KATKA_PANEL_URL"',(ConvertTo-Json $PanelUrl.AbsoluteUri -Compress))
[IO.File]::WriteAllText((Join-Path $scripts.FullName 'katka_roster.js'), $rosterJs, $utf8)
$queueSource = Join-Path $stage 'matchmaking-status.xml'
& $Viewer -i $stock -d -f 'panorama/layout/citadel_matchmaking_status.vxml_c' -o $queueSource | Out-Null
if ($LASTEXITCODE -or !(Test-Path -LiteralPath $queueSource)) { throw 'Could not extract matchmaking status' }
$queue = New-Object xml
$queue.Load($queueSource)
$queueRoot = $queue.SelectSingleNode('/root/CitadelMatchmakingStatus')
if (!$queueRoot) { throw 'Changed matchmaking status layout' }
$queueRoot.SetAttribute('class', ($queueRoot.GetAttribute('class') + ' KatkaMatchmakingStatus'))
$queueScripts = $queue.CreateElement('scripts')
$queueInclude = $queue.CreateElement('include')
$queueInclude.SetAttribute('src','s2r://panorama/scripts/katka_queue_state.vjs')
[void]$queueScripts.AppendChild($queueInclude)
[void]$queue.DocumentElement.InsertBefore($queueScripts,$queueRoot)
$stateTransport = $queue.CreateElement('CitadelHTMLPanel')
$stateTransport.SetAttribute('id','KatkaStateReport')
$stateTransport.SetAttribute('style','width: 2px; height: 2px; opacity: 0.01; visibility: visible;')
$stateTransport.SetAttribute('hittest','false')
$stateTransport.SetAttribute('acceptsfocus','false')
[void]$queueRoot.AppendChild($stateTransport)
$stateJs = [IO.File]::ReadAllText((Join-Path $repo 'mod/panorama/scripts/katka_queue_state.js')).Replace('"KATKA_PANEL_URL"',(ConvertTo-Json $PanelUrl.AbsoluteUri -Compress))
[IO.File]::WriteAllText((Join-Path $scripts.FullName 'katka_queue_state.js'), $stateJs, $utf8)
[IO.File]::WriteAllText((Join-Path $layout.FullName 'citadel_matchmaking_status.xml'), $queue.OuterXml, $utf8)
$pak = Join-Path $package.FullName ('pak{0:D2}_dir.vpk' -f $PackageNumber)
$compiled = Join-Path $stage 'compiled.vpk'
& $Modlock panorama compile --addon katka --output $compiled "$stage/content"
if ($LASTEXITCODE) { throw 'Panorama compilation failed' }
# Modlock emits a single-file VPK v1. Its directory entries use offsets
# relative to the data section, so the section can be copied into a v2 file.
$source = [IO.File]::ReadAllBytes($compiled)
if ($source.Length -lt 12 -or [BitConverter]::ToUInt32($source,0) -ne 0x55aa1234 -or [BitConverter]::ToUInt32($source,4) -ne 1) {
    throw 'Unexpected Modlock VPK format'
}
$treeSize = [BitConverter]::ToUInt32($source,8)
$dataSize = $source.Length - 12 - $treeSize
if ($dataSize -lt 0) { throw 'Invalid VPK directory size' }
$buffer = [IO.MemoryStream]::new()
$writer = [IO.BinaryWriter]::new($buffer)
$md5 = [Security.Cryptography.MD5]::Create()
try {
    foreach ($field in @(0x55aa1234,2,$treeSize,$dataSize,0,48,0)) { $writer.Write([uint32]$field) }
    $writer.Write($source,12,$source.Length - 12)
    $writer.Write($md5.ComputeHash($source,12,$treeSize))
    $writer.Write($md5.ComputeHash([byte[]]@()))
    $writer.Write($md5.ComputeHash($buffer.ToArray()))
    [IO.File]::WriteAllBytes($pak,$buffer.ToArray())
} finally {
    $md5.Dispose()
    $writer.Dispose()
    $buffer.Dispose()
}
$verification = & $Viewer -i $pak --vpk_verify 2>&1
if ($LASTEXITCODE -or !($verification -match '^Success\.$')) { throw "VPK verification failed: $verification" }
$listing = & $Viewer -i $pak -l
foreach ($asset in 'layout/hud_escape_menu.vxml_c','layout/base_dashboard.vxml_c','layout/popups/citadel_popup_roster_select.vxml_c','layout/citadel_matchmaking_status.vxml_c','scripts/katka.vjs_c','scripts/katka_roster.vjs_c','scripts/katka_queue_state.vjs_c') {
    if (!($listing -match [regex]::Escape("panorama/$asset"))) { throw "Missing resource: $asset" }
}
Write-Output $pak
