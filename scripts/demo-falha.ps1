# Demonstração de falha da Pessoa 03 (Windows PowerShell).
# Sobe o cluster atrás do balanceador, coloca bots conversando, derruba um nó
# no meio da conversa, religa o nó e mostra o resumo.
#
#   .\scripts\demo-falha.ps1
#   .\scripts\demo-falha.ps1 -Modo kill -Bots 100 -Segundos 60
param(
  [int]$Bots = 30,
  [int]$Segundos = 45,
  [int]$DerrubarEm = 12,
  [int]$VoltarEm = 30,
  [ValidateSet("stop", "kill")][string]$Modo = "stop"
)
[Console]::OutputEncoding = [Text.Encoding]::UTF8  # acentos dos logs do Docker
Set-Location (Join-Path $PSScriptRoot "..")
$arquivo = "compose.lb.yml"

Write-Host "== Subindo cluster + balanceador (aguarda os nós ficarem saudáveis)"
docker compose -f $arquivo up --build -d --wait
if ($LASTEXITCODE -ne 0) { throw "Falha ao subir o cluster." }

$nos = docker ps --filter "label=com.docker.compose.project=chatsd" --filter "label=com.docker.compose.service=chat" --format "{{.Names}}" | Sort-Object
if (@($nos).Count -lt 2) { throw "São necessários pelo menos 2 nós para a demonstração." }
$vitima = @($nos)[1]
Write-Host "== Nós: $($nos -join ', '). Vítima: $vitima"

docker rm -f chatsd-falha 2>$null | Out-Null
docker compose -f $arquivo run -d --quiet-pull --name chatsd-falha -e CLIENTS=$Bots -e DURATION=$Segundos falha | Out-Null
$logs = Start-Job { try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}; docker logs -f chatsd-falha }

function Esperar-Ate([int]$segundo) {
  while ($script:relogio -lt $segundo) { Receive-Job $logs; Start-Sleep 1; $script:relogio++ }
}
$script:relogio = 0

Esperar-Ate $DerrubarEm
Write-Host "`n>>> DERRUBANDO $vitima (docker $Modo) <<<`n" -ForegroundColor Red
docker $Modo $vitima | Out-Null

Esperar-Ate $VoltarEm
Write-Host "`n>>> RELIGANDO $vitima <<<`n" -ForegroundColor Green
docker start $vitima | Out-Null

$codigo = docker wait chatsd-falha
Start-Sleep 1
Receive-Job $logs -Wait
Remove-Job $logs -Force
docker rm chatsd-falha | Out-Null
Write-Host "`n== Cluster visto pelo balanceador:"
for ($i = 0; $i -lt 3; $i++) { (Invoke-WebRequest -UseBasicParsing http://localhost:4000/health).Content }
if ($codigo -ne "0") { Write-Host "Resultado com problemas (código $codigo)." -ForegroundColor Yellow; exit 1 }
Write-Host "Demonstração concluída." -ForegroundColor Green
