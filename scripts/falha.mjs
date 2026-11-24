// Demonstração de falhas da Pessoa 03: Node.js 22+, sem pacotes npm.
// Bots ficam conectados pelo balanceador e mandam mensagens sem parar. Quando um
// nó do cluster cai, os bots dele perdem a conexão, reconectam pelo balanceador
// e caem em outro nó. O script mostra uma linha por segundo e um resumo no fim.
const base = process.env.TARGET_URL || "http://localhost:4000";
const clients = Number(process.env.CLIENTS || 30);
const duration = Number(process.env.DURATION || 45);
const interval = Number(process.env.INTERVAL_MS || 500);
const room = process.env.ROOM_ID || "geral";
if (!Number.isInteger(clients) || clients < 1 || clients > 1000) throw Error("CLIENTS: 1..1000.");
if (!(duration >= 5 && duration <= 3600)) throw Error("DURATION: 5..3600 segundos.");
if (!(interval >= 50)) throw Error("INTERVAL_MS: pelo menos 50.");

const endpoint = new URL("/socket/websocket?vsn=2.0.0", base);
endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
const confirmed = new Set();
let unconfirmed = 0;
let duplicated = 0;
let stopping = false;
let nextRef = 1;
const debug = process.env.DEBUG ? (...a) => console.log(`[${elapsed().toFixed(1)}s]`, ...a) : () => {};

class Bot {
  constructor(index) {
    Object.assign(this, {index, ws: null, joined: false, node: null, nodes: [], received: new Set(),
      seq: 0, reconnects: 0, downSince: null, downtimes: [], pending: new Map(), joinRef: null});
    this.open();
  }
  open() {
    const ws = new WebSocket(endpoint);
    this.ws = ws;
    ws.addEventListener("open", () => {
      debug(`bot ${this.index} aberto`);
      this.joinRef = String(nextRef++);
      this.push("phx_join", {usuario: `bot-${this.index}`, chave: null}, `room:${room}`)
        .then(reply => {
          this.joined = true;
          if (this.node && this.node !== reply.no) this.nodes.push(reply.no);
          if (!this.node) this.nodes.push(reply.no);
          this.node = reply.no;
          if (this.downSince !== null) { this.downtimes.push(Date.now() - this.downSince); this.downSince = null; this.reconnects += 1; }
        })
        .catch(error => { debug(`bot ${this.index} join falhou: ${error.message}`); ws.close(); });
    });
    ws.addEventListener("message", ({data}) => this.receive(JSON.parse(data)));
    ws.addEventListener("close", () => this.lost(ws));
    // No Node.js, um handshake recusado (ex.: 502 do balanceador) dispara só
    // "error", sem "close". O navegador dispara os dois; aqui tratamos igual.
    ws.addEventListener("error", () => this.lost(ws));
  }
  lost(ws) {
    if (ws !== this.ws) return;
    debug(`bot ${this.index} desconectado`);
    this.ws = null;
    try { ws.close(); } catch {}
    this.joined = false;
    for (const {reject} of this.pending.values()) reject(Error("conexão perdida"));
    this.pending.clear();
    if (stopping) return;
    if (this.downSince === null) this.downSince = Date.now();
    // Espera curta com variação, como o cliente Phoenix do navegador.
    setTimeout(() => this.open(), 200 + Math.random() * 600);
  }
  push(event, payload, topic = `room:${room}`) {
    const ref = String(nextRef++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(ref); reject(Error("timeout")); }, 10000);
      this.pending.set(ref, {resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }});
      try { this.ws.send(JSON.stringify([topic === "phoenix" ? null : this.joinRef, ref, topic, event, payload])); }
      catch (error) { this.pending.get(ref)?.reject(error); this.pending.delete(ref); }
    });
  }
  receive([, ref, , event, payload]) {
    if (event === "phx_reply") {
      const item = this.pending.get(ref);
      if (!item) return;
      this.pending.delete(ref);
      if (payload.status === "ok") item.resolve(payload.response);
      else item.reject(Error(payload.response?.reason || "rejeitado"));
    } else if (event === "new_msg" && payload.id) {
      // A conferência usa o id que o servidor dá a cada mensagem, não o texto.
      if (this.received.has(payload.id)) duplicated += 1;
      else this.received.add(payload.id);
    }
  }
  tick() {
    if (!this.joined || stopping) return;
    const texto = `Mensagem ${++this.seq} do bot-${this.index}`;
    this.push("new_msg", {texto}).then(reply => confirmed.add(reply.id)).catch(() => { unconfirmed += 1; });
  }
}

