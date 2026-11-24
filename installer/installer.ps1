param(
  [ValidateSet('install', 'music', 'uninstall', 'start')]
  [string]$Mode = 'install'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeRoot = Split-Path -Parent $ScriptDir
$PackRoot  = Split-Path -Parent $BridgeRoot

function Test-CleanAsciiPath([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return $false }
  if ($p.Contains(' ')) { return $false }
  return ($p -match '^[\x20-\x7E]+$')
}

function Get-RecommendedInstallRoot {
  $drives = [System.IO.DriveInfo]::GetDrives() | Where-Object {
    $_.DriveType -eq 'Fixed' -and $_.IsReady -and ($_.Name -notmatch '^C:\\?$')
  } | Sort-Object AvailableFreeSpace -Descending
  if ($drives -and $drives.Count -gt 0) {
    $root = $drives[0].Name.TrimEnd('\')
    return "$root\Nientum_Wallpaper_Pack"
  }
  return "D:\Nientum_Wallpaper_Pack"
}

function Find-WallpaperEngine {
  $result = [ordered]@{ Exe = $null; Config = $null }
  foreach ($procName in @('wallpaper64', 'wallpaper32')) {
    $p = Get-Process -Name $procName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) {
      try {
        $exe = $p.MainModule.FileName
        if ($exe -and (Test-Path $exe)) {
          $cfg = Join-Path (Split-Path -Parent $exe) 'config.json'
          $result.Exe = $exe
          if (Test-Path $cfg) { $result.Config = $cfg }
          return $result
        }
      } catch {}
    }
  }

  $steamRoots = New-Object System.Collections.Generic.List[string]
  foreach ($reg in @(
    @{ Path = 'HKCU:\Software\Valve\Steam'; Name = 'SteamPath' },
    @{ Path = 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam'; Name = 'InstallPath' },
    @{ Path = 'HKLM:\SOFTWARE\Valve\Steam'; Name = 'InstallPath' }
  )) {
    try {
      $val = (Get-ItemProperty -Path $reg.Path -Name $reg.Name -ErrorAction SilentlyContinue).($reg.Name)
      if ($val -and (Test-Path $val) -and -not $steamRoots.Contains($val)) { $steamRoots.Add($val) }
    } catch {}
  }

  $vdfList = New-Object System.Collections.Generic.List[string]
  foreach ($sr in $steamRoots) {
    $vdf = Join-Path $sr 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
      try {
        foreach ($line in (Get-Content $vdf -Encoding UTF8)) {
          if ($line -match '"path"\s+"([^"]+)"') {
            $lib = $Matches[1] -replace '\\\\', '\'
            if ($lib -and (Test-Path $lib) -and -not $vdfList.Contains($lib)) { $vdfList.Add($lib) }
          }
        }
      } catch {}
    }
  }
  foreach ($lib in $vdfList) { if (-not $steamRoots.Contains($lib)) { $steamRoots.Add($lib) } }

  foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
    if ($d.DriveType -ne 'Fixed' -or -not $d.IsReady) { continue }
    $dr = $d.Name.TrimEnd('\')
    foreach ($cand in @("$dr\SteamLibrary", "$dr\Steam", "$dr\Games\Steam", "$dr\Program Files (x86)\Steam", "$dr\Program Files\Steam")) {
      if ((Test-Path $cand) -and -not $steamRoots.Contains($cand)) { $steamRoots.Add($cand) }
    }
  }

  foreach ($sr in $steamRoots) {
    $weDir = Join-Path $sr 'steamapps\common\wallpaper_engine'
    if (-not (Test-Path $weDir)) { continue }
    foreach ($exeName in @('wallpaper64.exe', 'wallpaper32.exe')) {
      $exe = Join-Path $weDir $exeName
      if (Test-Path $exe) {
        $result.Exe = $exe
        $cfg = Join-Path $weDir 'config.json'
        if (Test-Path $cfg) { $result.Config = $cfg }
        return $result
      }
    }
  }
  return $result
}

function Stop-NientumProcesses {
  Get-Process -Name 'NientumBridge','NientumWheelBridge' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  try {
    $lines = netstat -ano | Select-String ':17988\s' | Select-String 'LISTENING'
    foreach ($ln in $lines) {
      $parts = ($ln.ToString().Trim() -split '\s+')
      $pidStr = $parts[-1]
      if ($pidStr -match '^\d+$') {
        Stop-Process -Id ([int]$pidStr) -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {}
  Start-Sleep -Milliseconds 300
}

function Resolve-MusicSource([string]$inputPath) {
  if ([string]::IsNullOrWhiteSpace($inputPath) -or -not (Test-Path $inputPath)) { return $null }
  $cands = @(
    $inputPath,
    (Join-Path $inputPath '音乐'),
    (Join-Path $inputPath 'media\音乐'),
    (Join-Path $inputPath 'assets\music')
  )
  foreach ($c in $cands) {
    if (-not (Test-Path $c -PathType Container)) { continue }
    $hasAct = (Test-Path (Join-Path $c 'Act0')) -or (Test-Path (Join-Path $c 'Act1'))
    $hasAudio = Get-ChildItem $c -Recurse -File -Include *.flac,*.mp3,*.wav,*.ogg,*.m4a -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hasAct -or $hasAudio) { return (Resolve-Path $c).Path }
  }
  return $null
}

function Remove-JunctionSafe([string]$linkPath) {
  if (-not (Test-Path $linkPath)) { return }
  $item = Get-Item $linkPath -Force -ErrorAction SilentlyContinue
  if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    cmd /c rmdir "`"$linkPath`"" | Out-Null
  }
}

function Attach-MusicFolder([string]$wallpaperDir, [string]$sourceMusicDir, [bool]$useCopy) {
  $target = Join-Path $wallpaperDir '音乐'
  if ((Resolve-Path $sourceMusicDir).Path.TrimEnd('\') -ieq $target.TrimEnd('\')) { return }
  if (Test-Path $target) {
    $item = Get-Item $target -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      cmd /c rmdir "`"$target`"" | Out-Null
    } elseif ($useCopy) {
      Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      $bak = "${target}_backup_" + (Get-Date -Format 'yyyyMMddHHmmss')
      Rename-Item $target $bak -Force
    }
  }
  if ($useCopy) {
    Copy-Item $sourceMusicDir $target -Recurse -Force
  } else {
    cmd /c mklink /J "`"$target`"" "`"$sourceMusicDir`"" | Out-Null
    if (-not (Test-Path $target)) {
      throw "创建目录联接失败，请改用「完整复制」模式。"
    }
  }
}

function Copy-CleanPackage([string]$srcRoot, [string]$dstRoot) {
  New-Item -ItemType Directory -Path $dstRoot -Force | Out-Null
  $srcWall = Join-Path $srcRoot 'Nientum_Wallpaper'
  $dstWall = Join-Path $dstRoot 'Nientum_Wallpaper'
  if (-not (Test-Path $srcWall)) { throw "未找到壁纸主体目录: $srcWall" }

  # 复制壁纸工程（排除音乐与开发残留）
  $null = robocopy $srcWall $dstWall /E /R:2 /W:1 /XD '音乐' 'WheelBridge' 'NeteaseBridge'
  if ($LASTEXITCODE -ge 8) { throw "复制 Nientum_Wallpaper 失败 (exit=$LASTEXITCODE)" }

  # 复制单 exe 工程（排除自动解压内核、日志、个人数据与缓存）
  $srcBr = Join-Path $srcRoot 'Nientum_Bridge'
  $dstBr = Join-Path $dstRoot 'Nientum_Bridge'
  if (-not (Test-Path $srcBr)) { throw "未找到桥接器目录: $srcBr" }
  $null = robocopy $srcBr $dstBr /E /R:2 /W:1 /XD 'runtime' '_src' 'icon-cache' 'custom-cards' 'imported-thumbs' 'imported-media' 'audio-cache' /XF 'cookie.json' 'dock-slots.json' 'imported-wallpapers.json' 'bridge.log' 'proxy.log' '_prepare.log' '_prepare_result.txt' '_selftest_result.txt'
  if ($LASTEXITCODE -ge 8) { throw "复制 Nientum_Bridge 失败 (exit=$LASTEXITCODE)" }
  if (-not (Test-Path (Join-Path $dstBr 'cookie.json'))) {
    [System.IO.File]::WriteAllText((Join-Path $dstBr 'cookie.json'), '{}', [System.Text.UTF8Encoding]::new($false))
  }

  # 复制引导脚本与说明
  foreach ($f in @('一键安装壁纸.bat', '启动壁纸与服务.bat', '接入本地音乐.bat', '卸载与清理.bat', '使用说明.txt')) {
    $sf = Join-Path $srcRoot $f
    if (Test-Path $sf) { Copy-Item $sf (Join-Path $dstRoot $f) -Force }
  }
}

function Write-BridgeConfig([string]$targetRoot, [string]$weConfigPath) {
  $wbDir = Join-Path $targetRoot 'Nientum_Bridge'
  if (-not (Test-Path $wbDir)) { return }
  $iniPath = Join-Path $wbDir 'bridge.ini'
  $cfgVal = if ($weConfigPath) { $weConfigPath } else { '' }
  $content = @(
    "; Nientum 桥接器配置（安装程序自动生成）",
    "; 留空 = 自动检测 Wallpaper Engine config.json",
    "we_config=$cfgVal",
    "; 当前壁纸路径包含此关键字时激活接管",
    "wallpaper_keyword=nientum"
  ) -join "`r`n"
  [System.IO.File]::WriteAllText($iniPath, $content, [System.Text.UTF8Encoding]::new($false))
}

function Set-SteamLaunchOption([string]$bridgeExe, [string]$cmdStr) {
  $written = 0
  $steamRoots = New-Object System.Collections.Generic.List[string]
  foreach ($reg in @(
    @{ Path = 'HKCU:\Software\Valve\Steam'; Name = 'SteamPath' },
    @{ Path = 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam'; Name = 'InstallPath' },
    @{ Path = 'HKLM:\SOFTWARE\Valve\Steam'; Name = 'InstallPath' }
  )) {
    try {
      $val = (Get-ItemProperty -Path $reg.Path -Name $reg.Name -ErrorAction SilentlyContinue).($reg.Name)
      if ($val -and (Test-Path $val) -and -not $steamRoots.Contains($val)) { $steamRoots.Add($val) }
    } catch {}
  }
  foreach ($cand in @("C:\Program Files (x86)\Steam", "C:\Program Files\Steam", "D:\Steam", "E:\Steam", "F:\Steam")) {
    if ((Test-Path $cand) -and -not $steamRoots.Contains($cand)) { $steamRoots.Add($cand) }
  }
  $vdfVal = ($cmdStr -replace '\\', '\\' -replace '"', '\"')
  $vdfFiles = New-Object System.Collections.Generic.List[string]
  foreach ($sr in $steamRoots) {
    $ud = Join-Path $sr 'userdata'
    if (-not (Test-Path $ud)) { continue }
    Get-ChildItem -Path $ud -Filter 'localconfig.vdf' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      if (-not $vdfFiles.Contains($_.FullName)) { $vdfFiles.Add($_.FullName) }
    }
  }
  foreach ($vf in $vdfFiles) {
    try {
      $lines = [System.IO.File]::ReadAllLines($vf, [System.Text.UTF8Encoding]::new($false))
      $out = New-Object System.Collections.Generic.List[string]
      $inApp = $false
      $waitingBrace = $false
      $depth = 0
      $replacedInApp = $false
      $changed = $false
      for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if (-not $inApp) {
          if ($waitingBrace) {
            if ($line -match '^\s*\{') {
              $inApp = $true
              $waitingBrace = $false
              $depth = 1
              $replacedInApp = $false
            } else {
              $waitingBrace = $false
            }
          } elseif ($line -match '^\s*"431960"\s*$') {
            $waitingBrace = $true
          }
          $out.Add($line)
          continue
        }
        if ($line -match '^\s*\{') { $depth++ }
        elseif ($line -match '^\s*\}') {
          $depth--
          if ($depth -le 0) {
            if (-not $replacedInApp) {
              $out.Add("`t`t`t`t`t`t`"LaunchOptions`"`t`t`"$vdfVal`"")
              $changed = $true
            }
            $inApp = $false
          }
        } elseif ($depth -eq 1 -and $line -match '^(\s*)"LaunchOptions"\s+"') {
          $indent = $Matches[1]
          $line = "$indent`"LaunchOptions`"`t`t`"$vdfVal`""
          $replacedInApp = $true
          $changed = $true
        }
        $out.Add($line)
      }
      if ($changed) {
        $bak = "$vf.bak_nientum"
        if (-not (Test-Path $bak)) { Copy-Item -LiteralPath $vf -Destination $bak -Force }
        [System.IO.File]::WriteAllLines($vf, $out.ToArray(), [System.Text.UTF8Encoding]::new($false))
        $written++
      }
    } catch {}
  }
  return $written
}

function Test-NientumBridgeAutostart {
  $taskEnabled = $false
  $regEnabled = $false
  try {
    $t = Get-ScheduledTask -TaskName 'NientumBridge_Autostart' -ErrorAction SilentlyContinue
    if ($t -and $t.State -ne 'Disabled') { $taskEnabled = $true }
  } catch {}
  try {
    $v = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'NientumBridge' -ErrorAction SilentlyContinue).NientumBridge
    if (-not [string]::IsNullOrWhiteSpace($v)) { $regEnabled = $true }
  } catch {}
  $mode = if ($taskEnabled) { '计划任务(0延迟)' } elseif ($regEnabled) { '注册表Run' } else { '未开启' }
  [pscustomobject]@{ Enabled = ($taskEnabled -or $regEnabled); Task = $taskEnabled; Registry = $regEnabled; Mode = $mode }
}

