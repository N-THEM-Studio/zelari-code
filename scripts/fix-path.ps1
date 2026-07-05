# Ensures npm global prefix is on the user PATH and reloads PATH in this session.
$prefix = (npm config get prefix).Trim()
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')

if ($userPath -notlike "*$prefix*") {
  $updated = if ($userPath) { "$userPath;$prefix" } else { $prefix }
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
  Write-Host "PATH aggiornato (registry): aggiunto $prefix"
} else {
  Write-Host "PATH registry gia contiene: $prefix"
}

# Reload full PATH from registry into this session (fixes stale terminals).
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$freshUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machinePath;$freshUserPath"

Write-Host ""
Write-Host "Verifica:"
where.exe zelari-code 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Error "zelari-code non trovato. Esegui: npm link (dalla root del repo)"
  exit 1
}

zelari-code --version
