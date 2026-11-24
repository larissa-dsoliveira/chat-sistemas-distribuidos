// Pessoa 04: Benchmark Científico de Carga, Latência (p50/p95/p99), Fan-out e Escalonamento BEAM
// Node.js 22+, sem dependências externas.
//
// Variáveis de ambiente:
//   TARGET_URL          (padrão: http://localhost:4000)
//   CLIENTS             (padrão: 60, intervalo: 1..1000)
//   ROOMS               (padrão: 1, intervalo: 1..50)
//   MESSAGES            (padrão: 25, intervalo: 1..10000)
//   CONCURRENCY_ROUNDS  (padrão: 3, rodadas simultâneas por cliente: 1..25)
//   LABEL               (rótulo opcional do cenário)
//   FORMAT              (json | resumo, padrão: json)

const base = (process.env.TARGET_URL || "http://localhost:4000").replace(/\/+$/, "");
const clientsCount = Number(process.env.CLIENTS || 60);
const roomsCount = Number(process.env.ROOMS || 1);
const roundsCount = Number(process.env.MESSAGES || 25);
const windowRounds = Number(process.env.CONCURRENCY_ROUNDS || 3);
const scenarioLabel = process.env.LABEL || `${clientsCount}c-${roomsCount}s-${roundsCount}m`;
const outputFormat = process.env.FORMAT || "json";

if (!Number.isInteger(clientsCount) || clientsCount < 1 || clientsCount > 1000) {
  throw new Error("CLIENTS deve ser inteiro entre 1 e 1000.");
}
if (!Number.isInteger(roomsCount) || roomsCount < 1 || roomsCount > 50) {
  throw new Error("ROOMS deve ser inteiro entre 1 e 50.");
}
if (!Number.isInteger(roundsCount) || roundsCount < 1 || roundsCount > 10000) {
  throw new Error("MESSAGES deve ser inteiro entre 1 e 10000.");
}

const wsEndpoint = new URL("/socket/websocket?vsn=2.0.0", base);
wsEndpoint.protocol = wsEndpoint.protocol === "https:" ? "wss:" : "ws:";