function Set-NientumBridgeAutostart([string]$bridgeExe, [bool]$enable) {
  $taskName = 'NientumBridge_Autostart'
  if (-not $enable) {
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    try { Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'NientumBridge' -ErrorAction SilentlyContinue } catch {}
    try { Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'NientumWheelBridge' -ErrorAction SilentlyContinue } catch {}
    return 'disabled'
  }
  try { Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'NientumWheelBridge' -ErrorAction SilentlyContinue } catch {}
  try {
    $act = New-ScheduledTaskAction -Execute $bridgeExe -Argument '--daemon' -WorkingDirectory (Split-Path -Parent $bridgeExe)
    $trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $stg = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Settings $stg -Force -ErrorAction Stop | Out-Null
    # 已通过 0 延迟登录计划任务自启时，移除 Run 项避免登录瞬间重复触发
    try { Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'NientumBridge' -ErrorAction SilentlyContinue } catch {}
    return 'task'
  } catch {
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'NientumBridge' -Value "`"$bridgeExe`" --daemon"
    return 'registry'
  }
}

function Test-WeAutostart($weInfo) {
  $svc = $null
  try { $svc = Get-Service -Name 'Wallpaper Engine Service' -ErrorAction SilentlyContinue } catch {}
  if ($svc) {
    return [pscustomobject]@{ Enabled = $true; Detail = '已开启（高优先级系统服务）' }
  }
  foreach ($rk in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')) {
    try {
      $props = Get-ItemProperty -Path $rk -ErrorAction SilentlyContinue
      if ($props) {
        foreach ($p in $props.PSObject.Properties) {
          if ($p.Name -match '^Wallpaper' -or ($p.Value -is [string] -and $p.Value -match 'wallpaper(32|64)\.exe')) {
            return [pscustomobject]@{ Enabled = $true; Detail = '已开启（系统启动项）' }
          }
        }
      }
    } catch {}
  }
  if ($weInfo -and $weInfo.Config -and (Test-Path $weInfo.Config)) {
    try {
      $raw = [System.IO.File]::ReadAllText($weInfo.Config, [System.Text.UTF8Encoding]::new($false))
      if ($raw -match '"autostart"\s*:\s*true') {
        return [pscustomobject]@{ Enabled = $true; Detail = '已开启（WE 配置）' }
      }
    } catch {}
  }
  return [pscustomobject]@{ Enabled = $false; Detail = '未开启（建议勾选以实现开机展示壁纸）' }
}

function Enable-WeAutostart($weInfo) {
  $st = Test-WeAutostart $weInfo
  if ($st.Enabled) { return $st.Detail }
  if ($weInfo -and $weInfo.Exe -and (Test-Path $weInfo.Exe)) {
    try {
      Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'WallpaperEngine' -Value "`"$($weInfo.Exe)`" -nobrowse"
      return '已写入开机自启'
    } catch {}
  }
  return '未能自动写入'
}

