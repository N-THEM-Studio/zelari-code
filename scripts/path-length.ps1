$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
$merged = "$machine;$user"
Write-Host "Machine PATH length: $($machine.Length)"
Write-Host "User PATH length: $($user.Length)"
Write-Host "Merged PATH length: $($merged.Length)"
Write-Host "Session PATH length: $($env:Path.Length)"
Write-Host ""
Write-Host "Session has Z:\npm-global: $($env:Path -like '*Z:\npm-global*')"
Write-Host ""
# Count entries in session vs expected
$sessionEntries = ($env:Path -split ';' | Where-Object { $_ }).Count
$mergedEntries = ($merged -split ';' | Where-Object { $_ }).Count
Write-Host "Session entries: $sessionEntries"
Write-Host "Merged entries: $mergedEntries"
