$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$tools = Join-Path $PWD ".stackup\solvers"
New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Ensure-Repo($name, $url) {
  $path = Join-Path $tools $name
  if (!(Test-Path $path)) { git clone --depth 1 $url $path }
  else { git -C $path pull --ff-only }
  return $path
}

Write-Host "STACKUP SOLVER BOOTSTRAP"
rustc --version
cargo --version
git --version

$dcfr = Ensure-Repo "DCFR-SOLVER" "https://github.com/exinori/DCFR-SOLVER.git"
cargo build --release --manifest-path (Join-Path $dcfr "Cargo.toml")
$env:STACKUP_DCFR_BIN = Join-Path $dcfr "target\release\dcfr-solver.exe"

$gtopen = Ensure-Repo "GTOpen" "https://github.com/MatthewPDingle/GTOpen.git"
cargo build --release -p server --manifest-path (Join-Path $gtopen "Cargo.toml")

Write-Host ""
Write-Host "DCFR: $env:STACKUP_DCFR_BIN"
Write-Host "GTOpen: $gtopen"
Write-Host "Bootstrap concluido. TexasSolver e demais adapters permanecem bloqueados ate o binario/API ser configurado."