function Apply-WallpaperInWE($weInfo, [string]$projectJson) {
  if (-not $weInfo.Exe -or -not (Test-Path $weInfo.Exe)) { return $false }
  $running = (Get-Process -Name 'wallpaper64','wallpaper32' -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
  if (-not $running) {
    Start-Process -FilePath $weInfo.Exe -ArgumentList @('-nobrowse') | Out-Null
    for ($i = 0; $i -lt 24; $i++) {
      Start-Sleep -Milliseconds 500
      $procs = Get-Process -Name 'wallpaper64','wallpaper32' -ErrorAction SilentlyContinue
      if ($procs) {
        Start-Sleep -Milliseconds 2000
        break
      }
    }
  }
  Start-Process -FilePath $weInfo.Exe -ArgumentList @('-control', 'openWallpaper', '-file', $projectJson) | Out-Null
  if (-not $running) {
    Start-Sleep -Milliseconds 1500
    Start-Process -FilePath $weInfo.Exe -ArgumentList @('-control', 'openWallpaper', '-file', $projectJson) | Out-Null
  }
  return $true
}

function Test-NientumRuntime([string]$targetRoot) {
  $bridge = (Get-Process -Name 'NientumBridge','NientumWheelBridge' -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
  $we = (Get-Process -Name 'wallpaper64','wallpaper32' -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
  $proxy = $false
  $loggedIn = $false
  $nickname = ''
  $err = ''
  try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:17988/api/ping' -TimeoutSec 2 -ErrorAction Stop | Out-Null
    $proxy = $true
  } catch {
    $err = $_.Exception.Message
  }
  if ($proxy) {
    try {
      $r = Invoke-RestMethod -Uri 'http://127.0.0.1:17988/api/status' -TimeoutSec 4 -ErrorAction Stop
      if ($r.PSObject.Properties['loggedIn']) { $loggedIn = [bool]$r.loggedIn }
      if ($r.profile -and $r.profile.nickname) { $nickname = [string]$r.profile.nickname }
    } catch {}
  }
  [pscustomobject]@{
    Bridge = $bridge
    Proxy = $proxy
    LoggedIn = $loggedIn
    Nickname = $nickname
    WE = $we
    Error = $err
    LogPath = (Join-Path $targetRoot 'Nientum_Bridge\bridge.log')
    ProxyLogPath = (Join-Path $targetRoot 'Nientum_Bridge\proxy.log')
  }
}

function Start-NientumBridge([string]$targetRoot) {
  $bridgeExe = Join-Path $targetRoot 'Nientum_Bridge\NientumBridge.exe'
  if (-not (Test-Path $bridgeExe)) { return $false }
  try {
    # 先在安装阶段解压一次内核，之后启动不再等待解压
    $prep = Start-Process -FilePath $bridgeExe -ArgumentList @('--prepare-runtime') -WindowStyle Hidden -Wait -PassThru
    if ($prep -and $prep.ExitCode -ne 0) { return $false }
    Start-Process -FilePath $bridgeExe -ArgumentList @('--daemon', '--replace') | Out-Null
    Start-Sleep -Milliseconds 2200
    return $true
  } catch { return $false }
}

function Show-NientumStatusForm([string]$targetRoot, [bool]$applied) {
  $weInfoLocal = Find-WallpaperEngine
  $f = New-Object System.Windows.Forms.Form
  $f.Text = "Nientum 安装完成 · 运行状态自检"
  $f.Size = New-Object System.Drawing.Size(620, 430)
  $f.StartPosition = 'CenterScreen'
  $f.FormBorderStyle = 'FixedDialog'
  $f.MaximizeBox = $false
  $f.BackColor = [System.Drawing.Color]::FromArgb(248, 245, 240)
  $f.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
  $f.Controls.Add((Make-TitleBanner "安装完成 · 运行状态" "桥接器、网易云代理、Wallpaper Engine 与开机自启四项自检"))

  $lblBridge = New-Object System.Windows.Forms.Label
  $lblBridge.Location = New-Object System.Drawing.Point(24, 90)
  $lblBridge.Size = New-Object System.Drawing.Size(560, 22)
  $f.Controls.Add($lblBridge)

  $lblProxy = New-Object System.Windows.Forms.Label
  $lblProxy.Location = New-Object System.Drawing.Point(24, 118)
  $lblProxy.Size = New-Object System.Drawing.Size(560, 22)
  $f.Controls.Add($lblProxy)

  $lblWe = New-Object System.Windows.Forms.Label
  $lblWe.Location = New-Object System.Drawing.Point(24, 146)
  $lblWe.Size = New-Object System.Drawing.Size(560, 22)
  $f.Controls.Add($lblWe)

  $lblAuto = New-Object System.Windows.Forms.Label
  $lblAuto.Location = New-Object System.Drawing.Point(24, 174)
  $lblAuto.Size = New-Object System.Drawing.Size(560, 22)
  $f.Controls.Add($lblAuto)

  $lblHint = New-Object System.Windows.Forms.Label
  $lblHint.Location = New-Object System.Drawing.Point(24, 204)
  $lblHint.Size = New-Object System.Drawing.Size(560, 38)
  $lblHint.ForeColor = [System.Drawing.Color]::FromArgb(95, 86, 76)
  $lblHint.Text = if ($applied) { "壁纸已自动发送到 Wallpaper Engine；如果桌面未变化，请在 WE 中重新应用一次。" } else { "壁纸未自动应用，请到 WE 左下角「打开壁纸」选择安装目录下的 project.json。" }
  $f.Controls.Add($lblHint)

  $lblLog = New-Object System.Windows.Forms.Label
  $lblLog.Location = New-Object System.Drawing.Point(24, 248)
  $lblLog.Size = New-Object System.Drawing.Size(560, 36)
  $lblLog.ForeColor = [System.Drawing.Color]::FromArgb(120, 90, 60)
  $f.Controls.Add($lblLog)

  $btnRecheck = New-Object System.Windows.Forms.Button
  $btnRecheck.Text = "重新检测"
  $btnRecheck.Location = New-Object System.Drawing.Point(24, 314)
  $btnRecheck.Size = New-Object System.Drawing.Size(96, 34)
  $f.Controls.Add($btnRecheck)

  $btnStart = New-Object System.Windows.Forms.Button
  $btnStart.Text = "启动/重启桥接器"
  $btnStart.Location = New-Object System.Drawing.Point(128, 314)
  $btnStart.Size = New-Object System.Drawing.Size(140, 34)
  $f.Controls.Add($btnStart)

  $btnToggleAuto = New-Object System.Windows.Forms.Button
  $btnToggleAuto.Text = "切换桥接自启"
  $btnToggleAuto.Location = New-Object System.Drawing.Point(276, 314)
  $btnToggleAuto.Size = New-Object System.Drawing.Size(124, 34)
  $f.Controls.Add($btnToggleAuto)

  $btnLog = New-Object System.Windows.Forms.Button
  $btnLog.Text = "打开日志"
  $btnLog.Location = New-Object System.Drawing.Point(408, 314)
  $btnLog.Size = New-Object System.Drawing.Size(88, 34)
  $f.Controls.Add($btnLog)

  $btnClose = New-Object System.Windows.Forms.Button
  $btnClose.Text = "关闭"
  $btnClose.Location = New-Object System.Drawing.Point(504, 314)
  $btnClose.Size = New-Object System.Drawing.Size(80, 34)
  $btnClose.FlatStyle = 'Flat'
  $btnClose.BackColor = [System.Drawing.Color]::FromArgb(196, 144, 68)
  $btnClose.ForeColor = [System.Drawing.Color]::White
  $f.Controls.Add($btnClose)

  $green = [System.Drawing.Color]::FromArgb(32, 118, 62)
  $amber = [System.Drawing.Color]::FromArgb(170, 96, 20)
  $red = [System.Drawing.Color]::FromArgb(160, 50, 40)

  $update = {
    $st = Test-NientumRuntime $targetRoot
    $autoBr = Test-NientumBridgeAutostart
    $autoWe = Test-WeAutostart $weInfoLocal
    $lblBridge.Text = if ($st.Bridge) { "桥接器：运行中" } else { "桥接器：未运行（鼠标滚轮/抽屉/桌面联动会失效）" }
    $lblBridge.ForeColor = if ($st.Bridge) { $green } else { $red }
    if ($st.Proxy) {
      if ($st.LoggedIn) {
        $lblProxy.Text = "网易云代理：已启动 · 已登录" + $(if ($st.Nickname) { "（$($st.Nickname)）" } else { "" })
      } else {
        $lblProxy.Text = "网易云代理：已启动 · 未登录（需在壁纸网易云页扫码）"
      }
      $lblProxy.ForeColor = $green
    } else {
      $lblProxy.Text = "网易云代理：未启动（请打开日志查看 Nientum_Bridge\proxy.log）"
      $lblProxy.ForeColor = $red
    }
    $lblWe.Text = if ($st.WE) { "Wallpaper Engine：运行中" } else { "Wallpaper Engine：未运行" }
    $lblWe.ForeColor = if ($st.WE) { $green } else { $amber }
    $lblAuto.Text = "开机自启：桥接器 [$($autoBr.Mode)] · WE [$($autoWe.Detail)]"
    $lblAuto.ForeColor = if ($autoBr.Enabled -and $autoWe.Enabled) { $green } elseif ($autoBr.Enabled -or $autoWe.Enabled) { $amber } else { $red }
    $btnToggleAuto.Text = if ($autoBr.Enabled) { "关闭桥接自启" } else { "开启桥接自启" }
    if (Test-Path $st.LogPath) {
      $lblLog.Text = "桥接日志：" + $st.LogPath
    } elseif (Test-Path $st.ProxyLogPath) {
      $lblLog.Text = "代理日志：" + $st.ProxyLogPath
    } else {
      $lblLog.Text = "日志：尚未生成（桥接器未运行或没有写入权限）"
    }
  }
  & $update
  $btnRecheck.Add_Click({ & $update })
  $btnStart.Add_Click({
    $btnStart.Enabled = $false
    Start-NientumBridge $targetRoot | Out-Null
    Start-Sleep -Milliseconds 1500
    & $update
    $btnStart.Enabled = $true
  })
  $btnToggleAuto.Add_Click({
    $cur = Test-NientumBridgeAutostart
    $bridgeExe = Join-Path $targetRoot 'Nientum_Bridge\NientumBridge.exe'
    Set-NientumBridgeAutostart $bridgeExe (-not $cur.Enabled) | Out-Null
    & $update
  })
  $btnLog.Add_Click({
    $st = Test-NientumRuntime $targetRoot
    $path = ''
    if (-not $st.Proxy -and (Test-Path $st.ProxyLogPath)) { $path = $st.ProxyLogPath }
    elseif (Test-Path $st.LogPath) { $path = $st.LogPath }
    elseif (Test-Path $st.ProxyLogPath) { $path = $st.ProxyLogPath }
    if ($path) { Start-Process notepad.exe -ArgumentList @($path) | Out-Null }
    else { [System.Windows.Forms.MessageBox]::Show("尚未生成日志：$($st.LogPath) / $($st.ProxyLogPath)", "日志不存在", 'OK', 'Warning') | Out-Null }
  })
  $btnClose.Add_Click({ $f.Close() })
  [void]$f.ShowDialog()
}

function Make-TitleBanner([string]$titleText, [string]$subText) {
  $panel = New-Object System.Windows.Forms.Panel
  $panel.Dock = 'Top'
  $panel.Height = 74
  $panel.BackColor = [System.Drawing.Color]::FromArgb(26, 21, 17)

  $lblTitle = New-Object System.Windows.Forms.Label
  $lblTitle.Text = $titleText
  $lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(246, 224, 174)
  $lblTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 14, [System.Drawing.FontStyle]::Bold)
  $lblTitle.Location = New-Object System.Drawing.Point(20, 12)
  $lblTitle.AutoSize = $true

  $lblSub = New-Object System.Windows.Forms.Label
  $lblSub.Text = $subText
  $lblSub.ForeColor = [System.Drawing.Color]::FromArgb(210, 194, 170)
  $lblSub.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $lblSub.Location = New-Object System.Drawing.Point(22, 42)
  $lblSub.AutoSize = $true

  $panel.Controls.Add($lblTitle)
  $panel.Controls.Add($lblSub)
  return $panel
}

# ================= 快速启动模式 =================
if ($Mode -eq 'start') {
  $projectJson = Join-Path $PackRoot 'Nientum_Wallpaper\project.json'
  if (-not (Test-Path $projectJson)) {
    [System.Windows.Forms.MessageBox]::Show("未找到 Nientum_Wallpaper\project.json，请确认在安装目录运行。", "无法启动", 'OK', 'Error') | Out-Null
    exit 1
  }
  Stop-NientumProcesses
  Start-NientumBridge $PackRoot | Out-Null
  $weInfo = Find-WallpaperEngine
  $applied = $false
  if ($weInfo.Exe) {
    $applied = Apply-WallpaperInWE $weInfo $projectJson
  }
  for ($i = 0; $i -lt 20; $i++) {
    $st = Test-NientumRuntime $PackRoot
    if ($st.Bridge -and $st.Proxy) { break }
    Start-Sleep -Milliseconds 500
  }
  $stFinal = Test-NientumRuntime $PackRoot
  if ($stFinal.Bridge -and $stFinal.Proxy -and $stFinal.WE) {
    [System.Windows.Forms.MessageBox]::Show("Nientum 桥接服务、网易云代理与 Wallpaper Engine 已全部就绪！", "启动成功", 'OK', 'Information') | Out-Null
  } else {
    Show-NientumStatusForm $PackRoot $applied
  }
  exit 0
}

# ================= 卸载模式 =================
if ($Mode -eq 'uninstall') {
  $ans = [System.Windows.Forms.MessageBox]::Show(
    "将执行以下清理操作：`r`n1. 停止后台滚轮桥接器与网易云本地代理`r`n2. 移除 Windows 开机自启计划任务与注册表联动项`r`n3. 安全断开挂载的本地音乐联接（不会删除您的原始音乐文件）`r`n`r`n确认继续吗？",
    "Nientum 壁纸 - 卸载与清理",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($ans -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }

  Stop-NientumProcesses
  Set-NientumBridgeAutostart '' $false | Out-Null
  Remove-JunctionSafe (Join-Path $PackRoot 'Nientum_Wallpaper\音乐')

  [System.Windows.Forms.MessageBox]::Show(
    "清理完成！`r`n如需彻底移除文件，请在 Wallpaper Engine 中移除壁纸后，直接删除本文件夹即可。",
    "已完成清理",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
  exit 0
}

# ================= 单独接入音乐模式 =================
if ($Mode -eq 'music') {
  $wallDir = Join-Path $PackRoot 'Nientum_Wallpaper'
  if (-not (Test-Path (Join-Path $wallDir 'project.json'))) {
    [System.Windows.Forms.MessageBox]::Show("未在当前目录找到 Nientum_Wallpaper\project.json，请在壁纸安装目录运行本工具。", "未找到壁纸目录", 'OK', 'Error') | Out-Null
    exit 1
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Nientum 壁纸 - 单独接入本地音乐"
  $form.Size = New-Object System.Drawing.Size(560, 310)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.BackColor = [System.Drawing.Color]::FromArgb(248, 245, 240)
  $form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
  $form.Controls.Add((Make-TitleBanner "单独接入本地音乐曲库" "支持直接挂载现有播放器曲库或独立音乐文件夹（无需修改代码）"))

  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Text = "请选择包含歌曲的文件夹（可直接选「音乐」或独立播放器根目录）："
  $lbl.Location = New-Object System.Drawing.Point(22, 92)
  $lbl.AutoSize = $true
  $form.Controls.Add($lbl)

  $txtMusic = New-Object System.Windows.Forms.TextBox
  $txtMusic.Location = New-Object System.Drawing.Point(22, 120)
  $txtMusic.Size = New-Object System.Drawing.Size(410, 28)
  $form.Controls.Add($txtMusic)

  $btnPick = New-Object System.Windows.Forms.Button
  $btnPick.Text = "浏览..."
  $btnPick.Location = New-Object System.Drawing.Point(442, 119)
  $btnPick.Size = New-Object System.Drawing.Size(84, 30)
  $btnPick.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "选择音乐文件夹（例如 NientumPlayer_v2_UI\media\音乐）"
    if ($dlg.ShowDialog() -eq 'OK') { $txtMusic.Text = $dlg.SelectedPath }
  })
  $form.Controls.Add($btnPick)

  $rbLink = New-Object System.Windows.Forms.RadioButton
  $rbLink.Text = "快捷挂载（推荐，0 额外硬盘空间占用，不复制文件）"
  $rbLink.Location = New-Object System.Drawing.Point(24, 164)
  $rbLink.AutoSize = $true
  $rbLink.Checked = $true
  $form.Controls.Add($rbLink)

  $rbCopy = New-Object System.Windows.Forms.RadioButton
  $rbCopy.Text = "完整复制到壁纸目录（之后原文件夹可删）"
  $rbCopy.Location = New-Object System.Drawing.Point(24, 192)
  $rbCopy.AutoSize = $true
  $form.Controls.Add($rbCopy)

  $btnGo = New-Object System.Windows.Forms.Button
  $btnGo.Text = "立即接入"
  $btnGo.Location = New-Object System.Drawing.Point(330, 228)
  $btnGo.Size = New-Object System.Drawing.Size(196, 36)
  $btnGo.BackColor = [System.Drawing.Color]::FromArgb(198, 146, 72)
  $btnGo.ForeColor = [System.Drawing.Color]::White
  $btnGo.FlatStyle = 'Flat'
  $btnGo.Add_Click({
    $resolved = Resolve-MusicSource $txtMusic.Text
    if (-not $resolved) {
      [System.Windows.Forms.MessageBox]::Show("所选目录内未检测到有效的音频文件（如 Act0/Act1 或 .flac/.mp3），请重新确认文件夹位置。", "未检测到音乐", 'OK', 'Warning') | Out-Null
      return
    }
    try {
      Attach-MusicFolder $wallDir $resolved $rbCopy.Checked
      $we = Find-WallpaperEngine
      if ($we.Exe) {
        $running = (Get-Process -Name 'wallpaper64','wallpaper32' -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
        if ($running) {
          Start-Process -FilePath $we.Exe -ArgumentList @('-control', 'openWallpaper', '-file', (Join-Path $wallDir 'project.json')) | Out-Null
        }
      }
      [System.Windows.Forms.MessageBox]::Show("本地音乐接入成功！`r`n已关联目录：$resolved`r`n`r`n如壁纸正在运行，若未自动刷新请在壁纸上右键选择「重新加载壁纸」即可收听完整本地曲库。", "接入完成", 'OK', 'Information') | Out-Null
      $form.Close()
    } catch {
      [System.Windows.Forms.MessageBox]::Show("接入失败：$($_.Exception.Message)", "错误", 'OK', 'Error') | Out-Null
    }
  })
  $form.Controls.Add($btnGo)

  [void]$form.ShowDialog()
  exit 0
}

# ================= 一键图形安装模式 =================
$weInfo = Find-WallpaperEngine
$weAutoInfo = Test-WeAutostart $weInfo
$isCleanHere = Test-CleanAsciiPath $PackRoot
$packOnC = ($PackRoot -match '^[cC]:')
$defaultTarget = if ($isCleanHere -and -not $packOnC) { $PackRoot } else { Get-RecommendedInstallRoot }

$form = New-Object System.Windows.Forms.Form
$form.Text = "Nientum - CG与音乐剧场壁纸 一键安装"
$form.Size = New-Object System.Drawing.Size(620, 535)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(248, 245, 240)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
$form.Controls.Add((Make-TitleBanner "《Nientum》桌面剧场壁纸 · 一键安装并启动" "自动配置英文路径、开机极速联动、WE 导入与网易云/鼠标桥接"))

$lblQuick = New-Object System.Windows.Forms.Label
$lblQuick.Text = "默认安装到 $defaultTarget。`r`n自动配置开机 0 延迟联动并启动桥接器、网易云代理与壁纸，无需其他操作。"
$lblQuick.Location = New-Object System.Drawing.Point(22, 88)
$lblQuick.Size = New-Object System.Drawing.Size(566, 44)
$lblQuick.ForeColor = [System.Drawing.Color]::FromArgb(70, 62, 52)
$form.Controls.Add($lblQuick)

$chkAutoBridge = New-Object System.Windows.Forms.CheckBox
$chkAutoBridge.Text = "开机自动启动 Nientum 桥接服务（0 延迟登录计划任务，随 WE 自动唤醒/休眠）"
$chkAutoBridge.Location = New-Object System.Drawing.Point(24, 142)
$chkAutoBridge.Size = New-Object System.Drawing.Size(564, 24)
$chkAutoBridge.Checked = $true
$form.Controls.Add($chkAutoBridge)

$chkAutoWe = New-Object System.Windows.Forms.CheckBox
$chkAutoWe.Text = "确保 Wallpaper Engine 开机自启（当前：$($weAutoInfo.Detail)）"
$chkAutoWe.Location = New-Object System.Drawing.Point(24, 170)
$chkAutoWe.Size = New-Object System.Drawing.Size(564, 24)
$chkAutoWe.Checked = $true
$chkAutoWe.Enabled = [bool]$weInfo.Exe
$form.Controls.Add($chkAutoWe)

$lblFlow = New-Object System.Windows.Forms.Label
$lblFlow.Text = "自动流程：`r`n① 复制纯净壁纸与组件   ② 写入配置与开机极速联动   ③ 启动桥接器与网易云代理`r`n④ 稳健拉起 WE 并应用壁纸   ⑤ 四项运行状态自检"
$lblFlow.Location = New-Object System.Drawing.Point(22, 290)
$lblFlow.Size = New-Object System.Drawing.Size(566, 62)
$lblFlow.ForeColor = [System.Drawing.Color]::FromArgb(110, 94, 76)
$form.Controls.Add($lblFlow)

$y = 88

# 1. 安装路径
$lblDir = New-Object System.Windows.Forms.Label
$lblDir.Text = if ($isCleanHere -and -not $packOnC) { "1. 安装位置（当前目录为纯英文非 C 盘路径，将直接就地完成配置，无需重复复制）：" } else { "1. 安装位置（已自动选择非 C 盘的纯英文目录，避免占用系统盘）：" }
$lblDir.Location = New-Object System.Drawing.Point(22, $y)
$lblDir.AutoSize = $true
$form.Controls.Add($lblDir)
$y += 24

$txtDir = New-Object System.Windows.Forms.TextBox
$txtDir.Text = $defaultTarget
$txtDir.Location = New-Object System.Drawing.Point(22, $y)
$txtDir.Size = New-Object System.Drawing.Size(470, 28)
$form.Controls.Add($txtDir)

$btnDir = New-Object System.Windows.Forms.Button
$btnDir.Text = "浏览..."
$btnDir.Location = New-Object System.Drawing.Point(502, ($y - 1))
$btnDir.Size = New-Object System.Drawing.Size(86, 30)
$btnDir.Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = "请选择纯英文、无空格的安装目录"
  if ($dlg.ShowDialog() -eq 'OK') {
    $sel = $dlg.SelectedPath.TrimEnd('\')
    if (-not ($sel -match 'Nientum')) { $sel = Join-Path $sel 'Nientum_Wallpaper_Pack' }
    $txtDir.Text = $sel
  }
})
$form.Controls.Add($btnDir)
$y += 42

# 2. Steam 叠加联动
$lblMode = New-Object System.Windows.Forms.Label
$lblMode.Text = "2. 额外叠加：Steam 启动项联动（仅在不开启开机自启、纯靠 Steam 手动启动 WE 时需要）："
$lblMode.Location = New-Object System.Drawing.Point(22, $y)
$lblMode.AutoSize = $true
$form.Controls.Add($lblMode)
$y += 24

$chkSteamLaunch = New-Object System.Windows.Forms.CheckBox
$chkSteamLaunch.Text = "同时写入 Steam Wallpaper Engine 启动参数（不影响上方的开机自启设置）"
$chkSteamLaunch.Location = New-Object System.Drawing.Point(26, $y)
$chkSteamLaunch.AutoSize = $true
$chkSteamLaunch.Checked = $false
$form.Controls.Add($chkSteamLaunch)
$y += 32

# 3. Wallpaper Engine 检测与应用
$lblWe = New-Object System.Windows.Forms.Label
$lblWe.Text = if ($weInfo.Exe) { "3. Wallpaper Engine 状态：已检测到 ($($weInfo.Exe))" } else { "3. Wallpaper Engine 状态：暂未自动找到（安装完成后将引导手动导入 project.json）" }
$lblWe.ForeColor = if ($weInfo.Exe) { [System.Drawing.Color]::FromArgb(32, 118, 62) } else { [System.Drawing.Color]::FromArgb(170, 96, 20) }
$lblWe.Location = New-Object System.Drawing.Point(22, $y)
$lblWe.Size = New-Object System.Drawing.Size(566, 20)
$form.Controls.Add($lblWe)
$y += 24

$chkApplyWe = New-Object System.Windows.Forms.CheckBox
$chkApplyWe.Text = "安装完成后自动将《Nientum》壁纸导入并应用到 Wallpaper Engine"
$chkApplyWe.Location = New-Object System.Drawing.Point(26, $y)
$chkApplyWe.AutoSize = $true
$chkApplyWe.Checked = [bool]$weInfo.Exe
$chkApplyWe.Enabled = [bool]$weInfo.Exe
$form.Controls.Add($chkApplyWe)
$y += 34

# 4. 可选本地音乐
$lblMus = New-Object System.Windows.Forms.Label
$lblMus.Text = "4. 可选：单独接入本地音乐文件夹（留空亦可，内置网易云音乐可直接在线听歌）："
$lblMus.Location = New-Object System.Drawing.Point(22, $y)
$lblMus.AutoSize = $true
$form.Controls.Add($lblMus)
$y += 24

$txtMus = New-Object System.Windows.Forms.TextBox
$txtMus.Location = New-Object System.Drawing.Point(22, $y)
$txtMus.Size = New-Object System.Drawing.Size(470, 28)
$form.Controls.Add($txtMus)

$btnMus = New-Object System.Windows.Forms.Button
$btnMus.Text = "选择..."
$btnMus.Location = New-Object System.Drawing.Point(502, ($y - 1))
$btnMus.Size = New-Object System.Drawing.Size(86, 30)
$btnMus.Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = "选择已有音乐文件夹（或跳过，安装后再运行 接入本地音乐.bat）"
  if ($dlg.ShowDialog() -eq 'OK') { $txtMus.Text = $dlg.SelectedPath }
})
$form.Controls.Add($btnMus)
$y += 32

