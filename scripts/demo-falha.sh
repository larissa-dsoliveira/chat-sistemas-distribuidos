#!/bin/sh
# Demonstração de falha da Pessoa 03 (Linux/macOS). Mesmo roteiro do demo-falha.ps1.
#   sh scripts/demo-falha.sh            (use sudo se o Docker exigir)
#   BOTS=100 MODO=kill sh scripts/demo-falha.sh
set -eu
cd "$(dirname "$0")/.."
BOTS="${BOTS:-30}"; SEGUNDOS="${SEGUNDOS:-45}"; DERRUBAR_EM="${DERRUBAR_EM:-12}"; VOLTAR_EM="${VOLTAR_EM:-30}"; MODO="${MODO:-stop}"
F=compose.lb.yml

echo "== Subindo cluster + balanceador (aguarda os nós ficarem saudáveis)"
docker compose -f "$F" up --build -d --wait
NOS=$(docker ps --filter label=com.docker.compose.project=chatsd --filter label=com.docker.compose.service=chat --format '{{.Names}}' | sort)
VITIMA=$(echo "$NOS" | sed -n 2p)
[ -n "$VITIMA" ] || { echo "São necessários pelo menos 2 nós."; exit 1; }
echo "== Nós: $(echo $NOS). Vítima: $VITIMA"

docker rm -f chatsd-falha >/dev/null 2>&1 || true
docker compose -f "$F" run -d --quiet-pull --name chatsd-falha -e CLIENTS="$BOTS" -e DURATION="$SEGUNDOS" falha >/dev/null
docker logs -f chatsd-falha &
LOGS=$!

sleep "$DERRUBAR_EM"
printf '\n>>> DERRUBANDO %s (docker %s) <<<\n\n' "$VITIMA" "$MODO"
docker "$MODO" "$VITIMA" >/dev/null
sleep $((VOLTAR_EM - DERRUBAR_EM))
printf '\n>>> RELIGANDO %s <<<\n\n' "$VITIMA"
docker start "$VITIMA" >/dev/null

CODIGO=$(docker wait chatsd-falha)
wait "$LOGS" || true
docker rm chatsd-falha >/dev/null
echo; echo "== Cluster visto pelo balanceador:"
for _ in 1 2 3; do curl -s http://localhost:4000/health; echo; done
[ "$CODIGO" = "0" ] || { echo "Resultado com problemas (código $CODIGO)."; exit 1; }
echo "Demonstração concluída."
