#!/bin/sh
# Pessoa 04: Bateria Automatizada de Benchmark — Escalonamento Horizontal & Isolamento de Tópicos
# Uso:
#   sh scripts/benchmark-escala.sh
#   ESCALAS="1 3 9" CLIENTES=90 sh scripts/benchmark-escala.sh

set -eu
cd "$(dirname "$0")/.."

ESCALAS="${ESCALAS:-1 3 6}"
CLIENTES="${CLIENTES:-90}"
SALAS_ESCALA="${SALAS_ESCALA:-3}"
MENSAGENS="${MENSAGENS:-30}"
SAIDA_JSON="${SAIDA_JSON:-docs/resultados-benchmark-p4.json}"

COMPOSE_ARGS="-f compose.lb.yml -f compose.metricas.yml"

aguardar_cluster() {
  esperado="$1"
  echo "   -> Aguardando cluster convergir para $esperado nó(s) BEAM..."
  tentativas=0
  while [ "$tentativas" -lt 30 ]; do
    atual=$(curl -fsS http://localhost:4000/metrics 2>/dev/null | node -e '
      let d = "";
      process.stdin.on("data", c => d += c);
      process.stdin.on("end", () => {
        try { console.log(JSON.parse(d).resumo_cluster.total_nos || 0); }
        catch { console.log(0); }
      });
    ' || echo 0)
    if [ "$atual" = "$esperado" ]; then
      # Aguarda o resolver DNS do Nginx (valid=2s) enxergar todas as réplicas
      sleep 3
      return 0
    fi
    tentativas=$((tentativas + 1))
    sleep 2
  done
  echo "   [Aviso] Cluster reportou $atual nó(s) (esperado: $esperado). Prosseguindo..."
}

echo "== [Pessoa 04] Construindo e subindo infraestrutura base..."
docker compose $COMPOSE_ARGS up --build -d --wait

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
IDX=0

echo ""
echo "== Bateria 1: Escalonamento Horizontal ($ESCALAS nós BEAM | $CLIENTES clientes | $SALAS_ESCALA salas)"
for N in $ESCALAS; do
  IDX=$((IDX + 1))
  echo ""
  echo "[$IDX] Escalando serviço chat para $N nó(s)..."
  docker compose $COMPOSE_ARGS up -d --scale chat="$N" --wait
  aguardar_cluster "$N"

  ROTULO="Escala ${N} nó(s)"
  ARQ="$TMP_DIR/res-$IDX.json"
  docker compose $COMPOSE_ARGS run --rm \
    -e LABEL="$ROTULO" \
    -e CLIENTS="$CLIENTES" \
    -e ROOMS="$SALAS_ESCALA" \
    -e MESSAGES="$MENSAGENS" \
    -e CONCURRENCY_ROUNDS=4 \
    benchmark > "$ARQ"

  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(`   Concluído: ${r.publicacoes.msgs_por_segundo} msg/s | ${r.broadcast_fanout.entregas_por_segundo} entregas/s | p50=${r.latencia_broadcast_ms.p50}ms p95=${r.latencia_broadcast_ms.p95}ms p99=${r.latencia_broadcast_ms.p99}ms | Jain=${r.balanceamento.indice_justica_jain}`);
  ' "$ARQ"
done

echo ""
echo "== Bateria 2: Particionamento de Tópicos PubSub (3 nós BEAM | 60 clientes: 1 sala vs 6 salas)"
docker compose $COMPOSE_ARGS up -d --scale chat=3 --wait
aguardar_cluster 3

for S in 1 6; do
  IDX=$((IDX + 1))
  ROTULO="Fan-out ${S} sala(s) (3 nós)"
  ARQ="$TMP_DIR/res-$IDX.json"
  echo ""
  echo "[$IDX] Executando 60 clientes distribuídos em $S sala(s)..."
  docker compose $COMPOSE_ARGS run --rm \
    -e LABEL="$ROTULO" \
    -e CLIENTS=60 \
    -e ROOMS="$S" \
    -e MESSAGES=25 \
    -e CONCURRENCY_ROUNDS=4 \
    benchmark > "$ARQ"

  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(`   Concluído: ${r.broadcast_fanout.entregas_recebidas} entregas (${r.broadcast_fanout.entregas_por_segundo}/s) | p50=${r.latencia_broadcast_ms.p50}ms p95=${r.latencia_broadcast_ms.p95}ms`);
  ' "$ARQ"
done

# Consolida JSON e imprime Tabela Markdown pronta para o relatório
node - "$TMP_DIR" "$SAIDA_JSON" <<'EOF'
const fs = require("fs");
const path = require("path");
const [dir, outPath] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
const results = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));

fs.writeFileSync(outPath, JSON.stringify({
  gerado_em: new Date().toISOString(),
  resultados: results
}, null, 2));

console.log("\n================================================================================");
console.log("TABELA MARKDOWN PARA O RELATÓRIO (salva também em " + outPath + ")");
console.log("================================================================================\n");
console.log("| Cenário | Nós BEAM | Clientes / Salas | Publicação (msg/s) | Throughput (entregas/s) | Latência p50 / p95 / p99 | Índice Jain | Processos / RAM Pico | Perdas / Dupl. |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  const l = r.latencia_broadcast_ms;
  const b = r.beam_cluster_pico;
  console.log(
    `| ${r.cenario} | ${r.cluster_nos} | ${r.clientes} / ${r.salas} | ` +
    `${r.publicacoes.msgs_por_segundo} | ${r.broadcast_fanout.entregas_por_segundo} | ` +
    `${l.p50} / ${l.p95} / ${l.p99} ms | ${r.balanceamento.indice_justica_jain} | ` +
    `${b.processos_ativos} / ${b.memoria_total_mb} MB | ` +
    `${r.broadcast_fanout.perdas} / ${r.broadcast_fanout.duplicadas} |`
  );
}
console.log("\nPainel ao vivo disponível em: http://localhost:4040");
console.log("Chat distribuído disponível em: http://localhost:4000");
EOF
