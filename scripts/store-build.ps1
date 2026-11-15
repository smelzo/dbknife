# Builds the Microsoft Store packages (x64 and arm64 .appx; AppX is built only on Windows)
# of the commit checked out in this repo.
$ErrorActionPreference = 'Stop'
# sshd keeps the PATH it was started with: read the current one
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
Set-Location (Split-Path $PSScriptRoot)

function Run([string]$exe) {
  & $exe @args
  if ($LASTEXITCODE) { throw "$exe $args exited with $LASTEXITCODE" }
}

Remove-Item -Recurse -Force dist, out -ErrorAction SilentlyContinue
Run pnpm install --frozen-lockfile
Run pnpm exec electron-vite build
# no rebuild of cpu-features (optional for ssh2): the VM has no Visual Studio Build Tools
Run pnpm exec electron-builder --win appx --x64 --arm64 --config.npmRebuild=false
