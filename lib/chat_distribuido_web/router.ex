defmodule ChatDistribuidoWeb.Router do
  use Plug.Router

  plug(:match)
  plug(:dispatch)

  get "/" do
    conn
    |> put_resp_content_type("text/html")
    |> put_resp_header("cache-control", "no-store")
    |> put_resp_header("x-content-type-options", "nosniff")
    |> put_resp_header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " <>
        "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
    )
    |> send_file(200, Application.app_dir(:chat_distribuido, "priv/static/index.html"))
  end

  get "/health" do
    cluster = ChatDistribuido.Cluster.Discovery.cluster_status()

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(
      200,
      Jason.encode!(%{
        status: "ok",
        no: ChatDistribuido.NodeInfo.nome(),
        modo: if(cluster.alive, do: "cluster", else: "local"),
        versao: "0.2.0",
        cluster: %{
          nos_conectados: cluster.connected,
          total_nos: cluster.count
        }
      })
    )
  end

  get "/metrics" do
    conn
    |> put_resp_content_type("application/json")
    |> put_resp_header("cache-control", "no-store")
    |> send_resp(200, Jason.encode!(ChatDistribuido.Metrics.cluster_metrics()))
  end

  match _ do
    send_resp(conn, 404, "Página não encontrada.")
  end
end
