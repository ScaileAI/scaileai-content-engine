# Composite the real ScaileAI logo onto rendered slides.
#
#   powershell -ExecutionPolicy Bypass -File scripts/add-logo.ps1 -PostDir ig-posts/my-slug
#
# The image model is explicitly forbidden from drawing logos, so the official
# asset is placed here instead: the real file, at exact pixels, never generated.
#
# Position, size and margin come from brand.json so the look stays in one place.
# Top-left is used because the grid deliberately leaves that corner empty, which
# mirrors the slide counter top-right without crowding the handle in the footer.
#
# Runs only on slide-NN.png. Safe to run twice: originals are kept in raw/ and
# re-used, so the logo never gets stacked on top of itself.
param(
  [Parameter(Mandatory=$true)][string]$PostDir,
  [string]$SkillDir = "$env:USERPROFILE\.claude\skills\ig-carousel"
)

Add-Type -AssemblyName System.Drawing

$brandPath = Join-Path $SkillDir "brand.json"
if (-not (Test-Path $brandPath)) { Write-Error "No brand.json at $brandPath"; exit 1 }
$brand = Get-Content $brandPath -Raw | ConvertFrom-Json

if (-not $brand.logo -or -not $brand.logo.enabled) { "logo disabled in brand.json, nothing to do"; exit 0 }

$logoPath = Join-Path $SkillDir $brand.logo.asset
if (-not (Test-Path $logoPath)) {
  ""
  "LOGO NOT FOUND: $logoPath"
  "Drop a transparent-background PNG there, then run this again."
  "Slides are otherwise finished and usable; they simply have no logo on them."
  exit 0
}

$src = Resolve-Path $PostDir
$raw = Join-Path $src "raw"
if (-not (Test-Path $raw)) { New-Item -ItemType Directory -Force $raw | Out-Null }

# Height, not width: the logo is matched to the slide counter opposite it, and a
# height-based size stays correct if the lockup ever changes proportions.
$heightPct  = if ($brand.logo.heightPct)  { [double]$brand.logo.heightPct }  else { 2.2 }
$marginXPct = if ($brand.logo.marginXPct) { [double]$brand.logo.marginXPct } else { 3.0 }
$marginYPct = if ($brand.logo.marginYPct) { [double]$brand.logo.marginYPct } else { 0.9 }
$placement = if ($brand.logo.placement) { $brand.logo.placement } else { "top-left" }

$logo = [System.Drawing.Image]::FromFile($logoPath)
$count = 0

foreach ($f in Get-ChildItem $src -Filter "slide-*.png" | Sort-Object Name) {
  # Keep a pristine copy the first time, and always composite from it. That is
  # what makes re-stamping safe, and it is also a trap: if the slide has been
  # re-rendered since, compositing from raw/ silently throws the new image away.
  # Refreshing raw/ here cannot be right either, because after a normal run the
  # slide is always newer than raw. So warn loudly and let the caller decide.
  # build-week.mjs deletes raw/ after rendering, which is the supported path.
  $original = Join-Path $raw $f.Name
  if (-not (Test-Path $original)) {
    Copy-Item $f.FullName $original
  } elseif ((Get-Item $f.FullName).LastWriteTime -gt (Get-Item $original).LastWriteTime.AddMinutes(1)) {
    Write-Warning "$($f.Name) is newer than raw/$($f.Name). Compositing from raw/ and DISCARDING the newer image. If you just re-rendered, delete raw/ and run this again."
  }

  $img = [System.Drawing.Image]::FromFile($original)
  $canvas = New-Object System.Drawing.Bitmap $img.Width, $img.Height
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $img.Width, $img.Height)

  $lh = [int]($img.Height * $heightPct / 100)
  $lw = [int]($lh * $logo.Width / $logo.Height)
  $mx = [int]($img.Width  * $marginXPct / 100)
  $my = [int]($img.Height * $marginYPct / 100)

  switch ($placement) {
    "top-right"    { $x = $img.Width - $mx - $lw; $y = $my }
    "bottom-left"  { $x = $mx;                    $y = $img.Height - $my - $lh }
    "bottom-right" { $x = $img.Width - $mx - $lw; $y = $img.Height - $my - $lh }
    default        { $x = $mx;                    $y = $my }
  }

  $g.DrawImage($logo, $x, $y, $lw, $lh)
  $g.Dispose()
  $img.Dispose()

  $canvas.Save($f.FullName, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()

  "{0,-14} logo {1}x{2} at {3},{4}" -f $f.Name, $lw, $lh, $x, $y
  $count++
}

$logo.Dispose()
""
"$count slide(s) stamped. Originals kept in $raw"
