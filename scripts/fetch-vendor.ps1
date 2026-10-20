# Copia yt-dlp, FFmpeg/ffprobe e Deno instalados pelo winget para a pasta vendor\,
# que vai embutida no instalador. Rode antes de "npm run dist" quando quiser
# atualizar as versões incluídas:
#   winget upgrade yt-dlp.yt-dlp ; winget upgrade yt-dlp.FFmpeg ; winget upgrade DenoLand.Deno
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-vendor.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor'
$pkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'

function Find-One($pattern, $file) {
  $dir = Get-ChildItem $pkgs -Directory | Where-Object Name -like $pattern | Select-Object -First 1
  if (-not $dir) { throw "Pacote winget '$pattern' não encontrado. Instale com winget primeiro." }
  $hit = Get-ChildItem $dir.FullName -Recurse -File -Filter $file | Select-Object -First 1
  if (-not $hit) { throw "$file não encontrado em $($dir.FullName)" }
  return $hit
}

New-Item -ItemType Directory -Force (Join-Path $vendor 'ffmpeg') | Out-Null

$ytdlp = Find-One 'yt-dlp.yt-dlp_*' 'yt-dlp.exe'
$ffmpeg = Find-One 'yt-dlp.FFmpeg_*' 'ffmpeg.exe'
$ffprobe = Find-One 'yt-dlp.FFmpeg_*' 'ffprobe.exe'
$ffLicense = Join-Path (Split-Path -Parent $ffmpeg.DirectoryName) 'LICENSE.txt'
$deno = Find-One 'DenoLand.Deno_*' 'deno.exe'

Copy-Item $ytdlp.FullName (Join-Path $vendor 'yt-dlp.exe') -Force
Copy-Item $ffmpeg.FullName (Join-Path $vendor 'ffmpeg\ffmpeg.exe') -Force
Copy-Item $ffprobe.FullName (Join-Path $vendor 'ffmpeg\ffprobe.exe') -Force
if (Test-Path $ffLicense) { Copy-Item $ffLicense (Join-Path $vendor 'ffmpeg\LICENSE.txt') -Force }
Copy-Item $deno.FullName (Join-Path $vendor 'deno.exe') -Force

$ver = @{
  'yt-dlp' = (& (Join-Path $vendor 'yt-dlp.exe') --version).Trim()
  'ffmpeg' = ((& (Join-Path $vendor 'ffmpeg\ffmpeg.exe') -version) | Select-Object -First 1).Trim()
  'deno'   = ((& (Join-Path $vendor 'deno.exe') --version) | Select-Object -First 1).Trim()
}
$ver | ConvertTo-Json | Set-Content (Join-Path $vendor 'versions.json') -Encoding UTF8
$ver.GetEnumerator() | ForEach-Object { "{0}: {1}" -f $_.Key, $_.Value }
"vendor: $([math]::Round(((Get-ChildItem $vendor -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)) MB"