$chkMusCopy = New-Object System.Windows.Forms.CheckBox
$chkMusCopy.Text = "完整复制音乐文件到壁纸目录（不勾选则使用零空间占用的快捷挂载）"
$chkMusCopy.Location = New-Object System.Drawing.Point(26, $y)
$chkMusCopy.AutoSize = $true
$form.Controls.Add($chkMusCopy)
$y += 34

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = "准备就绪，点击「一键安装并启动」自动完成全部配置。"
$lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(95, 86, 76)
$lblStatus.Location = New-Object System.Drawing.Point(22, $y)
$lblStatus.Size = New-Object System.Drawing.Size(370, 36)
$form.Controls.Add($lblStatus)

$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Location = New-Object System.Drawing.Point(404, ($y - 2))
$btnInstall.Size = New-Object System.Drawing.Size(184, 40)
$btnInstall.Text = "一键安装并启动"
$btnInstall.BackColor = [System.Drawing.Color]::FromArgb(196, 144, 68)
$btnInstall.ForeColor = [System.Drawing.Color]::White
$btnInstall.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10.5, [System.Drawing.FontStyle]::Bold)
$btnInstall.FlatStyle = 'Flat'

$chkAdvanced = New-Object System.Windows.Forms.CheckBox
$chkAdvanced.Text = "高级选项（安装位置 / Steam 叠加 / 本地音乐）"
$chkAdvanced.Location = New-Object System.Drawing.Point(22, 464)
$chkAdvanced.AutoSize = $true
$form.Controls.Add($chkAdvanced)

