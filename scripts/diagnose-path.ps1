$prefix = (npm config get prefix).Trim()
Write-Host "npm prefix: $prefix"
Write-Host ""
Write-Host "=== Session PATH (npm-related) ==="
$env:Path -split ';' | Where-Object { $_ -and ($_ -match 'npm' -or $_ -eq $prefix) }
Write-Host ""
Write-Host "=== User PATH (npm-related) ==="
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$userPath -split ';' | Where-Object { $_ -and ($_ -match 'npm' -or $_ -eq $prefix) }
Write-Host ""
Write-Host "=== Machine PATH (npm-related) ==="
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$machinePath -split ';' | Where-Object { $_ -and ($_ -match 'npm' -or $_ -eq $prefix) }
Write-Host ""
Write-Host "=== Shims in prefix ==="
Get-ChildItem "$prefix\zelari-code*" -ErrorAction SilentlyContinue | Select-Object Name, FullName
Write-Host ""
Write-Host "=== where.exe zelari-code ==="
where.exe zelari-code 2>&1
Write-Host ""
Write-Host "=== Direct run ==="
& "$prefix\zelari-code.cmd" --version
