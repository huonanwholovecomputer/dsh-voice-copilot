Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Start-Sleep -Seconds 3
$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys('^%j')
Start-Sleep -Milliseconds 900

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

$w = 1000
$h = 760
$rect = New-Object System.Drawing.Rectangle ($bounds.Width - $w), ($bounds.Height - $h), $w, $h
$crop = $bmp.Clone($rect, $bmp.PixelFormat)
$out = Join-Path $env:TEMP "_voice_shot.png"
$crop.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$crop.Dispose()
Write-Output ("saved " + $out + " " + $crop.Width + "x" + $crop.Height)

Start-Sleep -Milliseconds 300
$ws.SendKeys('{ESC}')
