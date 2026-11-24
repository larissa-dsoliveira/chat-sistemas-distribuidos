# Pessoa 04: Bateria Automatizada de Benchmark (Windows PowerShell)
# Uso:
#   .\scripts\benchmark-escala.ps1
#   .\scripts\benchmark-escala.ps1 -Escalas @(1, 3, 6) -Clientes 90

param(
  [int[]]$Escalas = @(1, 3, 6),
  [int]$Clientes = 90,
  [int]$SalasEscala = 3,
  [int]$Mensagens = 30,
  [string]$SaidaJson = "docs/resultados-benchmark-p4.json"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Wait-Cluster([int]$Esperado) {
  Write-Host "   -> Aguardando cluster convergir para $Esperado no(s) BEAM..."
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $resp = Invoke-RestMethod -Uri "http://localhost:4000/metrics" -TimeoutSec 2
      if ($resp.resumo_cluster.total_nos -eq $Esperado) {
        Start-Sleep -Seconds 3
        return
      }
    } catch {}
    Start-Sleep -Seconds 2
  }
}

Write-Host "== [Pessoa 04] Subindo infraestrutura base..."
docker compose -f compose.lb.yml -f compose.metricas.yml up --build -d --wait

$Resultados = @()

Write-Host "`n== Bateria 1: Escalonamento Horizontal"
foreach ($N in $Escalas) {
  Write-Host "`nEscalando chat para $N no(s)..."
  docker compose -f compose.lb.yml -f compose.metricas.yml up -d --scale chat=$N --wait
  Wait-Cluster $N

  $Rotulo = "Escala $N no(s)"
  $Raw = docker compose -f compose.lb.yml -f compose.metricas.yml run --rm `
    -e LABEL="$Rotulo" `
    -e CLIENTS=$Clientes `
    -e ROOMS=$SalasEscala `
    -e MESSAGES=$Mensagens `
    -e CONCURRENCY_ROUNDS=4 `
    benchmark
  $Obj = $Raw | ConvertFrom-Json
  $Resultados += $Obj
  Write-Host ("   Concluido: {0} msg/s | {1} entregas/s | p50={2}ms p95={3}ms" -f `
    $Obj.publicacoes.msgs_por_segundo, $Obj.broadcast_fanout.entregas_por_segundo, `
    $Obj.latencia_broadcast_ms.p50, $Obj.latencia_broadcast_ms.p95)
}

Write-Host "`n== Bateria 2: Particionamento de Topicos PubSub (3 nos)"
docker compose -f compose.lb.yml -f compose.metricas.yml up -d --scale chat=3 --wait
Wait-Cluster 3

foreach ($S in @(1, 6)) {
  $Rotulo = "Fan-out $S sala(s) (3 nos)"
  $Raw = docker compose -f compose.lb.yml -f compose.metricas.yml run --rm `
    -e LABEL="$Rotulo" `
    -e CLIENTS=60 `
    -e ROOMS=$S `
    -e MESSAGES=25 `
    -e CONCURRENCY_ROUNDS=4 `
    benchmark
  $Obj = $Raw | ConvertFrom-Json
  $Resultados += $Obj
}

$Payload = @{
  gerado_em = (Get-Date).ToUniversalTime().ToString("o")
  resultados = $Resultados
}
$Payload | ConvertTo-Json -Depth 8 | Set-Content -Path $SaidaJson -Encoding UTF8

Write-Host "`n| Cenario | Nos BEAM | Clientes / Salas | Publicacao (msg/s) | Entregas/s | Latencia p50 / p95 / p99 | Indice Jain |"
Write-Host "|---|---|---|---|---|---|---|"
foreach ($r in $Resultados) {
  $l = $r.latencia_broadcast_ms
  Write-Host ("| {0} | {1} | {2} / {3} | {4} | {5} | {6} / {7} / {8} ms | {9} |" -f `
    $r.cenario, $r.cluster_nos, $r.clientes, $r.salas, `
    $r.publicacoes.msgs_por_segundo, $r.broadcast_fanout.entregas_por_segundo, `
    $l.p50, $l.p95, $l.p99, $r.balanceamento.indice_justica_jain)
}
Write-Host "`nPainel ao vivo em: http://localhost:4040"
