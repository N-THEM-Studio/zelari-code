$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Write-Host "User PATH length: $($userPath.Length)"
Write-Host "Contains Z:\npm-global: $($userPath -like '*Z:\npm-global*')"
Write-Host ""
Write-Host "=== All User PATH entries ==="
$i = 0
$userPath -split ';' | ForEach-Object {
  if ($_) { Write-Host ("{0,3}: [{1}]" -f $i++, $_) }
}
Write-Host ""
Write-Host "=== Fresh merged PATH simulation ==="
$merged = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + $userPath
$merged -split ';' | Where-Object { $_ -match 'npm' -or $_ -eq 'Z:\npm-global' }