const short = node => (node || "?").replace(/^chat@/, "");
const byNode = bots => {
  const counts = {};
  for (const bot of bots) if (bot.joined) counts[short(bot.node)] = (counts[short(bot.node)] || 0) + 1;
  return Object.entries(counts).sort().map(([n, c]) => `${n}=${c}`).join("  ") || "nenhum";
};

console.log(`Conectando ${clients} bots em ${base} (sala ${room}) por ${duration}s...`);
const bots = Array.from({length: clients}, (_, i) => new Bot(i));
const sender = setInterval(() => bots.forEach(bot => bot.tick()), interval);
const heartbeat = setInterval(() => bots.forEach(bot => bot.joined && bot.push("heartbeat", {}, "phoenix").catch(() => {})), 20000);
let startNodes = null;
const timeline = setInterval(() => {
  const online = bots.filter(b => b.joined).length;
  if (!startNodes && online === clients) startNodes = byNode(bots);
  console.log(`t=${String(Math.round(elapsed())).padStart(3)}s  conectados ${String(online).padStart(3)}/${clients}  confirmadas ${String(confirmed.size).padStart(5)}  por nó: ${byNode(bots)}`);
}, 1000);

await new Promise(resolve => setTimeout(resolve, duration * 1000));
clearInterval(sender);
// Tempo para as últimas mensagens chegarem a todos antes de medir.
await new Promise(resolve => setTimeout(resolve, 3000));
stopping = true;
clearInterval(timeline); clearInterval(heartbeat);
for (const bot of bots) bot.ws?.close();

const stable = bots.filter(b => b.reconnects === 0 && b.downSince === null);
const moved = bots.filter(b => b.reconnects > 0);
const missingStable = stable.reduce((sum, b) => sum + [...confirmed].filter(id => !b.received.has(id)).length, 0);
const downtimes = bots.flatMap(b => b.downtimes);
const notBack = bots.filter(b => b.downSince !== null).length;
const result = {
  bots: clients,
  segundos: duration,
  mensagens_confirmadas: confirmed.size,
  mensagens_sem_confirmacao: unconfirmed,
  distribuicao_inicial: startNodes,
  distribuicao_final: byNode(bots),
  bots_que_reconectaram: moved.length,
  bots_que_trocaram_de_no: bots.filter(b => b.nodes.length > 1).length,
  bots_sem_reconectar_no_fim: notBack,
  reconexao_ms_media: downtimes.length ? Math.round(downtimes.reduce((a, b) => a + b, 0) / downtimes.length) : null,
  reconexao_ms_maxima: downtimes.length ? Math.max(...downtimes) : null,
  bots_sempre_conectados: stable.length,
  entregas_faltando_para_sempre_conectados: missingStable,
  duplicadas: duplicated,
};
console.log("\nResumo:");
console.log(JSON.stringify(result, null, 2));
console.log(`\nLeitura: ${moved.length} bots perderam o nó e voltaram por outro em ~${result.reconexao_ms_media ?? 0} ms em média.`);
console.log("Quem ficou conectado recebeu tudo; quem reconectou perde o que passou durante a queda (sem histórico no servidor: o chat prioriza disponibilidade, AP no CAP).");
if (notBack || missingStable || duplicated) process.exitCode = 1;
