# Convert rendered carousel PNGs to JPEG for the Instagram API.
# JPEG is the only format the Content Publishing API accepts.
#
#   powershell -File scripts/to-jpeg.ps1 -PostDir ig-posts/voice-agents-for-contractors
#
param(
  [Parameter(Mandatory=$true)][string]$PostDir,
  [int]$Quality = 92
)

Add-Type -AssemblyName System.Drawing

$src = Resolve-Path $PostDir
$out = Join-Path $src "jpeg"
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Force $out | Out-Null }

$codec  = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

$MAX_BYTES = 8MB
$count = 0

foreach ($f in Get-ChildItem $src -Filter *.png | Sort-Object Name) {
  $img    = [System.Drawing.Image]::FromFile($f.FullName)
  $target = Join-Path $out ($f.BaseName + ".jpg")
  $img.Save($target, $codec, $params)
  $w = $img.Width; $h = $img.Height
  $img.Dispose()

  $bytes = (Get-Item $target).Length
  $ratio = [math]::Round($w / $h, 3)

  # The API rejects anything over 8MB, and feed posts must sit between 4:5 and 1.91:1.
  $warn = @()
  if ($bytes -gt $MAX_BYTES) { $warn += "OVER 8MB" }
  if ($ratio -lt 0.8 -or $ratio -gt 1.91) { $warn += "ASPECT $ratio OUT OF RANGE" }

  $note = if ($warn.Count) { "  <-- " + ($warn -join ", ") } else { "" }
  "{0,-16} {1}x{2}  {3,5} KB{4}" -f ($f.BaseName + ".jpg"), $w, $h, [math]::Round($bytes/1KB), $note
  $count++
}

""
"$count file(s) written to $out"
