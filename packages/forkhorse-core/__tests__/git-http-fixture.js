/** Offline outbound peer; global fetch stays native and no request reaches the network. */
export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== "https://git.idiot.tax") return new Response(null, { status: 503 });
    if (url.pathname === "/ok") return new Response(request.headers.get("user-agent"));
    if (url.pathname === "/redirect") {
      return new Response("fixture-provider-detail-must-not-leak", {
        status: 302,
        headers: { location: "https://redirect.idiot.tax/provider-secret-must-not-leak" },
      });
    }
    if (url.pathname === "/limit" || url.pathname === "/oversized") {
      let chunks = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (chunks++ < 8) controller.enqueue(new Uint8Array(1024 * 1024));
          else {
            if (url.pathname === "/oversized") controller.enqueue(new Uint8Array(1));
            controller.close();
          }
        },
      }));
    }
    return new Response(null, { status: 503 });
  },
};