$toggleAdv = {
  $adv = $chkAdvanced.Checked
  foreach ($c in @($lblDir, $txtDir, $btnDir, $lblMode, $chkSteamLaunch, $lblMus, $txtMus, $btnMus, $chkMusCopy)) {
    if ($c) { $c.Visible = $adv }
  }
  $lblQuick.Text = "安装到 $($txtDir.Text)。`r`n自动配置开机 0 延迟联动并启动桥接器、网易云代理与壁纸，无需其他操作。"
  $lblQuick.Visible = -not $adv
  $chkAutoBridge.Visible = -not $adv
  $chkAutoWe.Visible = -not $adv
  $lblFlow.Visible = -not $adv
}
$chkAdvanced.Add_CheckedChanged({ & $toggleAdv })
& $toggleAdv

$btnInstall.Add_Click({
  $targetRoot = $txtDir.Text.Trim().TrimEnd('\')
  if (-not (Test-CleanAsciiPath $targetRoot)) {
    [System.Windows.Forms.MessageBox]::Show("安装路径必须为纯英文且不含空格（例如 D:\Nientum_Wallpaper_Pack），否则 Wallpaper Engine 网页渲染可能异常。", "路径不符合要求", 'OK', 'Warning') | Out-Null
    return
  }

  $musicSource = $null
  if (-not [string]::IsNullOrWhiteSpace($txtMus.Text)) {
    $musicSource = Resolve-MusicSource $txtMus.Text.Trim()
    if (-not $musicSource) {
      [System.Windows.Forms.MessageBox]::Show("选择的音乐目录未检测到有效音频文件，请清空留空或重新选择包含「音乐」或 .flac/.mp3 的目录。", "音乐目录无效", 'OK', 'Warning') | Out-Null
      return
    }
  }

  $btnInstall.Enabled = $false
  try {
    $lblStatus.Text = "正在停止旧进程并准备安装目录..."
    [System.Windows.Forms.Application]::DoEvents()
    Stop-NientumProcesses

    $sameDir = ($PackRoot.TrimEnd('\') -ieq $targetRoot)
    if (-not $sameDir) {
      $lblStatus.Text = "正在部署纯净壁纸文件到 $targetRoot ..."
      [System.Windows.Forms.Application]::DoEvents()
      Copy-CleanPackage $PackRoot $targetRoot
    }

    $targetWall = Join-Path $targetRoot 'Nientum_Wallpaper'
    $projectJson = Join-Path $targetWall 'project.json'
    if (-not (Test-Path $projectJson)) { throw "安装目录缺少 $projectJson" }

    $lblStatus.Text = "正在写入桥接器配置..."
    [System.Windows.Forms.Application]::DoEvents()
    Write-BridgeConfig $targetRoot $weInfo.Config

    if ($musicSource) {
      $lblStatus.Text = "正在接入本地音乐曲库..."
      [System.Windows.Forms.Application]::DoEvents()
      Attach-MusicFolder $targetWall $musicSource $chkMusCopy.Checked
    }

    $bridgeExe = Join-Path $targetRoot 'Nientum_Bridge\NientumBridge.exe'
    $steamHint = ""
    $lblStatus.Text = "正在解压内置网易云代理内核（仅首次）..."
    [System.Windows.Forms.Application]::DoEvents()
    $prep = Start-Process -FilePath $bridgeExe -ArgumentList @('--prepare-runtime') -WindowStyle Hidden -Wait -PassThru
    if ($prep -and $prep.ExitCode -ne 0) {
      throw "内置代理内核解压失败，请查看 $targetRoot\Nientum_Bridge\_prepare.log"
    }
    $lblStatus.Text = "正在配置开机联动并启动桥接器 + 网易云代理..."
    [System.Windows.Forms.Application]::DoEvents()
    Set-NientumBridgeAutostart $bridgeExe $chkAutoBridge.Checked | Out-Null
    if ($chkAutoWe.Checked -and $weInfo.Exe) {
      Enable-WeAutostart $weInfo | Out-Null
    }
    if ($chkSteamLaunch.Checked) {
      $cmdStr = "cmd /c `"start `"`" `"$bridgeExe`" --from-we & %command%`""
      try { [System.Windows.Forms.Clipboard]::SetText($cmdStr) } catch {}
      $vdfCount = Set-SteamLaunchOption $bridgeExe $cmdStr
      if ($vdfCount -gt 0) {
        $steamHint = "【已自动写入 Steam 启动项（并已复制到剪贴板兜底）】`r`n已为本机 $vdfCount 个 Steam 配置写入 Wallpaper Engine 启动项。`r`n若当前 Steam 正在运行，请重启一次 Steam，或在 Steam 右键「Wallpaper Engine」->「属性」->「通用」检查/按 Ctrl+V 粘贴确认。"
      } else {
        $steamHint = "【Steam 启动项已复制到剪贴板】`r`n未检测到已安装的 Wallpaper Engine Steam 配置文件，请打开 Steam -> 右键「Wallpaper Engine」->「属性」->「通用」-> 在「启动选项」中按 Ctrl+V 粘贴后关闭即可。"
      }
    }
    Start-Process -FilePath $bridgeExe -ArgumentList @('--daemon', '--replace') | Out-Null

    $applied = $false
    if ($chkApplyWe.Checked -and $weInfo.Exe) {
      $lblStatus.Text = "正在向 Wallpaper Engine 应用壁纸..."
      [System.Windows.Forms.Application]::DoEvents()
      $applied = Apply-WallpaperInWE $weInfo $projectJson
    }

    $lblStatus.Text = "安装已完成，正在等待桥接器与网易云代理就绪..."
    [System.Windows.Forms.Application]::DoEvents()
    if (-not $applied) {
      try { [System.Windows.Forms.Clipboard]::SetText($projectJson) } catch {}
    }
    if ($steamHint) {
      [System.Windows.Forms.MessageBox]::Show($steamHint, "Steam 启动项", 'OK', 'Information') | Out-Null
    }

    for ($i = 0; $i -lt 24; $i++) {
      $st = Test-NientumRuntime $targetRoot
      if ($st.Bridge -and $st.Proxy) { break }
      Start-Sleep -Milliseconds 500
      [System.Windows.Forms.Application]::DoEvents()
    }

    $lblStatus.Text = "安装完成，打开运行状态自检..."
    [System.Windows.Forms.Application]::DoEvents()
    Show-NientumStatusForm $targetRoot $applied
    $form.Close()
  } catch {
    $lblStatus.Text = "安装出错，请查看提示。"
    [System.Windows.Forms.MessageBox]::Show("安装过程中发生错误：`r`n$($_.Exception.Message)", "安装失败", 'OK', 'Error') | Out-Null
    $btnInstall.Enabled = $true
  }
})
$form.Controls.Add($btnInstall)

[void]$form.ShowDialog()