const runTag = `bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let nextRef = 1;

const RESERVOIR_MAX = 40000;
const broadcastLatencies = [];
let broadcastSeen = 0;
const ackLatencies = [];

function addBroadcastLatency(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  broadcastSeen += 1;
  if (broadcastLatencies.length < RESERVOIR_MAX) {
    broadcastLatencies.push(ms);
  } else {
    const idx = Math.floor(Math.random() * broadcastSeen);
    if (idx < RESERVOIR_MAX) broadcastLatencies[idx] = ms;
  }
}

function percentiles(arr) {
  if (!arr.length) return { media: 0, p50: 0, p95: 0, p99: 0, max: 0, amostras: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pick = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return {
    media: Number((sum / n).toFixed(2)),
    p50: Number(pick(0.5).toFixed(2)),
    p95: Number(pick(0.95).toFixed(2)),
    p99: Number(pick(0.99).toFixed(2)),
    max: Number(sorted[n - 1].toFixed(2)),
    amostras: n
  };
}

function jainsFairness(counts) {
  const vals = Object.values(counts);
  if (vals.length <= 1) return 1.0;
  const sum = vals.reduce((a, b) => a + b, 0);
  const sumSq = vals.reduce((a, b) => a + b * b, 0);
  if (sumSq === 0) return 1.0;
  return Number(((sum * sum) / (vals.length * sumSq)).toFixed(4));
}

async function fetchMetricsSnapshot() {
  try {
    const res = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function prepareRooms(count) {
  if (count === 1) return [{ id: "geral", nome: "Geral" }];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsEndpoint);
    const pending = new Map();
    const joinRef = String(nextRef++);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Timeout criando salas de benchmark."));
    }, 12000);

    function call(event, payload) {
      const ref = String(nextRef++);
      return new Promise((res, rej) => {
        pending.set(ref, { res, rej });
        ws.send(JSON.stringify([joinRef, ref, "catalog:rooms", event, payload]));
      });
    }

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Erro de conexão no catálogo."));
    });

    ws.addEventListener("message", ({ data }) => {
      const [, ref, , event, payload] = JSON.parse(data);
      if (event === "phx_reply" && pending.has(ref)) {
        const { res, rej } = pending.get(ref);
        pending.delete(ref);
        if (payload.status === "ok") res(payload.response);
        else rej(new Error(payload.response?.reason || "Falha no catálogo"));
      }
    });

    ws.addEventListener("open", async () => {
      try {
        const joinReply = await call("phx_join", { usuario: "bench-coord" });
        const byName = new Map((joinReply.salas || []).map((s) => [s.nome, s]));
        const rooms = [{ id: "geral", nome: "Geral" }];
        for (let i = 2; i <= count; i++) {
          const name = `Bench Sala ${i}`;
          if (byName.has(name)) {
            const s = byName.get(name);
            rooms.push({ id: s.id, nome: s.nome });
          } else {
            const created = await call("create_room", { nome: name, tipo: "publica" });
            rooms.push({ id: created.sala.id, nome: created.sala.nome });
          }
        }
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(rooms);
      } catch (err) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(err);
      }
    });
  });
}

function waitFor(predicate, timeoutMs = 45000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (predicate()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("Tempo esgotado aguardando todas as entregas de broadcast."));
      }
    }, 25);
  });
}

const sockets = [];
const pendingMap = new Map();
let heartbeatTimer = null;
let midSamplerTimer = null;

function pushFrame(ws, clientIdx, event, payload, topic, joinRef) {
  return new Promise((resolve, reject) => {
    const ref = String(nextRef++);
    const key = `${clientIdx}:${ref}`;
    const timer = setTimeout(() => {
      pendingMap.delete(key);
      reject(new Error(`Timeout cliente ${clientIdx} em ${event}`));
    }, 20000);
    pendingMap.set(key, { resolve, reject, timer });
    ws.send(JSON.stringify([joinRef, ref, topic, event, payload]));
  });
}

const tTotalStart = performance.now();
let duplicated = 0;
let totalReceived = 0;
let peakProcesses = 0;
let peakMemoryMb = 0;
let peakRunQueue = 0;

try {
  const beforeSnap = await fetchMetricsSnapshot();
  if (beforeSnap?.resumo_cluster) {
    peakProcesses = beforeSnap.resumo_cluster.processos_cluster;
    peakMemoryMb = beforeSnap.resumo_cluster.memoria_cluster_mb;
  }

  const rooms = await prepareRooms(roomsCount);

  // Aloca clientes nas salas de forma equilibrada
  const roomBuckets = new Map(rooms.map((r) => [r.id, 0]));
  const clientAssignments = Array.from({ length: clientsCount }, (_, i) => {
    const room = rooms[i % rooms.length];
    roomBuckets.set(room.id, roomBuckets.get(room.id) + 1);
    return room;
  });

  // Cada cliente na sala R receberá (membros_em_R * roundsCount) mensagens desta bateria
  const expectedPerClient = clientAssignments.map((r) => roomBuckets.get(r.id) * roundsCount);
  const expectedTotalDeliveries = expectedPerClient.reduce((a, b) => a + b, 0);
  const totalPublished = clientsCount * roundsCount;

  const clientDeliveries = Array.from({ length: clientsCount }, () => new Set());
  const clientNodes = new Array(clientsCount).fill("desconhecido");
  const clientJoinRefs = new Array(clientsCount).fill("1");

  const tConnectStart = performance.now();

  // Conecta em lotes de 30 para evitar estouro de SYN/handshake simultâneo em cargas grandes
  const batchSize = 30;
  for (let offset = 0; offset < clientsCount; offset += batchSize) {
    const sliceEnd = Math.min(clientsCount, offset + batchSize);
    await Promise.all(
      Array.from({ length: sliceEnd - offset }, (_, k) => {
        const idx = offset + k;
        const room = clientAssignments[idx];
        const joinRef = String(nextRef++);
        clientJoinRefs[idx] = joinRef;

        return new Promise((resolve, reject) => {
          const ws = new WebSocket(wsEndpoint);
          sockets[idx] = ws;

          ws.addEventListener("error", () => reject(new Error(`Falha WebSocket no cliente ${idx}`)));
          ws.addEventListener("message", ({ data }) => {
            const [, ref, , event, payload] = JSON.parse(data);
            if (event === "phx_reply") {
              const key = `${idx}:${ref}`;
              const item = pendingMap.get(key);
              if (item) {
                clearTimeout(item.timer);
                pendingMap.delete(key);
                if (payload.status === "ok") item.resolve(payload.response);
                else item.reject(new Error(payload.response?.reason || "Rejeitado"));
              }
            } else if (event === "new_msg" && typeof payload.texto === "string" && payload.texto.startsWith(`[${runTag}:`)) {
              const seen = clientDeliveries[idx];
              if (seen.has(payload.id)) {
                duplicated += 1;
              } else {
                seen.add(payload.id);
                totalReceived += 1;
                const endIdx = payload.texto.indexOf("]");
                if (endIdx > 0) {
                  const sentTs = Number(payload.texto.slice(runTag.length + 2, endIdx));
                  if (Number.isFinite(sentTs)) {
                    addBroadcastLatency(performance.now() - sentTs);
                  }
                }
              }
            }
          });

          ws.addEventListener("open", async () => {
            try {
              const reply = await pushFrame(
                ws,
                idx,
                "phx_join",
                { usuario: `bench-${idx}`, chave: null },
                `room:${room.id}`,
                joinRef
              );
              clientNodes[idx] = reply.no || "desconhecido";
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        });
      })
    );
  }

  const connectMs = Number((performance.now() - tConnectStart).toFixed(1));

  heartbeatTimer = setInterval(() => {
    sockets.forEach((ws, idx) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        pushFrame(ws, idx, "heartbeat", {}, "phoenix", null).catch(() => {});
      }
    });
  }, 20000);

  midSamplerTimer = setInterval(async () => {
    const snap = await fetchMetricsSnapshot();
    if (snap?.resumo_cluster) {
      peakProcesses = Math.max(peakProcesses, snap.resumo_cluster.processos_cluster);
      peakMemoryMb = Math.max(peakMemoryMb, snap.resumo_cluster.memoria_cluster_mb);
      peakRunQueue = Math.max(peakRunQueue, snap.resumo_cluster.run_queue_cluster);
    }
  }, 400);

  const nodeCounts = {};
  for (const n of clientNodes) {
    nodeCounts[n] = (nodeCounts[n] || 0) + 1;
  }

  // Disparo com janela deslizante (CONCURRENCY_ROUNDS em voo por cliente)
  const tSendStart = performance.now();

  await Promise.all(
    sockets.map(async (ws, idx) => {
      const room = clientAssignments[idx];
      const joinRef = clientJoinRefs[idx];
      let nextRound = 0;

      async function worker() {
        while (nextRound < roundsCount) {
          const r = nextRound++;
          const t0 = performance.now();
          const texto = `[${runTag}:${t0.toFixed(2)}] msg ${r + 1}/${roundsCount} de bench-${idx}`;
          await pushFrame(ws, idx, "new_msg", { texto }, `room:${room.id}`, joinRef);
          ackLatencies.push(performance.now() - t0);
        }
      }

      const workers = Math.min(windowRounds, roundsCount);
      await Promise.all(Array.from({ length: workers }, () => worker()));
    })
  );

  await waitFor(() => clientDeliveries.every((set, idx) => set.size >= expectedPerClient[idx]));

  const sendDurationSec = (performance.now() - tSendStart) / 1000;
  const afterSnap = await fetchMetricsSnapshot();
  if (afterSnap?.resumo_cluster) {
    peakProcesses = Math.max(peakProcesses, afterSnap.resumo_cluster.processos_cluster);
    peakMemoryMb = Math.max(peakMemoryMb, afterSnap.resumo_cluster.memoria_cluster_mb);
    peakRunQueue = Math.max(peakRunQueue, afterSnap.resumo_cluster.run_queue_cluster);
  }

  const bcastStats = percentiles(broadcastLatencies);
  const ackStats = percentiles(ackLatencies);
  const clusterNodesCount = afterSnap?.resumo_cluster?.total_nos ?? Object.keys(nodeCounts).length;

  const result = {
    cenario: scenarioLabel,
    cluster_nos: clusterNodesCount,
    clientes: clientsCount,
    salas: roomsCount,
    mensagens_por_cliente: roundsCount,
    rodadas_em_voo: windowRounds,
    tempo_conexao_ms: connectMs,
    duracao_envio_segundos: Number(sendDurationSec.toFixed(3)),
    tempo_total_segundos: Number(((performance.now() - tTotalStart) / 1000).toFixed(3)),
    publicacoes: {
      total: totalPublished,
      msgs_por_segundo: Math.round(totalPublished / sendDurationSec)
    },
    broadcast_fanout: {
      entregas_esperadas: expectedTotalDeliveries,
      entregas_recebidas: totalReceived,
      duplicadas: duplicated,
      perdas: expectedTotalDeliveries - totalReceived,
      entregas_por_segundo: Math.round(totalReceived / sendDurationSec)
    },
    latencia_broadcast_ms: bcastStats,
    latencia_ack_ms: ackStats,
    balanceamento: {
      por_no: nodeCounts,
      indice_justica_jain: jainsFairness(nodeCounts)
    },
    beam_cluster_pico: {
      processos_ativos: peakProcesses,
      memoria_total_mb: Number(peakMemoryMb.toFixed(2)),
      run_queue_max: peakRunQueue,
      schedulers_totais: afterSnap?.resumo_cluster?.schedulers_cluster ?? null
    }
  };

  if (outputFormat === "resumo") {
    console.log(
      `| ${result.cenario} | ${result.cluster_nos} | ${result.clientes} | ${result.salas} | ` +
      `${result.publicacoes.msgs_por_segundo} msg/s | ${result.broadcast_fanout.entregas_por_segundo} ent/s | ` +
      `${bcastStats.p50} / ${bcastStats.p95} / ${bcastStats.p99} ms | ${result.balanceamento.indice_justica_jain} | ` +
      `${result.beam_cluster_pico.processos_ativos} procs (${result.beam_cluster_pico.memoria_total_mb} MB) |`
    );
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  if (duplicated > 0 || totalReceived !== expectedTotalDeliveries) {
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`[Benchmark P4] Falha: ${err.message}`);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeatTimer);
  clearInterval(midSamplerTimer);
  for (const { timer } of pendingMap.values()) clearTimeout(timer);
  for (const ws of sockets) {
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try { ws.close(); } catch {}
    }
  }
}
