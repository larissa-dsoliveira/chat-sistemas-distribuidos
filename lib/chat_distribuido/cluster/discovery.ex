defmodule ChatDistribuido.Cluster.Discovery do
  @moduledoc """
  Gerenciador e supervisor de descoberta de nós do cluster BEAM.
  - Tenta conectar periodicamente aos nós especificados em CLUSTER_NODES ou descoberta automática.
  - Monitora quedas e reinícios de nós via :net_kernel.monitor_nodes(true).
  - Fornece diagnóstico do cluster para logs e endpoints de saúde.
  """
  use GenServer
  require Logger

  @poll_interval_ms 5_000

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def connected_nodes do
    if Node.alive?(), do: Node.list(), else: []
  end

  def cluster_status do
    %{
      alive: Node.alive?(),
      node: Node.self(),
      connected: connected_nodes(),
      count: length(connected_nodes()) + if(Node.alive?(), do: 1, else: 0)
    }
  end

  @impl true
  def init(_opts) do
    if Node.alive?() do
      :net_kernel.monitor_nodes(true)
      Logger.info("[Cluster.Discovery] Iniciado no nó #{inspect(Node.self())}. Aguardando nós...")
    else
      Logger.warning("[Cluster.Discovery] Nó BEAM não distribuído (Node.alive? == false). Operando em modo isolado.")
    end

    schedule_poll(1_000)
    {:ok, %{targets: target_nodes()}}
  end

  @impl true
  def handle_info(:poll, state) do
    if Node.alive?() do
      targets = target_nodes()
      current_connected = Node.list()

      for target <- targets, target != Node.self() and target not in current_connected do
        case Node.connect(target) do
          true ->
            Logger.info("[Cluster.Discovery] Conexão estabelecida com sucesso com #{inspect(target)}.")

          false ->
            Logger.debug("[Cluster.Discovery] Tentativa de conexão com #{inspect(target)} falhou.")

          :ignored ->
            Logger.debug("[Cluster.Discovery] Conexão com #{inspect(target)} ignorada (nó não vivo).")
        end
      end

      schedule_poll(@poll_interval_ms)
      {:noreply, %{state | targets: targets}}
    else
      schedule_poll(@poll_interval_ms)
      {:noreply, state}
    end
  end

  @impl true
  def handle_info({:nodeup, node}, state) do
    Logger.info("[Cluster.Discovery] Evento :nodeup -> Novo nó entrou no cluster: #{inspect(node)}. Total de nós: #{length(Node.list()) + 1}")
    {:noreply, state}
  end

  @impl true
  def handle_info({:nodedown, node}, state) do
    Logger.warning("[Cluster.Discovery] Evento :nodedown -> Nó saiu do cluster: #{inspect(node)}. Total restante: #{length(Node.list()) + 1}")
    {:noreply, state}
  end

  @impl true
  def handle_info(_other, state), do: {:noreply, state}

  defp schedule_poll(ms) do
    Process.send_after(self(), :poll, ms)
  end

  defp target_nodes, do: Enum.uniq(static_nodes() ++ dns_nodes())

  defp static_nodes do
    case System.get_env("CLUSTER_NODES") do
      nil -> []
      "" -> []
      nodes_str ->
        nodes_str
        |> String.split(",", trim: true)
        |> Enum.map(&String.trim/1)
        |> Enum.map(&String.to_atom/1)
    end
  end

  # Descoberta por DNS (Pessoa 03): o Docker resolve o nome do serviço para o IP
  # de cada réplica. Com nós nomeados como `chat@<ip>`, qualquer réplica nova
  # criada por `--scale` entra no cluster sem editar listas de nós.
  defp dns_nodes do
    with query when query not in [nil, ""] <- System.get_env("CLUSTER_DNS"),
         true <- Node.alive?(),
         {:ok, ips} <- :inet.getaddrs(String.to_charlist(query), :inet) do
      [basename, _host] = Node.self() |> Atom.to_string() |> String.split("@", parts: 2)
      Enum.map(ips, fn ip -> :"#{basename}@#{:inet.ntoa(ip)}" end)
    else
      _ -> []
    end
  end
end
